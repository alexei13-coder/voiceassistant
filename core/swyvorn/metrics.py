"""Метрики системы для HUD: CPU, RAM, сеть, время работы, локальное время — раз в секунду."""

from __future__ import annotations

import asyncio
import logging
import time
from collections.abc import Callable
from datetime import datetime

import psutil

from .protocol import MetricsMessage

log = logging.getLogger(__name__)

SAMPLE_INTERVAL = 1.0
_MB = 1024 * 1024


class MetricsSampler:
    def __init__(
        self,
        publish: Callable[[MetricsMessage], None],
        *,
        interval: float = SAMPLE_INTERVAL,
        started_at: float | None = None,
    ) -> None:
        self._publish = publish
        self._interval = interval
        self._started_at = time.monotonic() if started_at is None else started_at
        self._net_prev: tuple[float, int, int] | None = None
        self._task: asyncio.Task[None] | None = None
        # Первый вызов cpu_percent(None) всегда 0.0 — он лишь задаёт точку отсчёта.
        psutil.cpu_percent(interval=None)
        self._read_net()

    def sample(self) -> MetricsMessage:
        """Снять метрики. Синхронно: на Windows вызовы psutil могут занять миллисекунды,
        поэтому из цикла событий вызывается через поток (см. run())."""
        cpu = float(psutil.cpu_percent(interval=None))
        memory = psutil.virtual_memory()
        # total − available: «занято» так, как это показывает Диспетчер задач.
        used = max(0, memory.total - memory.available)
        up, down = self._read_net()
        return MetricsMessage(
            cpu_percent=round(min(100.0, max(0.0, cpu)), 1),
            ram_percent=round(min(100.0, max(0.0, float(memory.percent))), 1),
            ram_used_mb=round(used / _MB),
            ram_total_mb=round(memory.total / _MB),
            net_up_bps=up,
            net_down_bps=down,
            uptime_s=int(time.monotonic() - self._started_at),
            time_iso=datetime.now().astimezone().isoformat(timespec="seconds"),
        )

    def _read_net(self) -> tuple[int, int]:
        """Скорость сети в байт/с по разнице счётчиков с прошлого замера."""
        try:
            counters = psutil.net_io_counters()
        except (OSError, RuntimeError) as exc:
            log.debug("Счётчики сети недоступны: %s", exc)
            counters = None
        if counters is None:
            self._net_prev = None
            return 0, 0
        now = time.monotonic()
        sent, recv = int(counters.bytes_sent), int(counters.bytes_recv)
        previous, self._net_prev = self._net_prev, (now, sent, recv)
        if previous is None:
            return 0, 0
        prev_time, prev_sent, prev_recv = previous
        elapsed = now - prev_time
        # Счётчик мог обнулиться (переполнение, переподключение адаптера) — этот замер пропускаем.
        if elapsed <= 0 or sent < prev_sent or recv < prev_recv:
            return 0, 0
        return round((sent - prev_sent) / elapsed), round((recv - prev_recv) / elapsed)

    def start(self) -> None:
        if self._task is None:
            self._task = asyncio.get_running_loop().create_task(self.run(), name="metrics")

    async def stop(self) -> None:
        if self._task is not None:
            self._task.cancel()
            await asyncio.gather(self._task, return_exceptions=True)
            self._task = None

    async def run(self) -> None:
        loop = asyncio.get_running_loop()
        next_at = loop.time()
        while True:
            try:
                message = await asyncio.to_thread(self.sample)
            except Exception:
                log.exception("Не удалось снять метрики")
            else:
                self._publish(message)
            # Привязка к сетке времени, чтобы такт не «уплывал» на длительность замера.
            next_at += self._interval
            delay = next_at - loop.time()
            if delay < 0:
                next_at = loop.time()
                delay = 0
            await asyncio.sleep(delay)
