"""stdio-канал оболочки."""

from __future__ import annotations

import asyncio
import functools
import io
import json
import os

import pytest

from swyvorn.api.control import StdinReader, StdoutChannel, iter_lines
from swyvorn.config import Settings
from swyvorn.protocol import (
    HotkeyErrorMessage,
    HotkeyMessage,
    Hotkeys,
    ShellMessage,
    ShutdownMessage,
    TrayMessage,
)


async def read_all(data: bytes) -> tuple[list[ShellMessage], int]:
    loop = asyncio.get_running_loop()
    messages: list[ShellMessage] = []
    eof = asyncio.Event()
    eof_calls = 0

    def on_eof() -> None:
        nonlocal eof_calls
        eof_calls += 1
        eof.set()

    StdinReader(io.BytesIO(data).read, loop=loop, on_message=messages.append, on_eof=on_eof).start()
    await asyncio.wait_for(eof.wait(), 2)
    await asyncio.sleep(0.01)
    return messages, eof_calls


async def test_parses_hotkeys_and_ignores_garbage(caplog: pytest.LogCaptureFixture) -> None:
    data = "\n".join(
        [
            '{"type":"hotkey","action":"activate"}',
            "мусор, не JSON",
            "",
            "   ",
            '{"type":"hotkey","action":"jump"}',
            '{"type":"teleport"}',
            '{"type":"tray","action":"mute_toggle"}',
            '{"type":"hotkey_error","action":"stop","combo":"Ctrl+Alt+Escape","error":"busy"}',
            '{"type":"shutdown"}',
        ]
    ).encode("utf-8")
    messages, eof_calls = await read_all(data + b"\r\n")
    assert [type(m) for m in messages] == [HotkeyMessage, TrayMessage, HotkeyErrorMessage, ShutdownMessage]
    assert isinstance(messages[0], HotkeyMessage) and messages[0].action == "activate"
    assert eof_calls == 1
    assert "мусор" in caplog.text


async def test_invalid_utf8_line_is_ignored() -> None:
    messages, _ = await read_all(b'\xff\xfe\n{"type":"hotkey","action":"stop"}\n')
    assert len(messages) == 1


async def test_immediate_eof_triggers_shutdown_callback() -> None:
    messages, eof_calls = await read_all(b"")
    assert messages == []
    assert eof_calls == 1


async def test_reads_from_real_pipe_fd() -> None:
    loop = asyncio.get_running_loop()
    received: asyncio.Queue[ShellMessage] = asyncio.Queue()
    eof = asyncio.Event()
    read_fd, write_fd = os.pipe()
    try:
        reader = StdinReader(
            functools.partial(os.read, read_fd), loop=loop, on_message=received.put_nowait, on_eof=eof.set
        )
        reader.start()
        # Строка приходит двумя кусками — склейка по \n.
        os.write(write_fd, b'{"type":"hotkey",')
        os.write(write_fd, b'"action":"ptt_down"}\n{"type":"shutdown"}')
        first = await asyncio.wait_for(received.get(), 2)
        assert isinstance(first, HotkeyMessage) and first.action == "ptt_down"
        os.close(write_fd)
        write_fd = -1
        # Последняя строка без \n тоже доходит, затем EOF.
        assert isinstance(await asyncio.wait_for(received.get(), 2), ShutdownMessage)
        await asyncio.wait_for(eof.wait(), 2)
    finally:
        if write_fd >= 0:
            os.close(write_fd)
        os.close(read_fd)


def test_iter_lines_drops_overlong_line(caplog: pytest.LogCaptureFixture) -> None:
    data = io.BytesIO(b"a" * 50 + b"\nok\n" + b"b" * 10)
    lines = list(iter_lines(lambda n: data.read(5), max_line=20))
    assert lines == [b"ok", b"b" * 10]
    assert "отброшена строка" in caplog.text


def test_stdout_writes_json_lines_utf8() -> None:
    stream = io.BytesIO()
    channel = StdoutChannel(stream)
    channel.ready(4321, Hotkeys.model_validate(Settings().hotkeys.model_dump()))
    channel.show_window()
    channel.fatal("Ассистент нельзя запускать от имени администратора.")
    raw = stream.getvalue()
    assert raw.endswith(b"\n")
    assert b"\r\n" not in raw
    lines = [json.loads(line) for line in raw.decode("utf-8").splitlines()]
    assert [line["type"] for line in lines] == ["ready", "show_window", "fatal"]
    assert lines[0]["port"] == 4321
    assert lines[2]["message"].startswith("Ассистент")


class _BrokenStream(io.BytesIO):
    def write(self, data: bytes) -> int:  # type: ignore[override]
        raise BrokenPipeError("оболочка закрыла канал")


def test_stdout_broken_pipe_is_not_fatal(caplog: pytest.LogCaptureFixture) -> None:
    channel = StdoutChannel(_BrokenStream())
    channel.show_window()
    channel.show_window()
    assert caplog.text.count("Канал stdout оболочки закрыт") == 1
