"""Долговременная память о пользователе: <папка данных>/memory.json (docs/brain.md).

Факты меняют и модель (инструменты remember/forget), и пользователь из HUD (memory_delete,
memory_clear). Каждое изменение — чтение-изменение-запись под одной блокировкой: методы
синхронные, поэтому атомарны и для корутин одного цикла, и для потоков. Состояние в памяти
меняется только после успешной записи на диск — иначе HUD показал бы то, чего нет в файле.
"""

from __future__ import annotations

import logging
import re
import threading
from collections.abc import Callable
from pathlib import Path
from typing import Any

from ..protocol import (
    MEMORY_KEY_MAX_LENGTH,
    MEMORY_KEY_PATTERN,
    MEMORY_VALUE_MAX_LENGTH,
    MemoryFact,
    now_ms,
)
from .storage import CorruptedFileError, quarantine, read_json, write_json_atomic

log = logging.getLogger(__name__)

FILE_VERSION = 1
MAX_FACTS = 50

# Особые ключи (docs/brain.md) и их подписи для журнала действий.
ADDRESS_FORM = "address_form"
USER_NAME = "user_name"
CITY = "city"
KEY_LABELS = {ADDRESS_FORM: "обращение", USER_NAME: "имя", CITY: "город"}

_KEY_RE = re.compile(MEMORY_KEY_PATTERN)

ChangeListener = Callable[[list[MemoryFact]], None]


class MemoryUpdateError(Exception):
    """Изменение отклонено; текст — для модели и журнала действий, по-русски."""


def normalize_key(key: str) -> str:
    """Проверить ключ. ValueError — не snake_case латиницей или длиннее 40 символов."""
    if len(key) > MEMORY_KEY_MAX_LENGTH or not _KEY_RE.match(key):
        raise ValueError(f"ключ должен быть snake_case латиницей до {MEMORY_KEY_MAX_LENGTH} символов")
    return key


def normalize_value(value: str) -> str:
    """Схлопнуть пробелы и переводы строк: значение попадает в контекст одной строкой
    и не может «начать» в нём новый пункт."""
    text = " ".join(value.split())
    if not text:
        raise ValueError("значение не может быть пустым")
    if len(text) > MEMORY_VALUE_MAX_LENGTH:
        raise ValueError(f"значение длиннее {MEMORY_VALUE_MAX_LENGTH} символов")
    return text


def key_label(key: str) -> str:
    return KEY_LABELS.get(key, key)


class MemoryStore:
    def __init__(self, path: Path, *, clock: Callable[[], int] = now_ms) -> None:
        self._path = path
        self._clock = clock
        self._lock = threading.Lock()
        self._facts: dict[str, MemoryFact] = {}
        self._listeners: list[ChangeListener] = []

    def add_listener(self, listener: ChangeListener) -> None:
        self._listeners.append(listener)

    # ---------- чтение ----------

    def load(self) -> CorruptedFileError | None:
        """Прочитать файл при запуске. Испорченный откладывается в сторону — возвращается
        описание, чтобы показать пользователю предупреждение."""
        try:
            data = read_json(self._path)
        except CorruptedFileError as exc:
            self._facts = {}
            return exc
        facts, problem = _parse(data)
        if problem is not None:
            self._facts = {}
            return quarantine(self._path, problem)
        self._facts = facts
        log.info("Память: фактов %d", len(facts))
        return None

    def facts(self) -> list[MemoryFact]:
        """Факты в порядке появления — так их видит и модель, и HUD."""
        with self._lock:
            return list(self._facts.values())

    def get(self, key: str) -> str | None:
        with self._lock:
            fact = self._facts.get(key)
        return fact.value if fact is not None else None

    # ---------- изменения ----------

    def remember(self, key: str, value: str) -> MemoryFact | None:
        """Создать или заменить факт. Возвращает прежний факт (None — новый).
        MemoryUpdateError — неверные данные, память заполнена или файл не записался."""
        try:
            key, value = normalize_key(key), normalize_value(value)
        except ValueError as exc:
            raise MemoryUpdateError(f"Факт не сохранён: {exc}.") from None
        with self._lock:
            previous = self._facts.get(key)
            if previous is None and len(self._facts) >= MAX_FACTS:
                raise MemoryUpdateError(
                    f"Память заполнена ({MAX_FACTS} фактов) — новый факт не сохранён. "
                    "Предложи пользователю удалить ненужное."
                )
            updated = dict(self._facts)
            # Заменённый факт остаётся на своём месте: порядок в HUD не прыгает.
            updated[key] = MemoryFact(key=key, value=value, updated_at=self._clock())
            self._commit(updated)
        self._notify()
        return previous

    def forget(self, key: str) -> MemoryFact | None:
        """Удалить факт; None — такого не было (это не ошибка)."""
        with self._lock:
            previous = self._facts.get(key)
            if previous is None:
                return None
            updated = {k: v for k, v in self._facts.items() if k != key}
            self._commit(updated)
        self._notify()
        return previous

    def clear(self) -> int:
        """Удалить всё; возвращает число удалённых фактов."""
        with self._lock:
            count = len(self._facts)
            if count == 0:
                return 0
            self._commit({})
        self._notify()
        return count

    def _commit(self, facts: dict[str, MemoryFact]) -> None:
        payload = {"version": FILE_VERSION, "facts": [fact.model_dump() for fact in facts.values()]}
        try:
            write_json_atomic(self._path, payload)
        except OSError as exc:
            log.error("Не удалось сохранить память в %s: %s", self._path, exc)
            raise MemoryUpdateError("Не удалось сохранить память на диск — изменение не применено.") from None
        self._facts = facts

    def _notify(self) -> None:
        facts = self.facts()
        for listener in tuple(self._listeners):
            try:
                listener(facts)
            except Exception:
                log.exception("Слушатель памяти упал")


def _parse(data: Any) -> tuple[dict[str, MemoryFact], str | None]:
    """Факты из содержимого файла. Ошибка формата целиком — причина для карантина;
    отдельные неверные факты просто отбрасываются (их уже не исправить)."""
    if data is None:
        return {}, None
    if not isinstance(data, dict) or data.get("version") != FILE_VERSION:
        return {}, "неизвестный формат"
    raw_facts = data.get("facts")
    if not isinstance(raw_facts, list):
        return {}, "нет списка facts"
    facts: dict[str, MemoryFact] = {}
    dropped = 0
    for raw in raw_facts:
        try:
            if not isinstance(raw, dict) or not isinstance(raw.get("updated_at"), int):
                raise ValueError("неверная запись")
            key = normalize_key(str(raw["key"]))
            value = normalize_value(str(raw["value"]))
        except (KeyError, ValueError):
            dropped += 1
            continue
        facts.pop(key, None)  # повтор ключа: побеждает последняя запись
        facts[key] = MemoryFact(key=key, value=value, updated_at=raw["updated_at"])
    if len(facts) > MAX_FACTS:
        dropped += len(facts) - MAX_FACTS
        newest = sorted(facts.values(), key=lambda f: f.updated_at)[-MAX_FACTS:]
        keep = {f.key for f in newest}
        facts = {k: v for k, v in facts.items() if k in keep}
    if dropped:
        log.warning("Память: пропущено неверных или лишних записей: %d", dropped)
    return facts, None
