"""Синтетический уровень голоса, пока печатается ответ Claude: орб «говорит» в такт словам.

Настоящей речи до этапа 3 нет, поэтому уровни строятся огибающей демо (SpeechEnvelope) по
словам, которые пришли из стрима. Текст приходит быстрее, чем его можно было бы произнести:
очередь кадров ограничена, и при отставании старые кадры выбрасываются — пульсация идёт
вместе с новыми словами, а не догоняет их после конца ответа.
"""

from __future__ import annotations

import asyncio
import re
import time
from collections import deque
from collections.abc import Awaitable, Callable

from ..demo_audio import FRAME_RATE, SpeechEnvelope, pause_after

BACKLOG_SECONDS = 1.0
_COMPLETE_WORD_RE = re.compile(r"\S+\s+")


class SpeechLevels:
    def __init__(
        self,
        publish: Callable[[float], None],
        envelope: SpeechEnvelope,
        *,
        frame_rate: float = FRAME_RATE,
        clock: Callable[[], float] = time.perf_counter,
        sleep: Callable[[float], Awaitable[None]] = asyncio.sleep,
    ) -> None:
        self._publish = publish
        self._envelope = envelope
        self._period = 1.0 / frame_rate
        self._clock = clock
        self._sleep = sleep
        self._frames: deque[float] = deque(maxlen=max(1, round(BACKLOG_SECONDS * frame_rate)))
        self._pending = ""
        self._wakeup = asyncio.Event()

    def feed(self, text: str) -> None:
        """Новый кусок ответа; кадры строятся по словам, закончившимся пробелом."""
        self._pending += text
        end = 0
        for match in _COMPLETE_WORD_RE.finditer(self._pending):
            self._add_word(match.group())
            end = match.end()
        self._pending = self._pending[end:]

    def flush(self) -> None:
        """Конец блока текста: последнее слово тоже звучит."""
        if self._pending.strip():
            self._add_word(self._pending)
        self._pending = ""

    def _add_word(self, word: str) -> None:
        self._frames.extend(self._envelope.word(word) + self._envelope.silence(pause_after(word)))
        self._wakeup.set()

    async def run(self) -> None:
        """Отправлять кадры не чаще frame_rate: между двумя кадрами — не меньше периода
        по perf_counter (таймер цикла на Windows может разбудить раньше на 15,6 мс)."""
        last = -self._period
        while True:
            while not self._frames:
                self._wakeup.clear()
                await self._wakeup.wait()
            wait = last + self._period - self._clock()
            if wait > 0:
                await self._sleep(wait)
                continue
            last = self._clock()
            self._publish(self._frames.popleft())
