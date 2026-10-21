"""Синтетический уровень голоса во время стрима: не чаще 30 Гц, по словам, с ограниченной очередью."""

from __future__ import annotations

import asyncio
import random

from swyvorn.brain.speech import SpeechLevels
from swyvorn.demo_audio import FRAME_RATE, TTS_PROFILE, SpeechEnvelope


class FakeTime:
    """Часы, которые двигает только sleep; sleep к тому же отдаёт управление циклу."""

    def __init__(self) -> None:
        self.now = 0.0

    def clock(self) -> float:
        return self.now

    async def sleep(self, seconds: float) -> None:
        self.now += seconds
        await asyncio.sleep(0)


def make_levels(published: list[tuple[float, float]], time: FakeTime) -> SpeechLevels:
    envelope = SpeechEnvelope(random.Random(1), TTS_PROFILE)  # noqa: S311 — не криптография
    return SpeechLevels(
        lambda level: published.append((time.now, level)), envelope, clock=time.clock, sleep=time.sleep
    )


async def test_levels_follow_words_and_never_exceed_frame_rate() -> None:
    time = FakeTime()
    published: list[tuple[float, float]] = []
    levels = make_levels(published, time)
    task = asyncio.create_task(levels.run())
    levels.feed("Сейчас в Мос")  # «Мос» — ещё не слово
    for _ in range(200):
        await asyncio.sleep(0)
    first_batch = len(published)
    assert first_batch > 0
    levels.feed("кве плюс двенадцать.")
    levels.flush()
    for _ in range(2000):
        await asyncio.sleep(0)
    task.cancel()
    await asyncio.gather(task, return_exceptions=True)

    assert len(published) > first_batch
    assert all(0.0 <= level <= 1.0 for _, level in published)
    times = [t for t, _ in published]
    gaps = [b - a for a, b in zip(times, times[1:], strict=False)]
    assert min(gaps) >= 1 / FRAME_RATE - 1e-9


async def test_backlog_is_bounded_to_about_a_second() -> None:
    time = FakeTime()
    published: list[tuple[float, float]] = []
    levels = make_levels(published, time)
    # Текст пришёл намного быстрее, чем его можно произнести: старые кадры выбрасываются.
    levels.feed("слово " * 200)
    task = asyncio.create_task(levels.run())
    for _ in range(5000):
        await asyncio.sleep(0)
    task.cancel()
    await asyncio.gather(task, return_exceptions=True)
    assert len(published) == FRAME_RATE


async def test_idle_until_text_arrives() -> None:
    time = FakeTime()
    published: list[tuple[float, float]] = []
    levels = make_levels(published, time)
    task = asyncio.create_task(levels.run())
    for _ in range(50):
        await asyncio.sleep(0)
    assert published == []
    assert time.now == 0.0  # ждёт события, а не крутится по таймеру
    task.cancel()
    await asyncio.gather(task, return_exceptions=True)
