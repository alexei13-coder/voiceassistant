"""WebSocket-сервер: настоящий клиент websockets на случайном порту."""

from __future__ import annotations

import asyncio
import json
from collections.abc import AsyncIterator, Sequence
from dataclasses import dataclass, field
from typing import Any

import pytest
from conftest import DEV_ORIGIN, TAURI_ORIGIN, TOKEN, open_client, recv_json
from websockets.asyncio.client import connect
from websockets.exceptions import ConnectionClosed, InvalidStatus

from swyvorn.api.ws_server import ClientChannel, WsServer
from swyvorn.bus import EventBus
from swyvorn.config import Settings
from swyvorn.logging_setup import REDACTED, SecretRedactor
from swyvorn.protocol import (
    ClientMessage,
    HelloMessage,
    Hotkeys,
    MetricsMessage,
    NoticeMessage,
    PingMessage,
    PongMessage,
    ProtocolError,
    ServerMessage,
    UiFlags,
)
from swyvorn.state import AssistantState

API_KEY = "sk-ant-api03-NeverSendThisKey123"


def make_hello() -> HelloMessage:
    settings = Settings()
    return HelloMessage(
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


@dataclass
class Harness:
    server: WsServer
    port: int
    bus: EventBus[ServerMessage]
    received: list[ClientMessage] = field(default_factory=list)

    def url(self, path: str = "/ws") -> str:
        return f"ws://127.0.0.1:{self.port}{path}"


async def start_server(*, dev: bool = True, auth_timeout: float = 3.0, **kwargs: Any) -> Harness:
    bus: EventBus[ServerMessage] = EventBus()
    redactor = SecretRedactor()
    redactor.register(TOKEN)
    redactor.register(API_KEY)
    received: list[ClientMessage] = []

    async def handler(message: ClientMessage, client: ClientChannel) -> None:
        received.append(message)
        if isinstance(message, PingMessage):
            client.send(PongMessage())
        else:
            raise ProtocolError("not_allowed", "в тесте поддерживается только ping")

    def snapshot() -> Sequence[ServerMessage]:
        return [make_hello()]

    server = WsServer(
        port=0,
        token=TOKEN,
        dev=dev,
        bus=bus,
        handler=handler,
        snapshot=snapshot,
        auth_timeout=auth_timeout,
        redactor=redactor,
        **kwargs,
    )
    port = await server.start()
    return Harness(server, port, bus, received)


@pytest.fixture
async def harness() -> AsyncIterator[Harness]:
    h = await start_server()
    yield h
    await h.server.close()


async def expect_close(ws: Any, code: int) -> None:
    with pytest.raises(ConnectionClosed) as info:
        async with asyncio.timeout(3):
            while True:
                await ws.recv()
    assert info.value.rcvd is not None
    assert info.value.rcvd.code == code


# ---------- рукопожатие ----------


@pytest.mark.parametrize("origin", ["http://evil.example", "http://localhost:1421", "null", "file://"])
async def test_bad_origin_403(harness: Harness, origin: str) -> None:
    with pytest.raises(InvalidStatus) as info:
        await connect(harness.url(), origin=origin)
    assert info.value.response.status_code == 403


async def test_missing_origin_403(harness: Harness) -> None:
    with pytest.raises(InvalidStatus) as info:
        await connect(harness.url())
    assert info.value.response.status_code == 403


@pytest.mark.parametrize("origin", ["http://tauri.localhost", "https://tauri.localhost", "tauri://localhost"])
async def test_tauri_origins_always_allowed(origin: str) -> None:
    h = await start_server(dev=False)
    try:
        ws = await open_client(h.port, origin=origin)
        assert (await recv_json(ws))["type"] == "hello"
        await ws.close()
    finally:
        await h.server.close()


async def test_dev_origin_only_with_dev_flag() -> None:
    prod = await start_server(dev=False)
    try:
        for origin in (DEV_ORIGIN, "http://127.0.0.1:1420"):
            with pytest.raises(InvalidStatus) as info:
                await connect(prod.url(), origin=origin)
            assert info.value.response.status_code == 403
    finally:
        await prod.server.close()
    dev = await start_server(dev=True)
    try:
        for origin in (DEV_ORIGIN, "http://127.0.0.1:1420"):
            ws = await open_client(dev.port, origin=origin)
            assert (await recv_json(ws))["type"] == "hello"
            await ws.close()
    finally:
        await dev.server.close()


@pytest.mark.parametrize("path", ["/", "/ws/", "/other", "/wss"])
async def test_wrong_path_404(harness: Harness, path: str) -> None:
    with pytest.raises(InvalidStatus) as info:
        await connect(harness.url(path), origin=DEV_ORIGIN)
    assert info.value.response.status_code == 404


async def test_query_string_on_ws_path_is_fine(harness: Harness) -> None:
    ws = await connect(harness.url("/ws?v=1"), origin=TAURI_ORIGIN)
    await ws.send(json.dumps({"type": "auth", "token": TOKEN}))
    assert (await recv_json(ws))["type"] == "hello"
    await ws.close()


async def test_binds_loopback_only(harness: Harness) -> None:
    assert harness.server._server is not None
    hosts = {sock.getsockname()[0] for sock in harness.server._server.sockets}
    assert hosts == {"127.0.0.1"}


# ---------- авторизация ----------


async def test_wrong_token_4401(harness: Harness) -> None:
    ws = await open_client(harness.port, token="wrong-token")
    await expect_close(ws, 4401)


async def test_no_auth_within_timeout_4401() -> None:
    h = await start_server(auth_timeout=0.2)
    try:
        ws = await connect(h.url(), origin=DEV_ORIGIN)
        await expect_close(ws, 4401)
    finally:
        await h.server.close()


@pytest.mark.parametrize(
    "first", ['{"type":"ping"}', "garbage", json.dumps({"type": "auth", "token": TOKEN, "x": 1})]
)
async def test_first_message_must_be_valid_auth(harness: Harness, first: str) -> None:
    ws = await connect(harness.url(), origin=DEV_ORIGIN)
    await ws.send(first)
    await expect_close(ws, 4401)


async def test_good_auth_gets_hello_without_secrets(harness: Harness) -> None:
    ws = await open_client(harness.port)
    raw = await asyncio.wait_for(ws.recv(), 3)
    hello = json.loads(raw)
    assert hello["type"] == "hello"
    for key in ("protocol", "core_version", "state", "demo", "assistant_name", "address_form", "model"):
        assert key in hello
    assert isinstance(hello["ts"], int)
    assert TOKEN not in raw
    assert API_KEY not in raw
    await ws.close()


async def test_fifth_client_4429(harness: Harness) -> None:
    clients = [await open_client(harness.port) for _ in range(4)]
    for ws in clients:
        assert (await recv_json(ws))["type"] == "hello"
    fifth = await open_client(harness.port)
    await expect_close(fifth, 4429)
    # Освободилось место — снова можно подключиться.
    await clients[0].close()
    await asyncio.sleep(0.05)
    again = await open_client(harness.port)
    assert (await recv_json(again))["type"] == "hello"
    for ws in [*clients[1:], again]:
        await ws.close()


# ---------- сообщения ----------


async def test_oversized_message_closes_1009(harness: Harness) -> None:
    ws = await open_client(harness.port)
    await recv_json(ws)
    await ws.send(json.dumps({"type": "send_text", "text": "я" * 40_000}))  # > 64 КиБ в UTF-8
    await expect_close(ws, 1009)


async def test_errors_keep_connection_open(harness: Harness) -> None:
    ws = await open_client(harness.port)
    await recv_json(ws)
    await ws.send("не json")
    assert (await recv_json(ws))["code"] == "bad_message"
    await ws.send('{"type":"teleport"}')
    assert (await recv_json(ws))["code"] == "unknown_type"
    await ws.send('{"type":"ping","extra":1}')
    assert (await recv_json(ws))["code"] == "bad_message"
    await ws.send(b"\x00\x01")
    assert (await recv_json(ws))["code"] == "bad_message"
    await ws.send(json.dumps({"type": "auth", "token": TOKEN}))
    assert (await recv_json(ws))["code"] == "bad_message"
    await ws.send('{"type":"mute","muted":true}')
    assert (await recv_json(ws))["code"] == "not_allowed"
    await ws.send('{"type":"ping"}')
    pong = await recv_json(ws)
    assert pong["type"] == "pong"
    assert isinstance(pong["ts"], int)
    await ws.close()


async def test_broadcast_reaches_all_clients_and_secret_is_cut(harness: Harness) -> None:
    a, b = await open_client(harness.port), await open_client(harness.port)
    await recv_json(a)
    await recv_json(b)
    harness.bus.publish(NoticeMessage(level="info", text=f"утечка {TOKEN} и {API_KEY}"))
    for ws in (a, b):
        notice = await recv_json(ws)
        assert notice["type"] == "notice"
        assert TOKEN not in notice["text"]
        assert API_KEY not in notice["text"]
        assert REDACTED in notice["text"]
    await a.close()
    await b.close()


async def test_disconnected_client_is_removed(harness: Harness) -> None:
    ws = await open_client(harness.port)
    await recv_json(ws)
    assert harness.server.client_count == 1
    await ws.close()
    await asyncio.sleep(0.05)
    assert harness.server.client_count == 0


async def test_close_disconnects_clients() -> None:
    h = await start_server()
    ws = await open_client(h.port)
    await recv_json(ws)
    await h.server.close()
    await expect_close(ws, 1001)


# ---------- очередь медленного клиента ----------


class _FakeConnection:
    remote_address = ("127.0.0.1", 1)

    def __init__(self) -> None:
        self.sent: list[str] = []
        self.closed_with: int | None = None

    async def send(self, text: str) -> None:
        self.sent.append(text)

    async def close(self, code: int, reason: str) -> None:
        self.closed_with = code


def _metrics() -> MetricsMessage:
    return MetricsMessage(
        cpu_percent=1,
        ram_percent=1,
        ram_used_mb=1,
        ram_total_mb=2,
        net_up_bps=0,
        net_down_bps=0,
        uptime_s=0,
        time_iso="2026-01-01T00:00:00+00:00",
    )


async def test_slow_client_drops_telemetry_first_then_disconnects() -> None:
    connection = _FakeConnection()
    client = ClientChannel(connection, lambda m: m.type, limit=3)  # type: ignore[arg-type]
    client.enqueue("metrics-1", droppable=True)
    client.enqueue("state-1", droppable=False)
    client.enqueue("metrics-2", droppable=True)
    client.enqueue("state-2", droppable=False)  # вытесняет metrics-1
    assert client.queued == 3
    client.enqueue("state-3", droppable=False)  # вытесняет metrics-2
    client.enqueue("state-4", droppable=False)  # выбросить нечего → отключение
    await asyncio.wait_for(client.pump(), 1)
    assert connection.sent == []
    assert connection.closed_with == 1013


async def test_pump_sends_in_order() -> None:
    connection = _FakeConnection()
    client = ClientChannel(connection, lambda m: m.type, limit=10)  # type: ignore[arg-type]
    pump = asyncio.create_task(client.pump())
    client.send(_metrics())
    client.enqueue("a", droppable=False)
    client.enqueue("b", droppable=False)
    await asyncio.sleep(0.01)
    assert connection.sent == ["metrics", "a", "b"]
    pump.cancel()
