"""Модели сообщений протокола версии 2 (docs/protocol.md) и их (де)сериализация.

Исходящие модели запрещают лишние поля: в сообщение физически нельзя положить то, чего нет
в протоколе (например, секрет). Входящие сообщения UI проверяются строго.
"""

from __future__ import annotations

import json
import time
from collections.abc import Callable
from typing import Annotated, Any, Literal

from pydantic import (
    BaseModel,
    ConfigDict,
    Field,
    StringConstraints,
    TypeAdapter,
    ValidationError,
    model_validator,
)

from .state import AssistantState

PROTOCOL_VERSION = 2

MAX_TOKEN_LENGTH = 256
MAX_TEXT_LENGTH = 4000

# Факты долговременной памяти (docs/brain.md): ключ — snake_case латиницей.
MEMORY_KEY_PATTERN = r"^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$"
MEMORY_KEY_MAX_LENGTH = 40
MEMORY_VALUE_MAX_LENGTH = 200

Risk = Literal["safe", "confirm", "forbidden"]
ChatRole = Literal["user", "assistant", "system"]
ActionStatus = Literal[
    "pending",
    "awaiting_confirmation",
    "running",
    "ok",
    "error",
    "denied",
    "cancelled",
    "timeout",
    "forbidden",
    "stopped",
]
ActionDecision = Literal[
    "auto",
    "confirmed_voice",
    "confirmed_button",
    "confirmed_text",
    "denied",
    "timeout",
    "unclear",
    "forbidden",
    "stopped",
]
ConfirmationOutcome = Literal["confirmed", "denied", "timeout", "cancelled", "stopped", "superseded"]
ConfirmationVia = Literal["voice", "button", "text"]
StopSource = Literal["button", "hotkey", "voice", "tray", "emergency"]
NoticeLevel = Literal["info", "warning", "error"]
AudioSource = Literal["mic", "tts"]
ErrorCode = Literal["unknown_type", "bad_message", "not_allowed", "stale_confirmation", "internal"]
BrainStatus = Literal["ready", "no_key", "invalid_key", "offline", "limit", "demo"]


def now_ms() -> int:
    return time.time_ns() // 1_000_000


class ProtocolError(Exception):
    """Ошибка входящего сообщения; превращается в ответ {"type":"error"}."""

    def __init__(self, code: ErrorCode, message: str) -> None:
        super().__init__(message)
        self.code: ErrorCode = code
        self.message = message


# ---------- типы данных (§1.4) ----------


class _Out(BaseModel):
    model_config = ConfigDict(frozen=True, extra="forbid")


class ChatMessage(_Out):
    id: str
    role: ChatRole
    text: str
    streaming: bool
    created_at: int


class ActionEntry(_Out):
    id: str
    created_at: int
    tool: str
    title: str
    risk: Risk
    status: ActionStatus
    decision: ActionDecision | None = None
    detail: str | None = None
    duration_ms: int | None = None
    demo: bool = False


class ConfirmationRequest(_Out):
    action_id: str
    nonce: str
    title: str
    spoken_text: str
    details: list[str]
    command: str | None = None
    command_language: Literal["powershell"] | None = None
    code_analysis: list[str] = Field(default_factory=list)
    model_explanation: str | None = None
    risk: Literal["confirm"] = "confirm"
    button_only: bool = False
    timeout_ms: int
    expires_at: int | None = None
    demo: bool = False


class Metrics(_Out):
    cpu_percent: float
    ram_percent: float
    ram_used_mb: int
    ram_total_mb: int
    net_up_bps: int
    net_down_bps: int
    uptime_s: int
    time_iso: str


class Hotkeys(_Out):
    activate: str
    stop: str
    stop_fallback: str
    mute: str
    repeat: str
    screen: str


class UiFlags(_Out):
    reduced_motion: bool


class BrainInfo(_Out):
    status: BrainStatus
    model: str
    web_search: bool
    message: str | None = None


class UsageTotals(_Out):
    input_tokens: int = 0
    output_tokens: int = 0
    cache_read_tokens: int = 0
    cache_write_tokens: int = 0
    web_searches: int = 0
    cost_usd: float = 0.0


class MemoryFact(_Out):
    key: str
    value: str
    updated_at: int


class HelloUsage(_Out):
    session: UsageTotals
    month: UsageTotals
    monthly_limit_usd: float


# ---------- ядро → UI (§1.5) ----------


class HelloMessage(_Out):
    type: Literal["hello"] = "hello"
    protocol: Literal[2] = PROTOCOL_VERSION
    core_version: str
    state: AssistantState
    demo: bool
    assistant_name: str
    wake_word: str
    address_form: str
    model: str
    hotkeys: Hotkeys
    ui: UiFlags
    muted: bool
    history: list[ChatMessage]
    actions: list[ActionEntry]
    confirmation: ConfirmationRequest | None
    brain: BrainInfo
    usage: HelloUsage
    memory: list[MemoryFact]


class StateMessage(_Out):
    type: Literal["state"] = "state"
    state: AssistantState
    reason: str | None = None


class AudioLevelMessage(_Out):
    type: Literal["audio_level"] = "audio_level"
    source: AudioSource
    level: float = Field(ge=0.0, le=1.0)


class MetricsMessage(Metrics):
    type: Literal["metrics"] = "metrics"


class ChatMessageMessage(_Out):
    type: Literal["chat_message"] = "chat_message"
    message: ChatMessage


class ChatDeltaMessage(_Out):
    type: Literal["chat_delta"] = "chat_delta"
    id: str
    delta: str


class ChatDoneMessage(_Out):
    type: Literal["chat_done"] = "chat_done"
    id: str


class ActionMessage(_Out):
    type: Literal["action"] = "action"
    entry: ActionEntry


class ConfirmationRequestMessage(_Out):
    type: Literal["confirmation_request"] = "confirmation_request"
    request: ConfirmationRequest


class ConfirmationCountdownMessage(_Out):
    type: Literal["confirmation_countdown"] = "confirmation_countdown"
    action_id: str
    expires_at: int


class ConfirmationResolvedMessage(_Out):
    type: Literal["confirmation_resolved"] = "confirmation_resolved"
    action_id: str
    outcome: ConfirmationOutcome
    via: ConfirmationVia | None = None


class MutedMessage(_Out):
    type: Literal["muted"] = "muted"
    muted: bool


class NoticeMessage(_Out):
    type: Literal["notice"] = "notice"
    level: NoticeLevel
    text: str
    code: str | None = None


class StoppedMessage(_Out):
    type: Literal["stopped"] = "stopped"
    source: StopSource


class BrainStatusMessage(_Out):
    type: Literal["brain_status"] = "brain_status"
    brain: BrainInfo


class UsageMessage(_Out):
    type: Literal["usage"] = "usage"
    session: UsageTotals
    month: UsageTotals
    last_turn: UsageTotals
    monthly_limit_usd: float


class MemoryMessage(_Out):
    type: Literal["memory"] = "memory"
    facts: list[MemoryFact]


class SessionResetMessage(_Out):
    type: Literal["session_reset"] = "session_reset"


class PongMessage(_Out):
    type: Literal["pong"] = "pong"


class ErrorMessage(_Out):
    type: Literal["error"] = "error"
    code: ErrorCode
    message: str


type ServerMessage = (
    HelloMessage
    | StateMessage
    | AudioLevelMessage
    | MetricsMessage
    | ChatMessageMessage
    | ChatDeltaMessage
    | ChatDoneMessage
    | ActionMessage
    | ConfirmationRequestMessage
    | ConfirmationCountdownMessage
    | ConfirmationResolvedMessage
    | MutedMessage
    | NoticeMessage
    | StoppedMessage
    | BrainStatusMessage
    | UsageMessage
    | MemoryMessage
    | SessionResetMessage
    | PongMessage
    | ErrorMessage
)

# Частые «телеметрические» сообщения: их можно выбросить из очереди медленного клиента,
# следующее значение всё равно придёт через долю секунды.
DROPPABLE_TYPES = frozenset({"audio_level", "metrics"})


def encode_server_message(
    message: ServerMessage,
    *,
    ts: int | None = None,
    redact: Callable[[str], str] | None = None,
) -> str:
    """JSON для WebSocket с полем ts (мс epoch). redact — последний рубеж против утечки секрета."""
    data = message.model_dump(mode="json")
    data["ts"] = now_ms() if ts is None else ts
    text = json.dumps(data, ensure_ascii=False, separators=(",", ":"))
    return redact(text) if redact is not None else text


# ---------- UI → ядро (§1.6) ----------


class _In(BaseModel):
    model_config = ConfigDict(frozen=True, extra="forbid", strict=True)


ShortId = Annotated[str, StringConstraints(min_length=1, max_length=128)]


class AuthMessage(_In):
    type: Literal["auth"]
    token: Annotated[str, StringConstraints(min_length=1, max_length=MAX_TOKEN_LENGTH)]


class SendTextMessage(_In):
    type: Literal["send_text"]
    text: Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=MAX_TEXT_LENGTH)]


class ConfirmMessage(_In):
    type: Literal["confirm"]
    action_id: ShortId
    nonce: ShortId
    decision: Literal["yes", "no"]


class StopMessage(_In):
    type: Literal["stop"]
    source: Literal["button"] = "button"


class MicMessage(_In):
    type: Literal["mic"]
    action: Literal["toggle", "ptt_down", "ptt_up"]


class MuteMessage(_In):
    type: Literal["mute"]
    muted: bool


class PingMessage(_In):
    type: Literal["ping"]


DemoAction = Literal["start", "stop", "set_state", "confirmation", "error_flash"]


class DemoMessage(_In):
    type: Literal["demo"]
    action: DemoAction
    state: AssistantState | None = None

    @model_validator(mode="after")
    def _state_for_set_state(self) -> DemoMessage:
        if self.action == "set_state" and self.state is None:
            raise ValueError("для set_state нужно поле state")
        return self


class NewSessionMessage(_In):
    type: Literal["new_session"]


MemoryKey = Annotated[
    str, StringConstraints(min_length=1, max_length=MEMORY_KEY_MAX_LENGTH, pattern=MEMORY_KEY_PATTERN)
]


class MemoryDeleteMessage(_In):
    type: Literal["memory_delete"]
    key: MemoryKey


class MemoryClearMessage(_In):
    type: Literal["memory_clear"]


type ClientMessage = (
    AuthMessage
    | SendTextMessage
    | ConfirmMessage
    | StopMessage
    | MicMessage
    | MuteMessage
    | PingMessage
    | DemoMessage
    | NewSessionMessage
    | MemoryDeleteMessage
    | MemoryClearMessage
)

_CLIENT_ADAPTER: TypeAdapter[ClientMessage] = TypeAdapter(
    Annotated[ClientMessage.__value__, Field(discriminator="type")]
)
CLIENT_MESSAGE_TYPES = frozenset(
    {
        "auth",
        "send_text",
        "confirm",
        "stop",
        "mic",
        "mute",
        "ping",
        "demo",
        "new_session",
        "memory_delete",
        "memory_clear",
    }
)

_ERROR_TEXTS = {
    "missing": "обязательное поле отсутствует",
    "extra_forbidden": "лишнее поле",
    "string_too_short": "пустая или слишком короткая строка",
    "string_too_long": "слишком длинная строка",
    "literal_error": "недопустимое значение",
    "enum": "недопустимое значение",
    "value_error": "недопустимое сочетание полей",
    "string_pattern_mismatch": "недопустимый формат",
}


def _describe_validation_error(exc: ValidationError) -> str:
    """Описание без входных значений: в ответ не должен вернуться ни токен, ни чужой текст."""
    parts: list[str] = []
    for error in exc.errors(include_input=False, include_url=False):
        # Первый элемент loc — тег дискриминатора (тип сообщения), он неинформативен.
        loc = ".".join(str(p) for p in error["loc"][1:]) or "сообщение"
        kind = error["type"]
        text = _ERROR_TEXTS.get(kind, "неверный тип" if kind.endswith("_type") else "неверное значение")
        parts.append(f"{loc}: {text}")
    return "Неверные поля — " + "; ".join(parts[:5])


def _decode_object(raw: str | bytes) -> tuple[dict[str, Any], str]:
    if isinstance(raw, bytes):
        raise ProtocolError("bad_message", "Ожидается текстовое сообщение JSON, получены двоичные данные")
    try:
        data = json.loads(raw)
    except ValueError:
        raise ProtocolError("bad_message", "Сообщение не является корректным JSON") from None
    if not isinstance(data, dict) or not isinstance(data.get("type"), str):
        raise ProtocolError("bad_message", "Сообщение должно быть объектом JSON со строковым полем type")
    return data, data["type"]


def parse_client_message(raw: str | bytes) -> ClientMessage:
    """Разобрать сообщение UI. Ошибки — ProtocolError с кодом unknown_type/bad_message."""
    _, kind = _decode_object(raw)
    if kind not in CLIENT_MESSAGE_TYPES:
        raise ProtocolError("unknown_type", f"Неизвестный тип сообщения: {kind[:64]!r}")
    try:
        # validate_json: в строгом JSON-режиме перечисления принимаются по значению.
        return _CLIENT_ADAPTER.validate_json(raw)
    except ValidationError as exc:
        raise ProtocolError("bad_message", _describe_validation_error(exc)) from None


# ---------- stdio: оболочка ⇄ ядро (§2) ----------


class _ShellIn(BaseModel):
    # Оболочка — доверенный родительский процесс: новые поля в будущих версиях не ломают ядро.
    model_config = ConfigDict(frozen=True, extra="ignore", strict=True)


HotkeyAction = Literal["activate", "ptt_down", "ptt_up", "stop", "mute_toggle", "repeat", "screen"]


class HotkeyMessage(_ShellIn):
    type: Literal["hotkey"]
    action: HotkeyAction


class HotkeyErrorMessage(_ShellIn):
    type: Literal["hotkey_error"]
    action: Annotated[str, StringConstraints(min_length=1, max_length=64)]
    combo: Annotated[str, StringConstraints(max_length=128)]
    error: Annotated[str, StringConstraints(max_length=1000)] = ""


class TrayMessage(_ShellIn):
    type: Literal["tray"]
    action: Literal["stop", "mute_toggle"]


class ShutdownMessage(_ShellIn):
    type: Literal["shutdown"]


type ShellMessage = HotkeyMessage | HotkeyErrorMessage | TrayMessage | ShutdownMessage

_SHELL_ADAPTER: TypeAdapter[ShellMessage] = TypeAdapter(
    Annotated[ShellMessage.__value__, Field(discriminator="type")]
)
SHELL_MESSAGE_TYPES = frozenset({"hotkey", "hotkey_error", "tray", "shutdown"})


def parse_shell_message(line: str) -> ShellMessage:
    _, kind = _decode_object(line)
    if kind not in SHELL_MESSAGE_TYPES:
        raise ProtocolError("unknown_type", f"Неизвестный тип сообщения оболочки: {kind[:64]!r}")
    try:
        return _SHELL_ADAPTER.validate_json(line)
    except ValidationError as exc:
        raise ProtocolError("bad_message", _describe_validation_error(exc)) from None


class ReadyMessage(_Out):
    type: Literal["ready"] = "ready"
    port: int
    protocol: Literal[2] = PROTOCOL_VERSION
    hotkeys: Hotkeys


class ShowWindowMessage(_Out):
    type: Literal["show_window"] = "show_window"


class FatalMessage(_Out):
    type: Literal["fatal"] = "fatal"
    message: str


type CoreToShellMessage = ReadyMessage | ShowWindowMessage | FatalMessage


def encode_shell_message(message: CoreToShellMessage) -> str:
    """Одна строка JSON Lines без завершающего перевода строки."""
    return json.dumps(message.model_dump(mode="json"), ensure_ascii=False, separators=(",", ":"))
