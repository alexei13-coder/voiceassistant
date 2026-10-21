"""«Мозг» целиком: статус, ключ, лимит расходов, ход ответа и что из этого видит UI.

Статусы (docs/brain.md, «Режимы»): ready, no_key, invalid_key, offline, limit, demo. Ход
запускается через KillSwitch — «Стоп» отменяет его вместе со стримом. В журнал пишутся
только метаданные ответа (модель, токены, стоимость, длительность), но не тексты реплик.
"""

from __future__ import annotations

import asyncio
import logging
import random
from collections.abc import Callable
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Any

import anthropic

from ..bus import EventBus
from ..config import AssistantSettings, LlmSettings
from ..demo_audio import TTS_PROFILE, SpeechEnvelope
from ..killswitch import KillSwitch
from ..protocol import (
    BrainInfo,
    BrainStatus,
    BrainStatusMessage,
    HelloUsage,
    MemoryFact,
    MemoryMessage,
    ServerMessage,
    UsageMessage,
)
from ..session import Session
from ..state import AssistantState, StateMachine
from . import errors
from .client import ClientFactory, KeyStore
from .conversation import Conversation, Outcome, ResponseInfo
from .errors import Failure
from .memory import ADDRESS_FORM, MemoryStore
from .prompts import build_context
from .reply import TRUNCATED_SUFFIX, ReplyView, enter
from .request import RequestBuilder
from .tools import ToolRegistry, memory_tools
from .usage import ZERO, UsageTracker, add, rounded

log = logging.getLogger(__name__)

S = AssistantState

STEP_LIMIT_TEXT = "Не уложился в отведённое число шагов и остановился. Попробуйте разбить просьбу на части."


@dataclass(frozen=True, slots=True)
class BrainTimings:
    executing_min: float = 0.3  # сколько минимум видно «ВЫПОЛНЯЮ» при вызове своего инструмента
    error_flash: float = 1.2  # сколько держится состояние error после неудачи


def local_now() -> datetime:
    return datetime.now().astimezone()


class Brain:
    def __init__(
        self,
        *,
        llm: LlmSettings,
        assistant: AssistantSettings,
        session: Session,
        state_machine: StateMachine,
        killswitch: KillSwitch,
        bus: EventBus[ServerMessage],
        memory: MemoryStore,
        usage: UsageTracker,
        keys: KeyStore,
        client_factory: ClientFactory,
        env_file: Path,
        limit_loader: Callable[[], float],
        demo: bool,
        timings: BrainTimings | None = None,
        clock: Callable[[], datetime] = local_now,
        rng: random.Random | None = None,
    ) -> None:
        self._llm = llm
        self._assistant = assistant
        self._session = session
        self._sm = state_machine
        self._ks = killswitch
        self._bus = bus
        self._memory = memory
        self._usage = usage
        self._keys = keys
        self._client_factory = client_factory
        self._env_file = env_file
        self._limit_loader = limit_loader
        self._timings = timings or BrainTimings()
        self._clock = clock
        # Не для криптографии: только форма синтетической огибающей голоса.
        self._envelope = SpeechEnvelope(rng or random.Random(), TTS_PROFILE)  # noqa: S311
        registry = ToolRegistry(memory_tools(memory), session=session)
        self._conversation = Conversation(
            requests=RequestBuilder(llm, registry.definitions()),
            tools=registry,
            on_response=self._on_response,
        )
        self._client: anthropic.AsyncAnthropic | None = None
        self._closing: set[asyncio.Task[None]] = set()
        self._turn_usage = ZERO
        self._status, self._message = ("demo", None) if demo else self._current_status()
        memory.add_listener(self._on_memory)

    # ---------- снимок для hello ----------

    @property
    def status(self) -> BrainStatus:
        return self._status

    def info(self) -> BrainInfo:
        return BrainInfo(
            status=self._status, model=self._llm.model, web_search=self._llm.web_search, message=self._message
        )

    def hello_usage(self) -> HelloUsage:
        return HelloUsage(
            session=rounded(self._usage.session),
            month=rounded(self._usage.month),
            monthly_limit_usd=self._usage.monthly_limit_usd,
        )

    def address_form(self) -> str:
        """Обращение: выбранное пользователем (память) важнее настройки."""
        return self._memory.get(ADDRESS_FORM) or self._assistant.address_form

    @property
    def history(self) -> list[dict[str, Any]]:
        return self._conversation.history

    # ---------- демо ----------

    def key_appeared(self) -> bool:
        """Демо идёт, потому что нет ключа: перечитать .env. True — ключ появился."""
        self._keys.reload()
        return self._keys.key is not None

    def leave_demo(self) -> None:
        self._drop_client()
        self._settle_status()

    async def aclose(self) -> None:
        """Завершение ядра: закрыть соединения клиента API."""
        self._drop_client()
        if self._closing:
            await asyncio.wait(self._closing, timeout=0.5)

    # ---------- команды ----------

    def send_text(self, text: str) -> asyncio.Task[None]:
        """Новая реплика вытесняет текущий ход, как и на этапе 1."""
        previous = self._ks.cancel_turn("cancelled")
        return self._ks.spawn(self._turn(text, previous), name="brain-turn")

    async def new_session(self) -> None:
        cancelled = self._ks.cancel_turn("cancelled")
        if cancelled:
            await asyncio.wait(cancelled, timeout=1.0)
        self._conversation.reset()
        self._usage.reset_session()
        self._turn_usage = ZERO
        self._publish_usage()
        if self._sm.state not in (S.IDLE, S.STOPPED):
            await enter(self._sm, S.IDLE)

    # ---------- ход ----------

    async def _turn(self, text: str, previous: list[asyncio.Task[Any]]) -> None:
        if previous:
            # Вытесненный ход сначала закрывает своё сообщение — события не перемешаются.
            await asyncio.wait(previous)
        self._session.add_message("user", text)
        client = self._prepare()
        if client is None:
            return
        self._turn_usage = ZERO
        view = ReplyView(
            session=self._session,
            state_machine=self._sm,
            bus=self._bus,
            envelope=self._envelope,
            executing_min=self._timings.executing_min,
        )
        try:
            await view.thinking()
            try:
                outcome = await self._conversation.run(client, text, self._context(), view)
            except asyncio.CancelledError:
                view.interrupt()
                raise
            except Exception as exc:
                await self._fail(exc, view)
                return
            await self._complete(outcome, view)
        finally:
            view.close()

    def _prepare(self) -> anthropic.AsyncAnthropic | None:
        """Можно ли отправлять запрос; если нет — объяснить пользователю почему."""
        if self._status in ("no_key", "invalid_key"):
            if self._keys.reload():
                self._drop_client()
            if self._keys.key is None:
                self._explain(errors.no_key(self._env_file))
                return None
            # invalid_key остаётся до ответа: тот же ключ мог снова заработать.
            if self._status == "no_key":
                self._set_status("ready")
        if self._status == "limit" or self._usage.limit_reached():
            # Лимит могли поднять в settings.toml, а месяц — смениться.
            self._usage.monthly_limit_usd = self._limit_loader()
            if self._usage.limit_reached():
                self._explain(errors.limit_reached(self._usage.month.cost_usd, self._usage.monthly_limit_usd))
                return None
            self._set_status("ready")
        if self._client is None:
            key = self._keys.key
            if key is None:  # ready без ключа невозможен; защита от рассинхрона
                self._explain(errors.no_key(self._env_file))
                return None
            self._client = self._client_factory(key)
        return self._client

    def _drop_client(self) -> None:
        """Ключ сменился: прежний клиент закрывается в фоне, новый создастся к запросу."""
        client, self._client = self._client, None
        if client is not None:
            task = asyncio.get_running_loop().create_task(client.close(), name="brain-client-close")
            self._closing.add(task)
            task.add_done_callback(self._closing.discard)

    def _context(self) -> str:
        address = self._memory.get(ADDRESS_FORM)
        return build_context(
            now=self._clock(),
            address_form=address,
            default_address_form=self._assistant.address_form,
            ask_address_form=address is None and not self._conversation.has_replies,
            facts=self._memory.facts(),
        )

    async def _complete(self, outcome: Outcome, view: ReplyView) -> None:
        match outcome:
            case Outcome.COMPLETED:
                view.finish()
            case Outcome.TRUNCATED | Outcome.TOOL_TRUNCATED:
                view.finish(TRUNCATED_SUFFIX)
            case Outcome.REFUSED:
                view.refuse(errors.REFUSAL.text)
                self._session.notice(errors.REFUSAL.level, errors.REFUSAL.text, errors.REFUSAL.code)
            case Outcome.STEP_LIMIT:
                view.finish()
                self._session.add_message("system", STEP_LIMIT_TEXT)
        self._settle_status()
        await enter(self._sm, S.IDLE)

    async def _fail(self, exc: Exception, view: ReplyView) -> None:
        failure = errors.classify(exc, self._llm.model)
        if failure is errors.UNEXPECTED and not isinstance(exc, anthropic.APIStatusError):
            log.error("Ход ответа упал: %s", type(exc).__name__, exc_info=exc)
        else:
            log.warning("Запрос к Claude не удался: %s", _describe_error(exc))
        view.fail()
        self._explain(failure)
        await enter(self._sm, S.ERROR, failure.text)
        await asyncio.sleep(self._timings.error_flash)
        await enter(self._sm, S.IDLE)

    def _explain(self, failure: Failure) -> None:
        """Системное сообщение в чат, уведомление и статус — по строке таблицы ошибок."""
        self._set_status(failure.status, None if failure.status == "ready" else failure.text)
        self._session.add_message("system", failure.text)
        self._session.notice(failure.level, failure.text, failure.code)

    # ---------- учёт и события ----------

    def _on_response(self, info: ResponseInfo) -> None:
        totals = self._usage.record(info.usage)
        self._turn_usage = add(self._turn_usage, totals)
        log.info(
            "Claude: %s, stop_reason=%s, %.1f с, токены: вход %d, выход %d, кэш чтение %d / запись %d, "
            "поисков %d, ≈$%.4f",
            info.model,
            info.stop_reason or "—",
            info.duration_s,
            totals.input_tokens,
            totals.output_tokens,
            totals.cache_read_tokens,
            totals.cache_write_tokens,
            totals.web_searches,
            totals.cost_usd,
        )
        self._publish_usage()

    def _publish_usage(self) -> None:
        self._bus.publish(
            UsageMessage(
                session=rounded(self._usage.session),
                month=rounded(self._usage.month),
                last_turn=rounded(self._turn_usage),
                monthly_limit_usd=self._usage.monthly_limit_usd,
            )
        )

    def _on_memory(self, facts: list[MemoryFact]) -> None:
        self._bus.publish(MemoryMessage(facts=facts))

    def _current_status(self) -> tuple[BrainStatus, str | None]:
        """Статус по текущим условиям: нет ключа, исчерпан лимит или всё в порядке."""
        if self._keys.key is None:
            return "no_key", errors.no_key(self._env_file).text
        if self._usage.limit_reached():
            return "limit", errors.limit_reached(
                self._usage.month.cost_usd, self._usage.monthly_limit_usd
            ).text
        return "ready", None

    def _settle_status(self) -> None:
        self._set_status(*self._current_status())

    def _set_status(self, status: BrainStatus, message: str | None = None) -> None:
        if (status, message) == (self._status, self._message):
            return
        if status != self._status:
            log.info("«Мозг»: %s → %s", self._status, status)
        self._status, self._message = status, message
        self._bus.publish(BrainStatusMessage(brain=self.info()))


def _describe_error(exc: BaseException) -> str:
    """Для журнала: класс, HTTP-код, тип и request_id — без тела запроса."""
    if isinstance(exc, anthropic.APIStatusError):
        message = exc.message if len(exc.message) <= 300 else exc.message[:299] + "…"
        where = f"HTTP {exc.status_code}, {exc.type}, request_id {exc.request_id}"
        return f"{type(exc).__name__} ({where}): {message}"
    return type(exc).__name__
