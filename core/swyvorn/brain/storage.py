"""Файлы данных «мозга» (memory.json, usage.json): атомарная запись и карантин испорченных.

Запись через временный файл в той же папке и os.replace: при сбое питания или падении ядра
на диске остаётся либо старая, либо новая версия, но никогда не половина файла.
"""

from __future__ import annotations

import contextlib
import json
import logging
import os
import tempfile
from collections.abc import Callable
from datetime import datetime
from pathlib import Path
from typing import Any

log = logging.getLogger(__name__)


class CorruptedFileError(Exception):
    """Файл есть, но прочитать его нельзя; копия уже сохранена в backup."""

    def __init__(self, path: Path, backup: Path | None, reason: str) -> None:
        super().__init__(f"{path.name}: {reason}")
        self.path = path
        self.backup = backup
        self.reason = reason


def write_json_atomic(path: Path, data: Any) -> None:
    """Записать JSON целиком или не записать вовсе. OSError — запись не удалась, файл прежний."""
    path.parent.mkdir(parents=True, exist_ok=True)
    text = json.dumps(data, ensure_ascii=False, indent=2, sort_keys=True) + "\n"
    fd, tmp_name = tempfile.mkstemp(prefix=f".{path.name}.", suffix=".tmp", dir=path.parent)
    tmp = Path(tmp_name)
    try:
        with os.fdopen(fd, "w", encoding="utf-8", newline="\n") as file:
            file.write(text)
            file.flush()
            # Без fsync после сбоя питания можно получить новое имя с пустым содержимым.
            os.fsync(file.fileno())
        os.replace(tmp, path)
    except BaseException:
        with contextlib.suppress(OSError):
            tmp.unlink()
        raise


def read_json(path: Path, *, now: Callable[[], datetime] = datetime.now) -> Any | None:
    """Прочитать JSON. None — файла нет. Испорченный файл переименовывается в
    <имя>.bak-<время> и выбрасывается CorruptedFileError: пользователь ничего не теряет,
    а ядро продолжает с пустыми данными."""
    try:
        raw = path.read_bytes()
    except FileNotFoundError:
        return None
    try:
        return json.loads(raw.decode("utf-8-sig"))
    except (UnicodeDecodeError, ValueError) as exc:
        raise quarantine(path, f"не JSON ({type(exc).__name__})", now=now) from None


def quarantine(path: Path, reason: str, *, now: Callable[[], datetime] = datetime.now) -> CorruptedFileError:
    """Отложить испорченный файл в сторону; возвращает исключение для вызывающего."""
    stamp = now().strftime("%Y%m%d-%H%M%S")
    backup = path.with_name(f"{path.name}.bak-{stamp}")
    suffix = 1
    while backup.exists():
        suffix += 1
        backup = path.with_name(f"{path.name}.bak-{stamp}-{suffix}")
    try:
        os.replace(path, backup)
    except OSError as exc:
        log.error("Не удалось отложить испорченный %s: %s", path, exc)
        return CorruptedFileError(path, None, reason)
    log.warning("Файл %s испорчен (%s) — сохранён как %s, начинаю с пустого", path.name, reason, backup.name)
    return CorruptedFileError(path, backup, reason)
