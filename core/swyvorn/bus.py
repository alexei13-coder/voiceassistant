"""Шина событий ядра: рассылка исходящих сообщений подписчикам (WebSocket-клиентам и т.п.).

Подписчики синхронные и обязаны не блокировать: они только кладут событие в свою очередь.
Поэтому publish() никогда не ждёт медленного получателя, а порядок событий сохраняется.
Вызывать только из потока цикла событий asyncio.
"""

from __future__ import annotations

import logging
from collections.abc import Callable

log = logging.getLogger(__name__)


class EventBus[T]:
    def __init__(self) -> None:
        self._subscribers: list[Callable[[T], None]] = []

    def subscribe(self, handler: Callable[[T], None]) -> Callable[[], None]:
        """Подписаться; возвращает функцию отписки (повторный вызов безопасен)."""
        self._subscribers.append(handler)

        def unsubscribe() -> None:
            if handler in self._subscribers:
                self._subscribers.remove(handler)

        return unsubscribe

    def publish(self, event: T) -> None:
        # Копия списка: подписчик может отписаться прямо во время рассылки.
        for handler in tuple(self._subscribers):
            try:
                handler(event)
            except Exception:
                log.exception("Подписчик шины событий упал")

    @property
    def subscriber_count(self) -> int:
        return len(self._subscribers)
