"""Ядро целиком: Application с настоящим WebSocket, маршрутизация команд, завершение, коды выхода."""

from __future__ import annotations

import asyncio
import io
import json
import logging
import os
import socket
import threading
from pathlib import Path

import pytest
from conftest import TAURI_ORIGIN, TOKEN, open_client, recv_json, recv_until, running_app
from websockets.exceptions import ConnectionClosed

from swyvorn import app as app_module
from swyvorn.api.ws_server import CLOSE_UNAUTHORIZED
from swyvorn.app import run
from swyvorn.cli import CliOptions, ExitCode
from swyvorn.config import DEFAULT_SETTINGS_TOML
from swyvorn.logging_setup import REDACTOR
from swyvorn.platform.elevation import ELEVATED_MESSAGE, check_elevation
from swyvorn.protocol import HotkeyErrorMessage, HotkeyMessage, ShutdownMessage, TrayMessage
from swyvorn.state import AssistantState

S = AssistantState
API_KEY = "sk-ant-api03-IntegrationSecretKey987"


async def test_ready_is_the_only_stdout_line() -> None:
    async with running_app() as core:
        lines = core.stdout_lines()
        assert len(lines) == 1
        assert lines[0]["type"] == "ready"
        assert lines[0]["port"] == core.port
        assert lines[0]["protocol"] == 1
        assert lines[0]["hotkeys"]["stop"] == "Ctrl+Alt+Escape"


async def test_hello_snapshot_and_live_metrics() -> None:
    async with running_app(demo=True) as core:
        ws = await open_client(core.port)
        hello = await recv_json(ws)
        assert hello["type"] == "hello"
        assert hello["demo"] is True
        assert hello["assistant_name"] == "SWYVORN"
        assert hello["wake_word"] == "Свайворн"
        assert hello["ui"] == {"reduced_motion": False}
        metrics = await recv_until(ws, "metrics", within=3)
        assert 0 <= metrics["cpu_percent"] <= 100
        await ws.close()


async def test_send_text_and_stop_over_websocket() -> None:
    async with running_app() as core:
        ws = await open_client(core.port)
        await recv_json(ws)
        await ws.send(json.dumps({"type": "send_text", "text": "  Привет  "}))
        user = await recv_until(ws, "chat_message")
        assert (user["message"]["role"], user["message"]["text"]) == ("user", "Привет")
        await recv_until(ws, "state", state="thinking")
        await ws.send(json.dumps({"type": "stop", "source": "button"}))
        assert (await recv_until(ws, "stopped"))["source"] == "button"
        await recv_until(ws, "state", state="idle")
        await ws.close()


async def test_stale_confirmation_and_not_allowed_keep_connection() -> None:
    async with running_app(demo=False) as core:
        ws = await open_client(core.port)
        await recv_json(ws)
        await ws.send(json.dumps({"type": "confirm", "action_id": "a_x", "nonce": "n", "decision": "yes"}))
        assert (await recv_until(ws, "error"))["code"] == "stale_confirmation"
        await ws.send(json.dumps({"type": "demo", "action": "start"}))
        assert (await recv_until(ws, "error"))["code"] == "not_allowed"
        await ws.send('{"type":"ping"}')
        await recv_until(ws, "pong")
        await ws.close()


async def test_confirmation_flow_over_websocket() -> None:
    async with running_app(demo=True) as core:
        ws = await open_client(core.port)
        await recv_json(ws)
        await ws.send(json.dumps({"type": "demo", "action": "confirmation"}))
        request = (await recv_until(ws, "confirmation_request", within=5))["request"]
        await recv_until(ws, "confirmation_countdown", within=5)

        # Новый клиент видит ожидающее подтверждение в hello, с уже идущим отсчётом.
        late = await open_client(core.port)
        late_hello = await recv_json(late)
        assert late_hello["confirmation"]["action_id"] == request["action_id"]
        assert late_hello["confirmation"]["expires_at"] is not None
        await late.close()

        wrong = {"type": "confirm", "action_id": request["action_id"], "nonce": "bad", "decision": "yes"}
        await ws.send(json.dumps(wrong))
        assert (await recv_until(ws, "error"))["code"] == "stale_confirmation"
        good = {**wrong, "nonce": request["nonce"]}
        await ws.send(json.dumps(good))
        resolved = await recv_until(ws, "confirmation_resolved")
        assert (resolved["outcome"], resolved["via"]) == ("confirmed", "button")
        await recv_until(ws, "state", state="executing")
        await ws.send(json.dumps(good))
        assert (await recv_until(ws, "error"))["code"] == "stale_confirmation"
        await ws.close()


async def test_demo_set_state_for_screenshots() -> None:
    async with running_app(demo=True) as core:
        ws = await open_client(core.port)
        await recv_json(ws)
        await ws.send(json.dumps({"type": "demo", "action": "set_state", "state": "speaking"}))
        await recv_until(ws, "state", state="speaking")
        level = await recv_until(ws, "audio_level")
        assert level["source"] == "tts"
        await ws.close()


async def test_mute_is_broadcast_and_in_hello() -> None:
    async with running_app() as core:
        ws = await open_client(core.port)
        await recv_json(ws)
        await ws.send('{"type":"mute","muted":true}')
        assert (await recv_until(ws, "muted"))["muted"] is True
        other = await open_client(core.port)
        assert (await recv_json(other))["muted"] is True
        await other.close()
        await ws.close()


async def test_shell_hotkeys_and_tray() -> None:
    async with running_app() as core:
        app, rec = core.app, core.rec

        app.handle_shell_message(HotkeyMessage(type="hotkey", action="activate"))
        await rec.wait_type("state", state=S.LISTENING)
        assert core.stdout_lines()[-1] == {"type": "show_window"}

        mark = rec.mark()
        app.handle_shell_message(HotkeyMessage(type="hotkey", action="stop"))
        assert (await rec.wait_type("stopped", start=mark)).source == "hotkey"
        await rec.wait_type("state", state=S.IDLE, start=mark)

        mark = rec.mark()
        app.handle_shell_message(TrayMessage(type="tray", action="stop"))
        assert (await rec.wait_type("stopped", start=mark)).source == "tray"

        app.handle_shell_message(HotkeyMessage(type="hotkey", action="mute_toggle"))
        assert (await rec.wait_type("muted", start=mark)).muted is True
        app.handle_shell_message(TrayMessage(type="tray", action="mute_toggle"))
        assert (await rec.wait_type("muted", start=mark, muted=False)).muted is False

        app.handle_shell_message(HotkeyMessage(type="hotkey", action="repeat"))
        repeat = await rec.wait_type("notice", start=mark)
        assert repeat.text == "Повтор последнего ответа появится на этапе 3"
        mark = rec.mark()
        app.handle_shell_message(HotkeyMessage(type="hotkey", action="screen"))
        assert (await rec.wait_type("notice", start=mark)).text == "Анализ экрана появится на этапе 4"


async def test_push_to_talk_from_shell() -> None:
    async with running_app() as core:
        core.app.handle_shell_message(HotkeyMessage(type="hotkey", action="ptt_down"))
        await core.rec.wait_type("state", state=S.LISTENING)
        await asyncio.sleep(0.05)
        assert core.app.state_machine.state is S.LISTENING
        core.app.handle_shell_message(HotkeyMessage(type="hotkey", action="ptt_up"))
        await core.rec.wait_type("state", state=S.THINKING, within=1)


async def test_hotkey_error_notice_reaches_late_clients() -> None:
    async with running_app() as core:
        error = HotkeyErrorMessage(type="hotkey_error", action="activate", combo="Ctrl+Alt+J", error="busy")
        core.app.handle_shell_message(error)
        ws = await open_client(core.port)
        assert (await recv_json(ws))["type"] == "hello"
        notice = await recv_json(ws)
        assert notice["type"] == "notice"
        assert notice["level"] == "warning"
        assert "Ctrl+Alt+J" in notice["text"]
        assert "вызов ассистента" in notice["text"]
        await ws.close()


async def test_shutdown_message_stops_run_with_code_0() -> None:
    async with running_app() as core:
        core.app.handle_shell_message(ShutdownMessage(type="shutdown"))
        assert await asyncio.wait_for(core.task, 2) == ExitCode.OK


async def test_stdin_eof_triggers_shutdown() -> None:
    stdin = io.BytesIO('{"type":"hotkey","action":"mute_toggle"}\nмусор\n'.encode())
    async with running_app(stdin=stdin) as core:
        assert await asyncio.wait_for(core.task, 2) == ExitCode.OK
        assert core.rec.of_type("muted")[0].muted is True


async def test_port_in_use_exit_4() -> None:
    from swyvorn.api.control import StdoutChannel
    from swyvorn.app import Application
    from swyvorn.config import Settings

    with socket.socket() as busy:
        busy.bind(("127.0.0.1", 0))
        busy.listen()
        port = busy.getsockname()[1]
        stdout = io.BytesIO()
        app = Application(
            options=CliOptions(dev=True, port=port, no_stdin=True),
            settings=Settings(),
            token=TOKEN,
            stdout=StdoutChannel(stdout),
            handle_signals=False,
        )
        assert await app.run() == ExitCode.PORT_UNAVAILABLE == 4
    line = json.loads(stdout.getvalue().decode("utf-8"))
    assert line["type"] == "fatal"
    assert str(port) in line["message"]


# ---------- полный запуск run(): настройки, секреты, логи, коды выхода ----------


@pytest.fixture
def restore_logging(monkeypatch: pytest.MonkeyPatch) -> None:
    import sys
    import threading

    monkeypatch.setattr(sys, "excepthook", sys.excepthook)
    monkeypatch.setattr(threading, "excepthook", threading.excepthook)
    yield
    root = logging.getLogger()
    for handler in [h for h in root.handlers if h.get_name() == "swyvorn"]:
        root.removeHandler(handler)
        handler.close()


@pytest.mark.usefixtures("restore_logging")
def test_full_run_writes_defaults_and_never_leaks_secrets(tmp_path: Path) -> None:
    data = tmp_path / "data"
    data.mkdir()
    (data / ".env").write_text(f"ANTHROPIC_API_KEY={API_KEY}\n", encoding="utf-8")
    stdout = io.BytesIO()
    stdin = io.BytesIO(b'{"type":"shutdown"}\n').read
    environ = {"SWYVORN_IPC_TOKEN": TOKEN}
    code = run(
        CliOptions(port=0, data_dir=data, log_level="DEBUG"),
        environ=environ,
        stdout_stream=stdout,
        stdin=stdin,
    )
    assert code == ExitCode.OK
    lines = stdout.getvalue().decode("utf-8").splitlines()
    assert [json.loads(line)["type"] for line in lines] == ["ready"]
    assert (data / "settings.toml").read_text(encoding="utf-8") == DEFAULT_SETTINGS_TOML
    for handler in logging.getLogger().handlers:
        handler.flush()
    log_text = (data / "logs" / "core.log").read_text(encoding="utf-8")
    # Первая запись сделана ещё до подключения файла (до проверки прав) и всё равно в журнале.
    assert "папка данных" in log_text.splitlines()[0]
    assert "Ядро готово" in log_text
    assert TOKEN not in log_text
    assert API_KEY not in log_text


@pytest.mark.usefixtures("restore_logging")
def test_full_run_without_token_is_fatal(tmp_path: Path) -> None:
    stdout = io.BytesIO()
    code = run(CliOptions(port=0, data_dir=tmp_path, no_stdin=True), environ={}, stdout_stream=stdout)
    assert code == ExitCode.FAILURE
    assert json.loads(stdout.getvalue())["type"] == "fatal"


@pytest.mark.usefixtures("restore_logging")
@pytest.mark.parametrize("existing", [False, True], ids=["no-data-dir", "empty-data-dir"])
def test_full_run_elevated_on_windows_exit_3_writes_nothing(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str], existing: bool
) -> None:
    monkeypatch.setattr(
        app_module,
        "check_elevation",
        lambda stdout: check_elevation(stdout, platform="win32", is_admin=lambda: True),
    )
    stdout = io.BytesIO()
    data = tmp_path / "data"
    if existing:
        data.mkdir()
    options = CliOptions(data_dir=data, no_stdin=True, log_level="DEBUG")
    code = run(options, environ={"SWYVORN_IPC_TOKEN": TOKEN}, stdout_stream=stdout)
    assert code == ExitCode.ELEVATED == 3
    assert json.loads(stdout.getvalue()) == {"type": "fatal", "message": ELEVATED_MESSAGE}
    # Процесс администратора не создал ничего: ни папки данных, ни logs/, ни core.log, ни settings.toml.
    assert [p.relative_to(tmp_path).as_posix() for p in tmp_path.rglob("*")] == (["data"] if existing else [])
    assert "от имени администратора" in capsys.readouterr().err


class _SignallingStdout(io.BytesIO):
    """stdout для run() в другом потоке: сообщает о первой записи (строка пишется одним write)."""

    def __init__(self) -> None:
        super().__init__()
        self.written = threading.Event()

    def write(self, data: bytes) -> int:  # type: ignore[override]
        size = super().write(data)
        self.written.set()
        return size

    async def ready_port(self, within: float = 5.0) -> int:
        assert await asyncio.to_thread(self.written.wait, within), "ядро не прислало ready"
        line = json.loads(self.getvalue().splitlines()[0])
        assert line["type"] == "ready", line
        return int(line["port"])


@pytest.mark.usefixtures("restore_logging")
async def test_full_run_removes_secrets_from_process_environment(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    # Как при запуске из оболочки: токен и ключ приходят в окружении процесса, а не из .env.
    monkeypatch.setenv("SWYVORN_IPC_TOKEN", TOKEN)
    monkeypatch.setenv("ANTHROPIC_API_KEY", API_KEY)
    data = tmp_path / "data"
    stdout = _SignallingStdout()
    release = threading.Event()
    chunks = iter([b'{"type":"shutdown"}\n'])

    def stdin(_size: int) -> bytes:
        # Оболочка молчит, пока тест проверяет ядро, затем присылает shutdown.
        release.wait(10)
        return next(chunks, b"")

    options = CliOptions(port=0, data_dir=data)
    task = asyncio.create_task(asyncio.to_thread(run, options, stdout_stream=stdout, stdin=stdin))
    try:
        port = await stdout.ready_port()
        # Только имена: при падении pytest не должен печатать всё окружение (в CI там секреты).
        leaked = [name for name in ("SWYVORN_IPC_TOKEN", "ANTHROPIC_API_KEY") if name in os.environ]
        assert leaked == []

        # Токен остался в памяти ядра: с ним клиент проходит авторизацию, без него — нет.
        ws = await open_client(port, origin=TAURI_ORIGIN)
        assert (await recv_json(ws))["type"] == "hello"
        await ws.close()
        intruder = await open_client(port, origin=TAURI_ORIGIN, token="wrong-token-000")
        with pytest.raises(ConnectionClosed) as closed:
            await asyncio.wait_for(intruder.recv(), 3)
        assert closed.value.rcvd is not None
        assert closed.value.rcvd.code == CLOSE_UNAUTHORIZED
    finally:
        release.set()
        code = await asyncio.wait_for(task, 5)
    assert code == ExitCode.OK
    for handler in logging.getLogger().handlers:
        handler.flush()
    log_text = (data / "logs" / "core.log").read_text(encoding="utf-8")
    assert "Ключ API: задан" in log_text  # ключ прочитан до того, как его убрали из окружения
    assert API_KEY not in log_text
    assert TOKEN not in log_text


def test_registered_secrets_are_global_for_logs() -> None:
    # Токен из полного запуска зарегистрирован в общем фильтре логов и сообщений протокола.
    REDACTOR.register(TOKEN)
    assert TOKEN not in REDACTOR.redact_values(f"x {TOKEN} y")
