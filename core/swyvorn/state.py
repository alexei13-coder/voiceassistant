"""Машина состояний ассистента (docs/protocol.md §1.3)."""

from __future__ import annotations

import logging
from collections.abc import Awaitable, Callable, Mapping
from enum import StrEnum

log = logging.getLogger(__name__)


class AssistantState(StrEnum):
    IDLE = "idle"
    LISTENING = "listening"
    THINKING = "thinking"
    SPEAKING = "speaking"
    AWAITING_CONFIRMATION = "awaiting_confirmation"
    EXECUTING = "executing"
    ERROR = "error"
    STOPPED = "stopped"


_S = AssistantState

ALLOWED_TRANSITIONS: Mapping[AssistantState, frozenset[AssistantState]] = {
    _S.IDLE: frozenset({_S.LISTENING, _S.THINKING, _S.SPEAKING, _S.EXECUTING, _S.ERROR, _S.STOPPED}),
    _S.LISTENING: frozenset({_S.IDLE, _S.THINKING, _S.ERROR, _S.STOPPED}),
    _S.THINKING: frozenset(
        {_S.IDLE, _S.SPEAKING, _S.AWAITING_CONFIRMATION, _S.EXECUTING, _S.LISTENING, _S.ERROR, _S.STOPPED}
    ),
    _S.SPEAKING: frozenset(
        {_S.IDLE, _S.LISTENING, _S.THINKING, _S.AWAITING_CONFIRMATION, _S.EXECUTING, _S.ERROR, _S.STOPPED}
    ),
    _S.AWAITING_CONFIRMATION: frozenset({_S.IDLE, _S.EXECUTING, _S.SPEAKING, _S.ERROR, _S.STOPPED}),
    _S.EXECUTING: frozenset({_S.IDLE, _S.THINKING, _S.SPEAKING, _S.ERROR, _S.STOPPED}),
    _S.ERROR: frozenset({_S.IDLE, _S.STOPPED}),
    _S.STOPPED: frozenset({_S.IDLE}),
}

# (старое, новое, причина)
StateListener = Callable[[AssistantState, AssistantState, str | None], Awaitable[None]]


class IllegalTransitionError(RuntimeError):
    def __init__(self, current: AssistantState, target: AssistantState) -> None:
        super().__init__(f"недопустимый переход состояния: {current} → {target}")
        self.current = current
        self.target = target


def can_transition(current: AssistantState, target: AssistantState) -> bool:
    return target == current or target in ALLOWED_TRANSITIONS[current]


class StateMachine:
    def __init__(self, initial: AssistantState = AssistantState.IDLE) -> None:
        self._state = initial
        self._reason: str | None = None
        self._listeners: list[StateListener] = []

    @property
    def state(self) -> AssistantState:
        return self._state

    @property
    def reason(self) -> str | None:
        return self._reason

    def add_listener(self, listener: StateListener) -> None:
        self._listeners.append(listener)

    async def transition(self, target: AssistantState, reason: str | None = None) -> bool:
        """Перейти в target. Возвращает False для перехода в то же состояние (no-op).

        Недопустимый переход — ошибка программы: логируется и выбрасывается.
        """
        if target == self._state:
            return False
        if target not in ALLOWED_TRANSITIONS[self._state]:
            error = IllegalTransitionError(self._state, target)
            log.error("%s", error)
            raise error
        await self._apply(target, reason)
        return True

    async def force(self, target: AssistantState, reason: str | None = None) -> bool:
        """Поставить состояние в обход таблицы. Только для demo/set_state (скриншоты)."""
        if target == self._state:
            return False
        await self._apply(target, reason)
        return True

    async def _apply(self, target: AssistantState, reason: str | None) -> None:
        previous = self._state
        self._state = target
        self._reason = reason
        log.debug("Состояние: %s → %s", previous, target)
        for listener in tuple(self._listeners):
            try:
                await listener(previous, target, reason)
            except Exception:
                log.exception("Слушатель состояния упал")
