"""Демо-сценарий этапа 1 (docs/protocol.md §5): «мозг» и голос пока имитируются.

Никакие реальные действия не выполняются: все записи журнала и подтверждения помечены demo.
Каждый ход запускается через KillSwitch, поэтому «Стоп» прерывает сценарий мгновенно.
Все ожидания — asyncio.sleep, длительности масштабируются DemoTimings.time_scale (для тестов).
"""

from __future__ import annotations

import asyncio
import itertools
import logging
import random
import time
from collections.abc import Awaitable, Callable, Iterator
from dataclasses import dataclass
from typing import Any

from .bus import EventBus
from .config import AssistantSettings
from .confirmation import ConfirmationGate, ConfirmationResult
from .demo_audio import FRAME_RATE, MIC_PROFILE, TTS_PROFILE, SpeechEnvelope, pause_after, split_words
from .killswitch import KillSwitch
from .protocol import ActionDecision, AudioLevelMessage, AudioSource, DemoAction, ServerMessage, StopSource
from .session import ACTIVE_STATUSES, Session
from .state import AssistantState, StateMachine, can_transition

log = logging.getLogger(__name__)

S = AssistantState


@dataclass(frozen=True, slots=True)
class DemoTimings:
    """Номинальные длительности в секундах; реальные = номинальные × time_scale."""

    idle: float = 4.0
    listening: float = 3.0
    thinking: float = 2.5
    thinking_followup: float = 2.0
    executing: float = 1.5
    reply_thinking: float = 1.2
    voice_listening: float = 4.0
    voice_thinking: float = 1.0
    push_to_talk_max: float = 60.0
    error_flash: float = 1.2
    resume_after_idle: float = 3.0
    confirmation_timeout: float = 15.0
    time_scale: float = 1.0
    # Часы и сон для темпа уровней звука. perf_counter, а не loop.time(): на Python 3.12
    # под Windows монотонные часы цикла тикают по 15,6 мс, и номер кадра считался бы неточно.
    # В тестах подменяются ради детерминизма.
    clock: Callable[[], float] = time.perf_counter
    sleep: Callable[[float], Awaitable[None]] = asyncio.sleep

    def real(self, nominal: float) -> float:
        return nominal * self.time_scale


USER_WEATHER = "Свайворн, какая сегодня погода?"
USER_TRASH = "Удали старые скриншоты из „Загрузок“"
# Без обращения в конце: его добавляет _addressed() по настройке address_form. ~5 с речи.
WEATHER_REPLY = "Сейчас в Москве плюс двенадцать, облачно. К вечеру возможен дождь"

TRASH_TITLE = "Переместить в корзину 3 файла"
TRASH_NAMES = (
    "Снимок экрана 2026-03-02 101532.png",
    "Снимок экрана 2026-04-17 184410.png",
    "Снимок экрана 2026-05-09 093027.png",
)
TRASH_FILES = tuple(f"%USERPROFILE%\\Downloads\\{name}" for name in TRASH_NAMES)
TRASH_COMMAND = "\n".join(
    [
        "Add-Type -AssemblyName Microsoft.VisualBasic",
        "$files = @(",
        *(f'  "$env:USERPROFILE\\Downloads\\{name}"' for name in TRASH_NAMES),
        ")",
        "foreach ($f in $files) {",
        "  [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteFile($f, 'OnlyErrorDialogs', 'SendToRecycleBin')",
        "}",
    ]
)
TRASH_ANALYSIS = (
    "Затрагивает 3 файла в папке «Загрузки», вложенные папки не трогает",
    "Файлы перемещаются в корзину — их можно восстановить",
    "Нет сетевых обращений и запуска других программ",
)
TRASH_EXPLANATION = "Выбрал скриншоты старше 90 дней по имени и дате изменения; остальные файлы не трогаю."

EXECUTED_DETAIL = "Демо: ничего не удалялось"
REPLY_QUOTE_LIMIT = 120

_CONFIRMED_DECISION: dict[str, ActionDecision] = {
    "button": "confirmed_button",
    "voice": "confirmed_voice",
    "text": "confirmed_text",
}


class DemoController:
    """Демо-«мозг»: сценарий по кругу, ответы на текст, имитация микрофона, демо-команды."""

    def __init__(
        self,
        *,
        state_machine: StateMachine,
        session: Session,
        confirmations: ConfirmationGate,
        killswitch: KillSwitch,
        bus: EventBus[ServerMessage],
        assistant: AssistantSettings,
        scenario_enabled: bool,
        timings: DemoTimings | None = None,
        rng: random.Random | None = None,
    ) -> None:
        self._sm = state_machine
        self._session = session
        self._gate = confirmations
        self._ks = killswitch
        self._bus = bus
        self._assistant = assistant
        self._scenario_enabled = scenario_enabled
        self._t = timings or DemoTimings()
        # Не для криптографии: только форма синтетической огибающей.
        rng = rng or random.Random()  # noqa: S311
        self._mic = SpeechEnvelope(rng, MIC_PROFILE)
        self._tts = SpeechEnvelope(rng, TTS_PROFILE)
        self._frame_period = self._t.real(1.0 / FRAME_RATE)
        # autoplay: сценарий сам продолжается после «Стоп» и ответов; выключается demo/stop и set_state.
        self._autoplay = scenario_enabled
        self._resume_task: asyncio.Task[None] | None = None
        self._capture_end: asyncio.Event | None = None
        killswitch.add_stop_listener(self._on_stop)

    # ---------- жизненный цикл ----------

    def start(self) -> None:
        if self._scenario_enabled:
            self._begin_turn("demo-scenario", lambda: self._scenario(initial_idle=self._t.idle))

    def shutdown(self) -> None:
        self._autoplay = False
        self._cancel_resume()

    def retire(self) -> None:
        """Появился ключ API: сценарий больше не нужен, дальше отвечает «мозг».

        Имитация микрофона (voice_toggle и т.п.) остаётся до голоса этапа 3.
        """
        self._scenario_enabled = False
        self.shutdown()
        self._ks.cancel_turn("cancelled")

    # ---------- входы от UI и оболочки ----------

    def handle_user_text(self, text: str) -> None:
        self._begin_turn("demo-reply", lambda: self._text_reply(text))

    def voice_toggle(self) -> None:
        """Кнопка микрофона / короткое нажатие: начать «слушать» или закончить раньше."""
        if not self.end_capture():
            self._start_voice(self._t.voice_listening)

    def push_to_talk_down(self) -> None:
        end = self._capture_end
        if end is None or end.is_set():
            self._start_voice(self._t.push_to_talk_max)

    def end_capture(self) -> bool:
        """Закончить идущую «запись» с микрофона (отпущена клавиша, выключен микрофон).

        False — записи не было.
        """
        end = self._capture_end
        if end is None or end.is_set():
            return False
        end.set()
        return True

    async def command(self, action: DemoAction, state: AssistantState | None = None) -> None:
        match action:
            case "start":
                self._autoplay = True
                self._begin_turn("demo-scenario", lambda: self._scenario(initial_idle=self._t.idle))
            case "stop":
                self._autoplay = False
                self._cancel_resume()
                self._ks.cancel_turn("cancelled")
                await self._enter(S.IDLE)
            case "set_state":
                if state is None:
                    raise ValueError("set_state требует state")
                self._autoplay = False
                self._cancel_resume()
                self._ks.cancel_turn("cancelled")
                await self._sm.force(state)
                if state in (S.LISTENING, S.SPEAKING):
                    self._ks.spawn(self._hold_levels(state), name="demo-hold")
            case "confirmation":
                self._begin_turn("demo-confirmation", self._confirmation_turn)
            case "error_flash":
                self._begin_turn("demo-error", self._error_flash)

    # ---------- управление ходами ----------

    def _begin_turn(self, name: str, factory: Callable[[], Awaitable[None]]) -> asyncio.Task[Any]:
        """Новый ход вытесняет текущий; после обычного завершения сценарий продолжится сам."""
        self._cancel_resume()
        previous = self._ks.cancel_turn("cancelled")

        async def turn() -> None:
            if previous:
                # Даём вытесненному ходу свернуться (закрыть сообщения), чтобы события не перемешались.
                await asyncio.wait(previous)
            await factory()
            self._schedule_resume(self._t.real(self._t.resume_after_idle))

        return self._ks.spawn(turn(), name=name)

    def _on_stop(self, source: StopSource) -> None:
        self._schedule_resume(self._ks.return_to_idle_after + self._t.real(self._t.resume_after_idle))

    def _schedule_resume(self, delay: float) -> None:
        if not self._autoplay:
            return
        self._cancel_resume()
        self._resume_task = asyncio.get_running_loop().create_task(
            self._resume_later(delay), name="demo-resume"
        )

    async def _resume_later(self, delay: float) -> None:
        await asyncio.sleep(delay)
        # Продолжаем, только если всё это время ничего не происходило.
        if self._autoplay and not self._ks.active and self._sm.state is S.IDLE:
            self._begin_turn("demo-scenario", lambda: self._scenario(initial_idle=0.0))

    def _cancel_resume(self) -> None:
        task = self._resume_task
        if task is not None and task is not asyncio.current_task() and not task.done():
            task.cancel()
        self._resume_task = None

    def _start_voice(self, max_duration: float) -> None:
        if self._session.muted:
            self._session.notice("warning", "Микрофон выключен — включите его, чтобы говорить.", "muted")
            return
        end = asyncio.Event()
        self._capture_end = end
        self._begin_turn("demo-voice", lambda: self._voice_turn(end, max_duration))

    # ---------- ходы ----------

    async def _scenario(self, initial_idle: float) -> None:
        idle = initial_idle
        while True:
            await self._idle(idle)
            await self._weather_episode()
            await self._idle(self._t.idle)
            await self._trash_episode()
            idle = self._t.idle

    async def _weather_episode(self) -> None:
        await self._session.wait_unmuted()
        await self._listen(self._mic.stream(USER_WEATHER), self._t.listening)
        self._session.add_message("user", USER_WEATHER)
        await self._enter(S.THINKING)
        entry = self._session.add_action(
            tool="weather", title="Погода в Москве", risk="safe", status="running", decision="auto", demo=True
        )
        await self._sleep(self._t.thinking)
        self._session.update_action(entry.id, status="ok", detail="Демо: +12 °C, облачно, вечером дождь")
        await self._speak(self._addressed(WEATHER_REPLY, "."))

    async def _trash_episode(self) -> None:
        await self._session.wait_unmuted()
        await self._listen(self._mic.stream(USER_TRASH), self._t.listening)
        self._session.add_message("user", USER_TRASH)
        await self._enter(S.THINKING)
        await self._sleep(self._t.thinking_followup)
        await self._confirmation_episode()

    async def _confirmation_turn(self) -> None:
        self._session.add_message("user", USER_TRASH)
        await self._enter(S.THINKING)
        await self._sleep(self._t.thinking_followup)
        await self._confirmation_episode()
        await self._enter(S.IDLE)

    async def _confirmation_episode(self) -> None:
        question = (
            "Нашёл 3 файла — старые скриншоты в «Загрузках». Переместить их в корзину? "
            + self._addressed("Вы уверены", "?")
        )
        entry = self._session.add_action(
            tool="files_trash", title=TRASH_TITLE, risk="confirm", status="awaiting_confirmation", demo=True
        )
        pending = self._gate.open(
            action_id=entry.id,
            title=TRASH_TITLE,
            spoken_text=question,
            details=TRASH_FILES,
            command=TRASH_COMMAND,
            command_language="powershell",
            code_analysis=TRASH_ANALYSIS,
            model_explanation=TRASH_EXPLANATION,
            timeout_ms=round(self._t.real(self._t.confirmation_timeout) * 1000),
            demo=True,
        )
        # Карточка уже на экране; ответ кнопкой во время вопроса обрывает речь.
        await self._speak(question, interrupt=pending.future)
        if not pending.resolved:
            await self._enter(S.AWAITING_CONFIRMATION)
            self._gate.start_countdown(pending)
        await self._finish_confirmation(entry.id, await pending.wait())

    async def _finish_confirmation(self, action_id: str, result: ConfirmationResult) -> None:
        match result.outcome:
            case "confirmed":
                decision = _CONFIRMED_DECISION[result.via or "button"]
                self._session.update_action(action_id, status="running", decision=decision)
                await self._enter(S.EXECUTING)
                await self._sleep(self._t.executing)
                self._session.update_action(action_id, status="ok", detail=EXECUTED_DETAIL)
                await self._speak("Готово.")
            case "denied":
                self._session.update_action(
                    action_id, status="denied", decision="denied", detail="Отменено пользователем"
                )
                await self._speak("Отменено.")
            case "timeout":
                self._session.update_action(
                    action_id,
                    status="timeout",
                    decision="timeout",
                    detail="Нет ответа — действие не выполнено",
                )
                await self._speak("Не дождался ответа. Отменено.")
            case _:
                # stopped/cancelled обычно уже закрыл KillSwitch; superseded — закрываем сами.
                entry = self._session.get_action(action_id)
                if entry is not None and entry.status in ACTIVE_STATUSES:
                    self._session.update_action(action_id, status="cancelled")

    async def _text_reply(self, text: str) -> None:
        self._session.add_message("user", text)
        await self._enter(S.THINKING)
        await self._sleep(self._t.reply_thinking)
        quote = text if len(text) <= REPLY_QUOTE_LIMIT else text[: REPLY_QUOTE_LIMIT - 1].rstrip() + "…"
        await self._speak(f"Это демонстрационный режим: мозг подключим на этапе 2. Вы написали: „{quote}“")
        await self._enter(S.IDLE)

    async def _voice_turn(self, end: asyncio.Event, max_duration: float) -> None:
        try:
            await self._listen(self._mic.stream(None), max_duration, until=end)
        finally:
            # И при отмене: иначе следующее нажатие «закончило» бы несуществующую запись.
            end.set()
        await self._enter(S.THINKING)
        await self._sleep(self._t.voice_thinking)
        self._session.notice(
            "info", "Распознавание речи появится на этапе 3 — пока можно написать текстом.", "demo_voice"
        )
        await self._enter(S.IDLE)

    async def _error_flash(self) -> None:
        await self._enter(S.ERROR, reason="Демо: так выглядит ошибка")
        await self._sleep(self._t.error_flash)
        await self._enter(S.IDLE)

    async def _hold_levels(self, state: AssistantState) -> None:
        """Живые уровни для состояния, поставленного demo/set_state (до следующей команды)."""
        source: AudioSource = "mic" if state is S.LISTENING else "tts"
        envelope = self._mic if source == "mic" else self._tts
        await self._play(source, envelope.stream(None))

    # ---------- примитивы ----------

    async def _enter(self, state: AssistantState, reason: str | None = None) -> None:
        """Перейти в state; если таблица не разрешает прямой переход — через idle."""
        if self._sm.state is not state and not can_transition(self._sm.state, state):
            await self._sm.transition(S.IDLE)
        await self._sm.transition(state, reason)

    async def _sleep(self, nominal: float) -> None:
        await asyncio.sleep(self._t.real(nominal))

    async def _idle(self, nominal: float) -> None:
        await self._enter(S.IDLE)
        await self._sleep(nominal)

    async def _play(
        self,
        source: AudioSource,
        frames: Iterator[float],
        *,
        stop: Callable[[], bool] | None = None,
    ) -> bool:
        """Отправлять уровни с частотой кадров. False — прервано условием stop.

        Кадр k привязан к моменту start + k·period. Если цикл проспал (грубый таймер Windows,
        нагрузка), просроченные кадры пропускаются, а не догоняются пачкой: уровни никогда не
        идут чаще FRAME_RATE, а длительность фразы не зависит от точности таймера.
        """
        clock, sleep = self._t.clock, self._t.sleep
        period = self._frame_period
        started = clock()
        due_index = 0
        for index, level in enumerate(frames):
            if index < due_index:
                continue
            if stop is not None and stop():
                return False
            self._bus.publish(AudioLevelMessage(source=source, level=level))
            await sleep(max(0.0, started + (index + 1) * period - clock()))
            due_index = int((clock() - started) / period)
        return True

    async def _listen(
        self, frames: Iterator[float], nominal: float, *, until: asyncio.Event | None = None
    ) -> None:
        await self._enter(S.LISTENING)
        count = max(1, round(nominal * FRAME_RATE))
        await self._play("mic", itertools.islice(frames, count), stop=until.is_set if until else None)

    async def _speak(self, text: str, *, interrupt: asyncio.Future[Any] | None = None) -> None:
        """Ответ печатается по словам, уровень голоса идёт синхронно с каждым словом."""
        await self._enter(S.SPEAKING)
        message = self._session.add_message("assistant", "", streaming=True)
        interrupted = interrupt.done if interrupt is not None else None
        try:
            for word in split_words(text):
                if interrupted is not None and interrupted():
                    return
                self._session.append_delta(message.id, word)
                frames = self._tts.word(word) + self._tts.silence(pause_after(word))
                if not await self._play("tts", iter(frames), stop=interrupted):
                    return
        finally:
            self._session.finish_message(message.id)

    def _addressed(self, phrase: str, end: str) -> str:
        form = self._assistant.address_form
        return f"{phrase}, {form}{end}" if form else f"{phrase}{end}"
