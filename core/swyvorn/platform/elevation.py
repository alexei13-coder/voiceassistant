"""Запрет запуска от имени администратора.

Голосовой ассистент с инструментами не должен получать права администратора «по случайности»:
любое действие, ошибочно выбранное моделью, выполнилось бы без UAC.
"""

from __future__ import annotations

import logging
import os
import sys
from collections.abc import Callable

from ..api.control import StdoutChannel
from ..cli import ExitCode

log = logging.getLogger(__name__)

ELEVATED_MESSAGE = "Ассистент нельзя запускать от имени администратора. Запустите его обычным способом."


def _windows_is_admin() -> bool:
    import ctypes

    try:
        return bool(ctypes.windll.shell32.IsUserAnAdmin())  # type: ignore[attr-defined]
    except (AttributeError, OSError) as exc:
        # Не удалось выяснить — не мешаем запуску, но оставляем след в логе.
        log.warning("Не удалось проверить права администратора: %s", exc)
        return False


def _posix_is_root() -> bool:
    geteuid = getattr(os, "geteuid", None)
    return geteuid is not None and geteuid() == 0


def check_elevation(
    stdout: StdoutChannel,
    *,
    platform: str | None = None,
    is_admin: Callable[[], bool] | None = None,
) -> ExitCode | None:
    """ExitCode.ELEVATED, если запуск запрещён (сообщение fatal уже отправлено оболочке)."""
    if (platform or sys.platform) == "win32":
        if (is_admin or _windows_is_admin)():
            log.error("Ядро запущено от имени администратора — завершаюсь")
            stdout.fatal(ELEVATED_MESSAGE)
            return ExitCode.ELEVATED
        return None
    if (is_admin or _posix_is_root)():
        # Контейнер разработки работает от root; на целевой Windows такой запуск запрещён.
        log.warning("Ядро запущено от root: на Windows запуск с правами администратора запрещён")
    return None
