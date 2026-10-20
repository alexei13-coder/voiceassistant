"""Разбор аргументов командной строки ядра (docs/configuration.md)."""

from __future__ import annotations

import argparse
from collections.abc import Sequence
from dataclasses import dataclass
from enum import IntEnum
from pathlib import Path
from typing import Literal, cast

DEV_DEFAULT_PORT = 8765
LOG_LEVELS = ("DEBUG", "INFO", "WARNING", "ERROR")

LogLevel = Literal["DEBUG", "INFO", "WARNING", "ERROR"]


class ExitCode(IntEnum):
    OK = 0
    FAILURE = 1
    BAD_ARGUMENTS = 2
    ELEVATED = 3
    PORT_UNAVAILABLE = 4


@dataclass(frozen=True, slots=True)
class CliOptions:
    dev: bool = False
    port: int = 0
    demo: bool | None = None
    no_stdin: bool = False
    data_dir: Path | None = None
    log_level: LogLevel | None = None


def _port(value: str) -> int:
    try:
        port = int(value)
    except ValueError:
        raise argparse.ArgumentTypeError(f"порт должен быть числом, получено: {value!r}") from None
    if not 0 <= port <= 65535:
        raise argparse.ArgumentTypeError(f"порт должен быть в диапазоне 0..65535, получено: {port}")
    return port


def _log_level(value: str) -> str:
    level = value.strip().upper()
    if level not in LOG_LEVELS:
        raise argparse.ArgumentTypeError(f"уровень должен быть одним из: {', '.join(LOG_LEVELS)}")
    return level


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="python -m jarvis",
        description="Ядро голосового ассистента «Джарвис».",
    )
    parser.add_argument("--dev", action="store_true", help="режим разработки")
    parser.add_argument(
        "--port",
        type=_port,
        default=None,
        help=f"порт WebSocket; 0 — случайный (по умолчанию 0, с --dev — {DEV_DEFAULT_PORT})",
    )
    parser.add_argument(
        "--demo",
        action=argparse.BooleanOptionalAction,
        default=None,
        help="включить или выключить демо-сценарий вместо [demo] enabled",
    )
    parser.add_argument("--no-stdin", action="store_true", help="не слушать управляющий канал stdin")
    parser.add_argument("--data-dir", type=Path, default=None, metavar="PATH", help="папка данных")
    parser.add_argument(
        "--log-level", type=_log_level, default=None, metavar="LEVEL", help="DEBUG | INFO | WARNING | ERROR"
    )
    return parser


def parse_args(argv: Sequence[str] | None = None) -> CliOptions:
    """При ошибке argparse печатает её в stderr и завершает процесс с кодом 2."""
    ns = build_parser().parse_args(argv)
    port = ns.port if ns.port is not None else (DEV_DEFAULT_PORT if ns.dev else 0)
    return CliOptions(
        dev=ns.dev,
        port=port,
        demo=ns.demo,
        no_stdin=ns.no_stdin,
        data_dir=ns.data_dir,
        log_level=cast(LogLevel | None, ns.log_level),
    )
