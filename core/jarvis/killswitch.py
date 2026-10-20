"""«Стоп» (docs/protocol.md §3): мгновенная отмена всего текущего хода.

Всё, что относится к ходу (демо-сценарий, позже — запрос к модели, речь, инструмент),
запускается через spawn(), поэтому одна отмена останавливает всё сразу.
"""

from __future__ import annotations

import asyncio
import logging
import time
from collections.abc import Callable, Coroutine
from typing import Any, Literal

from .bus import EventBus
from .confirmation import ConfirmationGate
from .protocol import ServerMessage, StoppedMessage, StopSource
from .session import Session
from .state import AssistantState, StateMachine

log = logging.getLogger(__name__)

RETURN_TO_IDLE_AFTER = 0.8

StopListener = Callable[[StopSource], None]


class KillSwitch:
    def __init__(
        self,
        *,
        state_machine: StateMachine,
        confirmations: ConfirmationGate,
        session: Session,
        bus: EventBus[ServerMessage],
        return_to_idle_after: float = RETURN_TO_IDLE_AFTER,
    ) -> None:
        self._sm = state_machine
        self._confirmations = confirmations
        self._session = session
        self._bus = bus
        self._return_to_idle_after = return_to_idle_after
        self._tasks: set[asyncio.Task[Any]] = set()
        self._idle_timer: asyncio.Task[None] | None = None
        self._listeners: list[StopListener] = []

    @property
    def return_to_idle_after(self) -> float:
        return self._return_to_idle_after

    @property
    def active(self) -> bool:
        """Идёт ли сейчас какой-нибудь ход."""
        return any(not task.done() for task in self._tasks)

    def add_stop_listener(self, listener: StopListener) -> None:
        self._listeners.append(listener)

    def spawn(self, coro: Coroutine[Any, Any, Any], *, name: str) -> asyncio.Task[Any]:
        """Запустить задачу текущего хода."""
        task = asyncio.get_running_loop().create_task(coro, name=name)
        self._tasks.add(task)
        task.add_done_callback(self._on_task_done)
        return task

    def _on_task_done(self, task: asyncio.Task[Any]) -> None:
        self._tasks.discard(task)
        if task.cancelled():
            return
        exc = task.exception()
        if exc is not None:
            log.error("Задача хода %s упала", task.get_name(), exc_info=exc)

    def cancel_turn(self, outcome: Literal["stopped", "cancelled"] = "cancelled") -> list[asyncio.Task[Any]]:
        """Синхронно отменить ход: задачи, ожидающее подтверждение, незавершённые записи журнала.

        Возвращает отменённые задачи — новый ход может дождаться, пока они свернутся.
        """
        tasks = [task for task in self._tasks if not task.done()]
        for task in tasks:
            task.cancel()
        self._cancel_idle_timer()
        self._confirmations.resolve_current(outcome)
        self._session.interrupt_active_actions(outcome)
        return tasks

    async def stop(self, source: StopSource) -> None:
        """«Стоп». Повторный вызов безопасен: состояние уже stopped, событие уйдёт ещё раз."""
        started = time.perf_counter()
        cancelled = self.cancel_turn("stopped")
        await self._sm.transition(AssistantState.STOPPED)
        self._bus.publish(StoppedMessage(source=source))
        self._idle_timer = asyncio.get_running_loop().create_task(
            self._return_to_idle(), name="stop-return-idle"
        )
        for listener in tuple(self._listeners):
            try:
                listener(source)
            except Exception:
                log.exception("Слушатель «Стоп» упал")
        log.info(
            "«Стоп» (%s): отменено задач %d за %.1f мс",
            source,
            len(cancelled),
            (time.perf_counter() - started) * 1000,
        )

    async def _return_to_idle(self) -> None:
        await asyncio.sleep(self._return_to_idle_after)
        if self._sm.state is AssistantState.STOPPED:
            await self._sm.transition(AssistantState.IDLE)

    def _cancel_idle_timer(self) -> None:
        if self._idle_timer is not None and not self._idle_timer.done():
            self._idle_timer.cancel()
        self._idle_timer = None

    async def shutdown(self, grace: float = 0.5) -> None:
        """Завершение ядра: отменить всё и коротко дождаться, чтобы задачи успели свернуться."""
        tasks = self.cancel_turn("cancelled")
        if tasks:
            await asyncio.wait(tasks, timeout=grace)
