from __future__ import annotations

import io
import json

import pytest

from swyvorn.api.control import StdoutChannel
from swyvorn.cli import ExitCode
from swyvorn.platform.elevation import ELEVATED_MESSAGE, check_elevation


def test_windows_admin_is_refused() -> None:
    stream = io.BytesIO()
    code = check_elevation(StdoutChannel(stream), platform="win32", is_admin=lambda: True)
    assert code == ExitCode.ELEVATED == 3
    line = json.loads(stream.getvalue().decode("utf-8"))
    assert line == {"type": "fatal", "message": ELEVATED_MESSAGE}
    assert ELEVATED_MESSAGE == (
        "Ассистент нельзя запускать от имени администратора. Запустите его обычным способом."
    )


def test_windows_normal_user_is_allowed() -> None:
    stream = io.BytesIO()
    assert check_elevation(StdoutChannel(stream), platform="win32", is_admin=lambda: False) is None
    assert stream.getvalue() == b""


def test_windows_check_uses_shell32(monkeypatch: pytest.MonkeyPatch) -> None:
    import ctypes

    calls: list[str] = []

    class Shell32:
        def IsUserAnAdmin(self) -> int:
            calls.append("IsUserAnAdmin")
            return 1

    monkeypatch.setattr(ctypes, "windll", type("WinDLL", (), {"shell32": Shell32()})(), raising=False)
    stream = io.BytesIO()
    assert check_elevation(StdoutChannel(stream), platform="win32") == ExitCode.ELEVATED
    assert calls == ["IsUserAnAdmin"]


def test_non_windows_root_only_warns(caplog: pytest.LogCaptureFixture) -> None:
    stream = io.BytesIO()
    assert check_elevation(StdoutChannel(stream), platform="linux", is_admin=lambda: True) is None
    assert stream.getvalue() == b""
    assert "root" in caplog.text
