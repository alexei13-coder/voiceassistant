"""Точка входа: python -m jarvis."""

from __future__ import annotations

import contextlib
import sys
from collections.abc import Sequence

from .app import run
from .cli import ExitCode, parse_args


def _prepare_stderr() -> None:
    # Логи и сообщения разработчику — в UTF-8 независимо от кодовой страницы консоли Windows.
    # stdout не трогаем: канал оболочки пишет байты UTF-8 сам.
    reconfigure = getattr(sys.stderr, "reconfigure", None)
    if reconfigure is not None:
        with contextlib.suppress(OSError, ValueError):
            reconfigure(encoding="utf-8", errors="backslashreplace")


def main(argv: Sequence[str] | None = None) -> int:
    _prepare_stderr()
    try:
        options = parse_args(argv)
    except SystemExit as exc:
        # argparse: 0 после --help, 2 при ошибке аргументов.
        return exc.code if isinstance(exc.code, int) else ExitCode.BAD_ARGUMENTS
    return run(options)


if __name__ == "__main__":
    raise SystemExit(main())
