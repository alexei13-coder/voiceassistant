"""stdio-канал Rust-оболочки (docs/protocol.md §2): JSON Lines в UTF-8.

stdin читается в отдельном потоке-демоне: на Windows у asyncio нет неблокирующего чтения
канала stdin, а блокирующее чтение в потоке работает везде одинаково.

Читаем дескриптор напрямую (os.read), а не sys.stdin.buffer: поток, застрявший в
BufferedReader.readline(), держит его блокировку, и при завершении интерпретатора CPython
падает с «could not acquire lock ... possibly due to daemon threads».
"""

from __future__ import annotations

import asyncio
import functools
import logging
import os
import sys
import threading
from collections.abc import Callable, Iterator
from typing import BinaryIO

from ..protocol import (
    CoreToShellMessage,
    FatalMessage,
    Hotkeys,
    ProtocolError,
    ReadyMessage,
    ShellMessage,
    ShowWindowMessage,
    encode_shell_message,
    parse_shell_message,
)

log = logging.getLogger(__name__)

# Строка длиннее — не сообщение оболочки: она отбрасывается целиком.
MAX_LINE_BYTES = 1024 * 1024
READ_CHUNK = 64 * 1024

# Чтение до n байт; b"" — конец потока (как os.read и BinaryIO.read).
ReadChunk = Callable[[int], bytes]


def stdin_reader_source() -> ReadChunk | None:
    """Источник для StdinReader из дескриптора stdin процесса; None — stdin нет."""
    stdin = sys.__stdin__
    if stdin is None:
        return None
    try:
        fd = stdin.fileno()
    except (OSError, ValueError):
        return None
    return functools.partial(os.read, fd)


def iter_lines(read: ReadChunk, *, max_line: int = MAX_LINE_BYTES) -> Iterator[bytes]:
    """Строки без завершающего \n; слишком длинная строка пропускается до следующего \n."""
    pending = bytearray()
    overflow = False
    while chunk := read(READ_CHUNK):
        pending += chunk
        while (end := pending.find(b"\n")) >= 0:
            line = bytes(pending[:end])
            del pending[: end + 1]
            if overflow:
                overflow = False
                log.warning("stdin: отброшена строка длиннее %d байт", max_line)
                continue
            yield line
        if len(pending) > max_line:
            pending.clear()
            overflow = True
    if pending and not overflow:
        yield bytes(pending)


class StdoutChannel:
    """Ядро → оболочка. Пишет байты UTF-8 напрямую: без перекодировки консоли и замены \\n на \\r\\n."""

    def __init__(self, stream: BinaryIO) -> None:
        self._stream = stream
        self._lock = threading.Lock()
        self._closed = False

    def send(self, message: CoreToShellMessage) -> None:
        line = (encode_shell_message(message) + "\n").encode("utf-8")
        with self._lock:
            if self._closed:
                return
            try:
                self._stream.write(line)
                self._stream.flush()
            except (OSError, ValueError) as exc:
                # Оболочка закрыла канал (упала или завершается) — дальше писать некуда.
                self._closed = True
                log.warning("Канал stdout оболочки закрыт: %s", exc)

    def ready(self, port: int, hotkeys: Hotkeys) -> None:
        self.send(ReadyMessage(port=port, hotkeys=hotkeys))

    def show_window(self) -> None:
        self.send(ShowWindowMessage())

    def fatal(self, message: str) -> None:
        self.send(FatalMessage(message=message))


class StdinReader:
    """Оболочка → ядро. Обработчики вызываются в потоке цикла событий."""

    def __init__(
        self,
        read: ReadChunk,
        *,
        loop: asyncio.AbstractEventLoop,
        on_message: Callable[[ShellMessage], None],
        on_eof: Callable[[], None],
    ) -> None:
        self._read = read
        self._loop = loop
        self._on_message = on_message
        self._on_eof = on_eof
        self._thread: threading.Thread | None = None

    def start(self) -> None:
        if self._thread is not None:
            return
        # daemon: поток, застрявший в чтении, не должен задерживать выход процесса.
        self._thread = threading.Thread(target=self._run, name="swyvorn-stdin", daemon=True)
        self._thread.start()

    def _run(self) -> None:
        try:
            for line in iter_lines(self._read):
                if not self._post(self._handle_line, line):
                    return
        except (OSError, ValueError) as exc:
            log.warning("Ошибка чтения stdin: %s", exc)
        # EOF: оболочки больше нет — ядро не должно остаться сиротой.
        self._post(self._on_eof)

    def _post(self, callback: Callable[..., None], *args: object) -> bool:
        try:
            self._loop.call_soon_threadsafe(callback, *args)
        except RuntimeError:
            return False  # цикл событий уже закрыт
        return True

    def _handle_line(self, raw: bytes) -> None:
        line = raw.decode("utf-8", errors="replace").strip()
        if not line:
            return
        try:
            message = parse_shell_message(line)
        except ProtocolError as exc:
            log.warning("stdin: строка проигнорирована (%s): %.200s", exc.message, line)
            return
        log.debug("stdin: %s", message.type)
        self._on_message(message)
