"""Ответ Claude глазами пользователя: состояние ассистента, сообщение в чате, уровни голоса,
записи журнала о поисках в интернете. Цикл запросов (conversation.py) только сообщает сюда,
что происходит в стриме.

Сообщение ассистента одно на реплику пользователя и создаётся с первым словом ответа: при
отказе или ошибке до начала текста в чате не остаётся пустого «пузыря».
"""

from __future__ import annotations

import asyncio
import contextlib
import time
from collections.abc import AsyncIterator, Awaitable, Callable
from typing import Any

from ..bus import EventBus
from ..demo_audio import SpeechEnvelope
from ..protocol import ActionStatus, AudioLevelMessage, ServerMessage
from ..session import Session
from ..state import AssistantState, StateMachine, can_transition
from .speech import SpeechLevels

S = AssistantState

STOPPED_SUFFIX = " (остановлено)"
TRUNCATED_SUFFIX = "…(ответ обрезан)"
SEARCH_TITLE_LIMIT = 120


async def enter(sm: StateMachine, state: AssistantState, reason: str | None = None) -> None:
    """Перейти в state; если таблица переходов не разрешает прямой путь — через idle."""
    if sm.state is not state and not can_transition(sm.state, state):
        await sm.transition(S.IDLE)
    await sm.transition(state, reason)


class ReplyView:
    def __init__(
        self,
        *,
        session: Session,
        state_machine: StateMachine,
        bus: EventBus[ServerMessage],
        envelope: SpeechEnvelope,
        executing_min: float = 0.0,
        levels_clock: Callable[[], float] = time.perf_counter,
        levels_sleep: Callable[[float], Awaitable[None]] = asyncio.sleep,
    ) -> None:
        self._session = session
        self._sm = state_machine
        self._executing_min = executing_min
        self._levels = SpeechLevels(self._publish_level, envelope, clock=levels_clock, sleep=levels_sleep)
        self._bus = bus
        self._levels_task: asyncio.Task[None] | None = None
        self._message_id: str | None = None
        self._text = ""
        self._last_block: str | None = None
        self._separate = False
        self._searches: dict[str, str] = {}  # tool_use_id → id записи журнала

    # ---------- состояние ----------

    async def thinking(self) -> None:
        await enter(self._sm, S.THINKING)

    @contextlib.asynccontextmanager
    async def executing(self) -> AsyncIterator[None]:
        """Свои инструменты: «ВЫПОЛНЯЮ» хотя бы executing_min, чтобы смену состояния было видно."""
        await enter(self._sm, S.EXECUTING)
        started = time.monotonic()
        yield
        remaining = self._executing_min - (time.monotonic() - started)
        if remaining > 0:
            await asyncio.sleep(remaining)

    # ---------- блоки стрима ----------

    def block_started(self, kind: str) -> None:
        """Новый блок ответа. Текст после нетекстового блока (инструмент, поиск, мышление)
        отделяется пустой строкой; соседние текстовые блоки (так API разбивает текст вокруг
        цитат из поиска) склеиваются как есть."""
        if kind == "text":
            self._separate = self._last_block not in (None, "text") and bool(self._text.strip())
        self._last_block = kind

    async def text(self, delta: str) -> None:
        if not delta:
            return
        if self._separate:
            self._separate = False
            if not self._text.endswith(("\n", " ")):
                delta = "\n\n" + delta.lstrip()
        if self._sm.state is not S.SPEAKING:
            await enter(self._sm, S.SPEAKING)
        if self._message_id is None:
            self._message_id = self._session.add_message("assistant", "", streaming=True).id
        self._text += delta
        self._session.append_delta(self._message_id, delta)
        self._levels.feed(delta)
        if self._levels_task is None:
            self._levels_task = asyncio.get_running_loop().create_task(
                self._levels.run(), name="brain-levels"
            )

    def text_finished(self) -> None:
        self._levels.flush()

    async def search_started(self) -> None:
        # Пока сервер ищет, ассистент «думает», даже если начало ответа уже напечатано.
        await enter(self._sm, S.THINKING)

    def search_requested(self, tool_use_id: str, query: str) -> None:
        query = " ".join(query.split())
        if len(query) > SEARCH_TITLE_LIMIT:
            query = query[: SEARCH_TITLE_LIMIT - 1].rstrip() + "…"
        entry = self._session.add_action(
            tool="web_search",
            title=f"Поиск в интернете: {query}",
            risk="safe",
            status="running",
            decision="auto",
        )
        self._searches[tool_use_id] = entry.id

    def search_finished(self, tool_use_id: str, content: Any) -> None:
        action_id = self._searches.pop(tool_use_id, None)
        if action_id is None:
            return
        if isinstance(content, list):
            self._session.update_action(action_id, status="ok", detail=f"Найдено результатов: {len(content)}")
        else:
            code = getattr(content, "error_code", None) or "неизвестная ошибка"
            self._session.update_action(action_id, status="error", detail=f"Поиск не удался: {code}")

    # ---------- повтор запроса ----------

    def mark(self) -> int:
        return len(self._text)

    def rollback(self, mark: int) -> None:
        """Запрос повторяется заново: убрать из чата то, что успел напечатать неудачный."""
        if self._message_id is not None and len(self._text) > mark:
            self._text = self._text[:mark]
            self._session.set_message_text(self._message_id, self._text)
        self._last_block = None

    # ---------- завершение ----------

    def finish(self, suffix: str | None = None) -> None:
        self._stop_levels()
        if suffix:
            self._append_or_create(suffix)
        self._close_message()
        self._close_searches("error", "Ответ поиска не получен")

    def refuse(self, text: str) -> None:
        """Отказ: частичный вывод не показываем как ответ — заменяем вежливой фразой."""
        self._stop_levels()
        if self._message_id is None:
            self._session.add_message("assistant", text)
        else:
            self._session.set_message_text(self._message_id, text)
            self._close_message()
        self._text = text
        self._close_searches("error", "Ответ не получен")

    def interrupt(self) -> None:
        """«Стоп» или новая реплика. Незакрытые поиски уже пометил KillSwitch."""
        self._stop_levels()
        if self._message_id is not None:
            self._session.append_delta(self._message_id, STOPPED_SUFFIX)
        self._close_message()

    def fail(self) -> None:
        self._stop_levels()
        self._close_message()
        self._close_searches("error", "Ответ не получен из-за ошибки")

    def close(self) -> None:
        """Повторный вызов безопасен; зовётся в finally хода."""
        self._stop_levels()

    def _append_or_create(self, text: str) -> None:
        if self._message_id is None:
            self._session.add_message("assistant", text)
        else:
            self._session.append_delta(self._message_id, text)
        self._text += text

    def _close_message(self) -> None:
        if self._message_id is not None:
            self._session.finish_message(self._message_id)

    def _close_searches(self, status: ActionStatus, detail: str) -> None:
        for action_id in self._searches.values():
            self._session.update_action(action_id, status=status, detail=detail)
        self._searches.clear()

    def _stop_levels(self) -> None:
        if self._levels_task is not None and not self._levels_task.done():
            self._levels_task.cancel()

    def _publish_level(self, level: float) -> None:
        # Протокол: уровни голоса — только в состоянии speaking.
        if self._sm.state is S.SPEAKING:
            self._bus.publish(AudioLevelMessage(source="tts", level=level))
