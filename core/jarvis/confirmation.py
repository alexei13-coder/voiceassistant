"""Подтверждение рискованных действий: одно ожидающее подтверждение, одноразовый nonce.

Решение принимает только ядро. Неверный action_id/nonce, истёкший срок или повтор —
отказ (stale_confirmation), действие не выполняется.
"""

from __future__ import annotations

import asyncio
import hmac
import logging
import secrets
from collections.abc import Callable, Sequence
from dataclasses import dataclass
from typing import Literal

from .bus import EventBus
from .protocol import (
    ConfirmationCountdownMessage,
    ConfirmationOutcome,
    ConfirmationRequest,
    ConfirmationRequestMessage,
    ConfirmationResolvedMessage,
    ConfirmationVia,
    ServerMessage,
    now_ms,
)

log = logging.getLogger(__name__)

DEFAULT_TIMEOUT_MS = 15_000


@dataclass(frozen=True, slots=True)
class ConfirmationResult:
    outcome: ConfirmationOutcome
    via: ConfirmationVia | None = None


class PendingConfirmation:
    def __init__(self, request: ConfirmationRequest) -> None:
        self.request = request
        self.result: ConfirmationResult | None = None
        self._future: asyncio.Future[ConfirmationResult] = asyncio.get_running_loop().create_future()
        self.timer: asyncio.TimerHandle | None = None  # ведёт ConfirmationGate

    @property
    def resolved(self) -> bool:
        return self.result is not None

    @property
    def future(self) -> asyncio.Future[ConfirmationResult]:
        """Завершается при любом исходе; удобно для ожидания «вопрос договорён или решено»."""
        return self._future

    async def wait(self) -> ConfirmationResult:
        # shield: отмена ожидающей задачи не должна отменять сам future — его ещё закроют
        # с исходом stopped/cancelled и разошлют confirmation_resolved.
        return await asyncio.shield(self._future)


def _same(a: str, b: str) -> bool:
    # compare_digest для str допускает только ASCII; байты сравниваются всегда.
    return hmac.compare_digest(a.encode("utf-8"), b.encode("utf-8"))


class ConfirmationGate:
    def __init__(self, bus: EventBus[ServerMessage], *, clock: Callable[[], int] = now_ms) -> None:
        self._bus = bus
        self._clock = clock
        self._pending: PendingConfirmation | None = None

    @property
    def current(self) -> ConfirmationRequest | None:
        """Ожидающий запрос для снимка hello (с актуальным expires_at)."""
        pending = self._pending
        return pending.request if pending is not None and not pending.resolved else None

    def open(
        self,
        *,
        action_id: str,
        title: str,
        spoken_text: str,
        details: Sequence[str],
        command: str | None = None,
        command_language: Literal["powershell"] | None = None,
        code_analysis: Sequence[str] = (),
        model_explanation: str | None = None,
        button_only: bool = False,
        timeout_ms: int = DEFAULT_TIMEOUT_MS,
        demo: bool = False,
    ) -> PendingConfirmation:
        """Открыть запрос; предыдущий ожидающий закрывается с исходом superseded."""
        if self._pending is not None and not self._pending.resolved:
            self._resolve(self._pending, ConfirmationResult("superseded"))
        request = ConfirmationRequest(
            action_id=action_id,
            nonce=secrets.token_urlsafe(16),
            title=title,
            spoken_text=spoken_text,
            details=list(details),
            command=command,
            command_language=command_language,
            code_analysis=list(code_analysis),
            model_explanation=model_explanation,
            button_only=button_only,
            timeout_ms=timeout_ms,
            expires_at=None,
            demo=demo,
        )
        pending = PendingConfirmation(request)
        self._pending = pending
        self._bus.publish(ConfirmationRequestMessage(request=request))
        return pending

    def start_countdown(self, pending: PendingConfirmation) -> int | None:
        """Вопрос договорён — пошёл отсчёт. Возвращает expires_at или None, если уже решено."""
        if pending.resolved or pending is not self._pending or pending.request.expires_at is not None:
            return pending.request.expires_at
        expires_at = self._clock() + pending.request.timeout_ms
        pending.request = pending.request.model_copy(update={"expires_at": expires_at})
        loop = asyncio.get_running_loop()
        pending.timer = loop.call_later(
            pending.request.timeout_ms / 1000, self._resolve, pending, ConfirmationResult("timeout")
        )
        self._bus.publish(
            ConfirmationCountdownMessage(action_id=pending.request.action_id, expires_at=expires_at)
        )
        return expires_at

    def submit(
        self, action_id: str, nonce: str, decision: Literal["yes", "no"], via: ConfirmationVia
    ) -> bool:
        """Принять ответ пользователя. False — подтверждение устарело, ничего не произошло."""
        pending = self._pending
        if pending is None or pending.resolved:
            return False
        request = pending.request
        # Оба сравнения выполняются всегда, чтобы время ответа не выдавало, что именно не совпало.
        id_ok = _same(action_id, request.action_id)
        nonce_ok = _same(nonce, request.nonce)
        if not (id_ok and nonce_ok):
            return False
        if request.expires_at is not None and self._clock() >= request.expires_at:
            return False
        self._resolve(pending, ConfirmationResult("confirmed" if decision == "yes" else "denied", via))
        return True

    def resolve_current(self, outcome: ConfirmationOutcome) -> ConfirmationResult | None:
        """Закрыть ожидающее подтверждение извне («Стоп», новый ход)."""
        pending = self._pending
        if pending is None or pending.resolved:
            return None
        result = ConfirmationResult(outcome)
        self._resolve(pending, result)
        return result

    def _resolve(self, pending: PendingConfirmation, result: ConfirmationResult) -> None:
        if pending.resolved:
            return
        pending.result = result
        if pending.timer is not None:
            pending.timer.cancel()
            pending.timer = None
        if not pending.future.done():
            pending.future.set_result(result)
        if self._pending is pending:
            self._pending = None
        log.info("Подтверждение %s: %s", pending.request.action_id, result.outcome)
        self._bus.publish(
            ConfirmationResolvedMessage(
                action_id=pending.request.action_id, outcome=result.outcome, via=result.via
            )
        )
