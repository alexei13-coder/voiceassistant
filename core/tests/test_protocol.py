from __future__ import annotations

import json

import pytest

from jarvis.config import Settings
from jarvis.protocol import (
    AuthMessage,
    ConfirmMessage,
    DemoMessage,
    HelloMessage,
    HotkeyErrorMessage,
    HotkeyMessage,
    Hotkeys,
    MicMessage,
    MuteMessage,
    PingMessage,
    ProtocolError,
    ReadyMessage,
    SendTextMessage,
    ShutdownMessage,
    StateMessage,
    StopMessage,
    TrayMessage,
    UiFlags,
    encode_server_message,
    encode_shell_message,
    parse_client_message,
    parse_shell_message,
)
from jarvis.state import AssistantState


def parse(obj: object) -> object:
    return parse_client_message(json.dumps(obj, ensure_ascii=False))


def protocol_error(raw: str | bytes) -> ProtocolError:
    with pytest.raises(ProtocolError) as info:
        parse_client_message(raw)
    return info.value


@pytest.mark.parametrize(
    ("message", "model"),
    [
        ({"type": "auth", "token": "abc"}, AuthMessage),
        ({"type": "send_text", "text": "привет"}, SendTextMessage),
        ({"type": "confirm", "action_id": "a_1", "nonce": "n", "decision": "yes"}, ConfirmMessage),
        ({"type": "stop", "source": "button"}, StopMessage),
        ({"type": "mic", "action": "ptt_down"}, MicMessage),
        ({"type": "mute", "muted": True}, MuteMessage),
        ({"type": "ping"}, PingMessage),
        ({"type": "demo", "action": "start"}, DemoMessage),
        ({"type": "demo", "action": "set_state", "state": "speaking"}, DemoMessage),
    ],
)
def test_valid_client_messages(message: dict[str, object], model: type) -> None:
    assert isinstance(parse(message), model)


def test_demo_state_is_enum() -> None:
    message = parse({"type": "demo", "action": "set_state", "state": "awaiting_confirmation"})
    assert isinstance(message, DemoMessage)
    assert message.state is AssistantState.AWAITING_CONFIRMATION


def test_send_text_is_stripped() -> None:
    message = parse({"type": "send_text", "text": "  да  \n"})
    assert isinstance(message, SendTextMessage)
    assert message.text == "да"


def test_send_text_limits() -> None:
    assert isinstance(parse({"type": "send_text", "text": "я" * 4000}), SendTextMessage)
    assert protocol_error(json.dumps({"type": "send_text", "text": "я" * 4001})).code == "bad_message"
    assert protocol_error(json.dumps({"type": "send_text", "text": ""})).code == "bad_message"
    assert protocol_error(json.dumps({"type": "send_text", "text": " \t\n "})).code == "bad_message"


@pytest.mark.parametrize(
    "message",
    [
        {"type": "auth", "token": "abc", "extra": 1},
        {"type": "ping", "x": None},
        {"type": "stop", "source": "button", "force": True},
        {"type": "confirm", "action_id": "a", "nonce": "n", "decision": "yes", "via": "voice"},
    ],
)
def test_extra_fields_rejected(message: dict[str, object]) -> None:
    error = protocol_error(json.dumps(message))
    assert error.code == "bad_message"
    assert "лишнее поле" in error.message


@pytest.mark.parametrize(
    "message",
    [
        {"type": "auth"},
        {"type": "auth", "token": ""},
        {"type": "auth", "token": "t" * 257},
        {"type": "mute", "muted": "true"},
        {"type": "mute", "muted": 1},
        {"type": "mic", "action": "hold"},
        {"type": "stop", "source": "hotkey"},
        {"type": "confirm", "action_id": "a", "nonce": "n", "decision": "maybe"},
        {"type": "demo", "action": "set_state"},
        {"type": "demo", "action": "set_state", "state": "dancing"},
        {"type": "demo", "action": "explode"},
    ],
)
def test_invalid_fields_rejected(message: dict[str, object]) -> None:
    assert protocol_error(json.dumps(message)).code == "bad_message"


@pytest.mark.parametrize(
    "raw",
    ["не json", "[]", '"auth"', "{}", '{"type": 5}', b'{"type":"ping"}'],
)
def test_malformed_input(raw: str | bytes) -> None:
    assert protocol_error(raw).code == "bad_message"


def test_unknown_type() -> None:
    error = protocol_error('{"type": "format_disk"}')
    assert error.code == "unknown_type"
    assert "format_disk" in error.message


def test_error_message_never_echoes_input() -> None:
    secret = "super-secret-token-value"
    error = protocol_error(json.dumps({"type": "auth", "token": secret, "nope": secret}))
    assert secret not in error.message


def test_encode_adds_ts_and_redacts() -> None:
    text = encode_server_message(StateMessage(state=AssistantState.IDLE), ts=123)
    assert json.loads(text) == {"type": "state", "state": "idle", "reason": None, "ts": 123}
    redacted = encode_server_message(StateMessage(state=AssistantState.IDLE, reason="xx"), redact=str.upper)
    assert '"XX"' in redacted


def test_encode_ts_is_current_ms() -> None:
    import time

    ts = json.loads(encode_server_message(StateMessage(state=AssistantState.IDLE)))["ts"]
    assert isinstance(ts, int)
    assert abs(ts - time.time() * 1000) < 5000


def test_hello_has_every_contract_field() -> None:
    settings = Settings()
    hello = HelloMessage(
        core_version="0.1.0",
        state=AssistantState.IDLE,
        demo=True,
        assistant_name=settings.assistant.name,
        address_form=settings.assistant.address_form,
        model=settings.llm.model,
        hotkeys=Hotkeys.model_validate(settings.hotkeys.model_dump()),
        ui=UiFlags(reduced_motion=False),
        muted=False,
        history=[],
        actions=[],
        confirmation=None,
    )
    data = json.loads(encode_server_message(hello))
    assert set(data) == {
        "type", "ts", "protocol", "core_version", "state", "demo", "assistant_name", "address_form",
        "model", "hotkeys", "ui", "muted", "history", "actions", "confirmation",
    }  # fmt: skip
    assert data["protocol"] == 1
    assert set(data["hotkeys"]) == {"activate", "stop", "stop_fallback", "mute", "repeat", "screen"}


# ---------- stdio ----------


@pytest.mark.parametrize(
    ("line", "model"),
    [
        ('{"type":"hotkey","action":"activate"}', HotkeyMessage),
        ('{"type":"hotkey","action":"mute_toggle","future_field":1}', HotkeyMessage),
        (
            '{"type":"hotkey_error","action":"stop","combo":"Ctrl+Alt+Esc","error":"занято"}',
            HotkeyErrorMessage,
        ),
        ('{"type":"tray","action":"stop"}', TrayMessage),
        ('{"type":"shutdown"}', ShutdownMessage),
    ],
)
def test_shell_messages(line: str, model: type) -> None:
    assert isinstance(parse_shell_message(line), model)


@pytest.mark.parametrize(
    "line",
    ['{"type":"hotkey","action":"fly"}', '{"type":"tray"}', '{"type":"reboot"}', "мусор", "[1,2]"],
)
def test_bad_shell_messages(line: str) -> None:
    with pytest.raises(ProtocolError):
        parse_shell_message(line)


def test_ready_line() -> None:
    hotkeys = Hotkeys.model_validate(Settings().hotkeys.model_dump())
    line = encode_shell_message(ReadyMessage(port=1234, hotkeys=hotkeys))
    assert "\n" not in line
    data = json.loads(line)
    assert data["type"] == "ready"
    assert data["port"] == 1234
    assert data["protocol"] == 1
    assert data["hotkeys"]["activate"] == "Ctrl+Alt+J"
    assert "ts" not in data
