"""Состояние разговора для снимка hello: история чата, журнал действий, микрофон, уведомления.

Каждое изменение здесь же публикуется в шину, поэтому снимок и поток событий не расходятся.
"""

from __future__ import annotations

import asyncio
import time
import uuid
from collections import OrderedDict
from typing import Any, Literal

from .bus import EventBus
from .protocol import (
    ActionDecision,
    ActionEntry,
    ActionMessage,
    ActionStatus,
    ChatDeltaMessage,
    ChatDoneMessage,
    ChatMessage,
    ChatMessageMessage,
    ChatRole,
    MutedMessage,
    NoticeLevel,
    NoticeMessage,
    Risk,
    ServerMessage,
    now_ms,
)

HISTORY_LIMIT = 100
ACTIONS_LIMIT = 200
STICKY_NOTICES_LIMIT = 8

# Записи в этих статусах ещё не завершены — их закрывает «Стоп» или новый ход.
ACTIVE_STATUSES: frozenset[ActionStatus] = frozenset({"pending", "awaiting_confirmation", "running"})


def new_id(prefix: str) -> str:
    return f"{prefix}_{uuid.uuid4().hex[:16]}"


class Session:
    def __init__(
        self,
        bus: EventBus[ServerMessage],
        *,
        history_limit: int = HISTORY_LIMIT,
        actions_limit: int = ACTIONS_LIMIT,
    ) -> None:
        self._bus = bus
        self._history_limit = history_limit
        self._actions_limit = actions_limit
        self._messages: OrderedDict[str, ChatMessage] = OrderedDict()
        self._actions: OrderedDict[str, ActionEntry] = OrderedDict()
        self._running_since: dict[str, float] = {}
        self._sticky_notices: list[NoticeMessage] = []
        self._muted = False
        self._unmuted = asyncio.Event()
        self._unmuted.set()

    # ---------- чат ----------

    def add_message(self, role: ChatRole, text: str = "", *, streaming: bool = False) -> ChatMessage:
        message = ChatMessage(id=new_id("m"), role=role, text=text, streaming=streaming, created_at=now_ms())
        self._messages[message.id] = message
        while len(self._messages) > self._history_limit:
            self._messages.popitem(last=False)
        self._bus.publish(ChatMessageMessage(message=message))
        return message

    def append_delta(self, message_id: str, delta: str) -> None:
        message = self._messages.get(message_id)
        if message is None or not message.streaming or not delta:
            return
        self._messages[message_id] = message.model_copy(update={"text": message.text + delta})
        self._bus.publish(ChatDeltaMessage(id=message_id, delta=delta))

    def set_message_text(self, message_id: str, text: str) -> None:
        """Заменить текст целиком (отказ модели, повтор запроса): chat_message с тем же id."""
        message = self._messages.get(message_id)
        if message is None or message.text == text:
            return
        updated = message.model_copy(update={"text": text})
        self._messages[message_id] = updated
        self._bus.publish(ChatMessageMessage(message=updated))

    def finish_message(self, message_id: str) -> None:
        """Повторный вызов безопасен: им закрывают сообщение и при отмене хода."""
        message = self._messages.get(message_id)
        if message is None or not message.streaming:
            return
        self._messages[message_id] = message.model_copy(update={"streaming": False})
        self._bus.publish(ChatDoneMessage(id=message_id))

    def history(self) -> list[ChatMessage]:
        return list(self._messages.values())

    def clear_history(self) -> None:
        """Новый диалог: лента чата пустеет, журнал действий остаётся."""
        self._messages.clear()

    # ---------- журнал действий ----------

    def add_action(
        self,
        *,
        tool: str,
        title: str,
        risk: Risk,
        status: ActionStatus,
        decision: ActionDecision | None = None,
        detail: str | None = None,
        demo: bool = False,
    ) -> ActionEntry:
        entry = ActionEntry(
            id=new_id("a"),
            created_at=now_ms(),
            tool=tool,
            title=title,
            risk=risk,
            status=status,
            decision=decision,
            detail=detail,
            demo=demo,
        )
        if status == "running":
            self._running_since[entry.id] = time.monotonic()
        self._actions[entry.id] = entry
        while len(self._actions) > self._actions_limit:
            old_id, _ = self._actions.popitem(last=False)
            self._running_since.pop(old_id, None)
        self._bus.publish(ActionMessage(entry=entry))
        return entry

    def update_action(self, action_id: str, **changes: Any) -> ActionEntry | None:
        """Обновить запись; duration_ms считается сам, когда запись выходит из running."""
        entry = self._actions.get(action_id)
        if entry is None:
            return None
        status = changes.get("status", entry.status)
        if status == "running":
            self._running_since.setdefault(action_id, time.monotonic())
        elif status not in ACTIVE_STATUSES and "duration_ms" not in changes:
            started = self._running_since.pop(action_id, None)
            if started is not None:
                changes["duration_ms"] = round((time.monotonic() - started) * 1000)
        updated = ActionEntry.model_validate(entry.model_dump() | changes)
        self._actions[action_id] = updated
        self._bus.publish(ActionMessage(entry=updated))
        return updated

    def interrupt_active_actions(self, status: Literal["stopped", "cancelled"]) -> list[ActionEntry]:
        """Закрыть все незавершённые записи (§3, шаг 3)."""
        updated: list[ActionEntry] = []
        for entry in [e for e in self._actions.values() if e.status in ACTIVE_STATUSES]:
            # Уже принятое решение (например, confirmed_button у выполняющегося) сохраняем.
            undecided = entry.decision is None or entry.status == "awaiting_confirmation"
            decision = "stopped" if status == "stopped" and undecided else entry.decision
            result = self.update_action(entry.id, status=status, decision=decision)
            if result is not None:
                updated.append(result)
        return updated

    def get_action(self, action_id: str) -> ActionEntry | None:
        return self._actions.get(action_id)

    def actions(self) -> list[ActionEntry]:
        return list(self._actions.values())

    # ---------- микрофон ----------

    @property
    def muted(self) -> bool:
        return self._muted

    def set_muted(self, muted: bool) -> None:
        # Рассылаем и без изменения: UI мог разойтись с ядром, ответ его синхронизирует.
        self._muted = muted
        if muted:
            self._unmuted.clear()
        else:
            self._unmuted.set()
        self._bus.publish(MutedMessage(muted=muted))

    async def wait_unmuted(self) -> None:
        await self._unmuted.wait()

    # ---------- уведомления ----------

    def notice(self, level: NoticeLevel, text: str, code: str | None = None, *, sticky: bool = False) -> None:
        """sticky — уведомление о постоянной проблеме (например, занятое сочетание клавиш):
        его получит и UI, подключившийся позже."""
        message = NoticeMessage(level=level, text=text, code=code)
        if sticky:
            self._sticky_notices = [*self._sticky_notices, message][-STICKY_NOTICES_LIMIT:]
        self._bus.publish(message)

    def sticky_notices(self) -> list[NoticeMessage]:
        return list(self._sticky_notices)
