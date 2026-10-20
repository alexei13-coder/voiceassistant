"""Синтетические уровни звука для демо: огибающая, похожая на речь.

Слоги идут с частотой 4–6 Гц, между словами — паузы, после знаков препинания — длиннее,
поверх — шум. Уровни генерируются кадрами по 1/30 с (FRAME_RATE), скорость воспроизведения
задаёт тот, кто их отправляет.
"""

from __future__ import annotations

import math
import random
import re
from collections.abc import Iterator, Sequence
from dataclasses import dataclass

FRAME_RATE = 30.0

_VOWELS = frozenset("аеёиоуыэюяaeiouy")
_WORD_RE = re.compile(r"\S+\s*")


def split_words(text: str) -> list[str]:
    """Слова вместе с пробелами после них: склеенные обратно, они дают исходный текст."""
    leading = text[: len(text) - len(text.lstrip())]
    words = _WORD_RE.findall(text)
    if leading and words:
        words[0] = leading + words[0]
    return words


def syllable_count(word: str) -> int:
    """В русском слогов столько же, сколько гласных. Тире и прочая пунктуация не звучат."""
    return sum(ch in _VOWELS for ch in word.lower())


def pause_after(word: str) -> float:
    """Пауза после слова в секундах. В беглой речи слова почти сливаются, паузы — у знаков."""
    tail = word.rstrip()[-1:]
    if tail in ".!?…":
        return 0.32
    if tail in ",;:—–":
        return 0.18
    return 0.04


@dataclass(frozen=True, slots=True)
class EnvelopeProfile:
    noise_floor: float  # уровень тишины/фона
    loudness: float  # типичный пик слога
    jitter: float  # относительный шум внутри слога


MIC_PROFILE = EnvelopeProfile(noise_floor=0.05, loudness=0.72, jitter=0.14)
TTS_PROFILE = EnvelopeProfile(noise_floor=0.01, loudness=0.82, jitter=0.06)


def _clamp(value: float) -> float:
    return min(1.0, max(0.0, value))


class SpeechEnvelope:
    def __init__(self, rng: random.Random, profile: EnvelopeProfile) -> None:
        self._rng = rng
        self._profile = profile

    def _noise(self) -> float:
        floor = self._profile.noise_floor
        return abs(self._rng.gauss(floor, floor * 0.4))

    def silence(self, seconds: float) -> list[float]:
        return [round(_clamp(self._noise()), 3) for _ in range(max(0, round(seconds * FRAME_RATE)))]

    def word(self, word: str) -> list[float]:
        """Кадры одного слова: по «горбу» на слог, без провала до тишины внутри слова."""
        rng, p = self._rng, self._profile
        syllables = syllable_count(word)
        rate = rng.uniform(4.0, 6.0)
        frames_per_syllable = max(2, round(FRAME_RATE / rate))
        if syllables == 0:
            if not any(ch.isalnum() for ch in word):
                return []
            # «в», «к», «с» — короткий согласный звук без гласной.
            syllables, frames_per_syllable = 1, max(2, frames_per_syllable // 2)
        gain = p.loudness * rng.uniform(0.75, 1.0)
        frames: list[float] = []
        for index in range(syllables):
            # Ударный слог громче, к концу слова голос немного затихает.
            peak = gain * rng.uniform(0.7, 1.0) * (0.85 if index == syllables - 1 and syllables > 1 else 1.0)
            for k in range(frames_per_syllable):
                shape = math.sin(math.pi * (k + 0.5) / frames_per_syllable) ** 0.7
                level = self._noise() + peak * (0.3 + 0.7 * shape) * (1.0 + rng.gauss(0.0, p.jitter))
                frames.append(round(_clamp(level), 3))
        return frames

    def utterance(self, words: Sequence[str]) -> list[float]:
        frames: list[float] = []
        for word in words:
            frames += self.word(word)
            frames += self.silence(pause_after(word) * self._rng.uniform(0.8, 1.25))
        return frames

    def stream(self, phrase: str | None, *, lead_in: float = 0.35) -> Iterator[float]:
        """Бесконечный поток: тишина, фраза (или случайная «речь», если фразы нет), затем фон."""
        yield from self.silence(lead_in)
        if phrase is not None:
            yield from self.utterance(split_words(phrase))
            while True:
                yield from self.silence(1.0)
        while True:
            words = self._rng.sample(_BABBLE, k=self._rng.randint(3, 6))
            words[-1] += self._rng.choice((".", ",", ""))
            yield from self.utterance(words)


# Словарь для «речи» без текста (удержание клавиши, демо-состояние для скриншотов).
_BABBLE = (
    "открой",
    "пожалуйста",
    "почту",
    "напомни",
    "мне",
    "через",
    "десять",
    "минут",
    "про",
    "встречу",
    "сегодня",
    "вечером",
    "найди",
    "файл",
)
