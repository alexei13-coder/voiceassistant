"""WebSocket для UI (docs/protocol.md §1.1): 127.0.0.1, проверка Origin, токен, лимиты.

У каждого клиента своя ограниченная очередь отправки: медленный клиент не тормозит ядро.
При переполнении сначала выбрасываются устаревшие audio_level/metrics; если и это не помогло,
клиент отключается (1013) — UI переподключится и получит свежий снимок hello.
"""

from __future__ import annotations

import asyncio
import hmac
import logging
from collections import deque
from collections.abc import Awaitable, Callable, Sequence
from http import HTTPStatus
from urllib.parse import urlsplit

from websockets.asyncio.server import Server, ServerConnection, serve
from websockets.datastructures import Headers
from websockets.exceptions import ConnectionClosed
from websockets.http11 import Request, Response

from ..bus import EventBus
from ..logging_setup import REDACTOR, SecretRedactor
from ..protocol import (
    DROPPABLE_TYPES,
    AuthMessage,
    ClientMessage,
    ErrorMessage,
    ProtocolError,
    ServerMessage,
    encode_server_message,
    parse_client_message,
)

log = logging.getLogger(__name__)

HOST = "127.0.0.1"
WS_PATH = "/ws"
ALLOWED_ORIGINS = frozenset({"http://tauri.localhost", "https://tauri.localhost", "tauri://localhost"})
DEV_ORIGINS = frozenset({"http://localhost:1420", "http://127.0.0.1:1420"})

AUTH_TIMEOUT = 3.0
MAX_CLIENTS = 4
MAX_MESSAGE_SIZE = 64 * 1024
SEND_QUEUE_LIMIT = 512

CLOSE_UNAUTHORIZED = 4401
CLOSE_TOO_MANY_CLIENTS = 4429
CLOSE_TRY_AGAIN_LATER = 1013

MessageHandler = Callable[[ClientMessage, "ClientChannel"], Awaitable[None]]
SnapshotProvider = Callable[[], Sequence[ServerMessage]]


def _tokens_equal(a: str, b: str) -> bool:
    return hmac.compare_digest(a.encode("utf-8"), b.encode("utf-8"))


class ClientChannel:
    """Исходящая очередь одного авторизованного клиента."""

    def __init__(
        self, connection: ServerConnection, encode: Callable[[ServerMessage], str], limit: int
    ) -> None:
        self._connection = connection
        self._encode = encode
        self._limit = limit
        self._queue: deque[tuple[bool, str]] = deque()
        self._wakeup = asyncio.Event()
        self._overflowed = False

    @property
    def queued(self) -> int:
        return len(self._queue)

    def send(self, message: ServerMessage) -> None:
        """Ответ только этому клиенту (pong, error)."""
        self.enqueue(self._encode(message), droppable=message.type in DROPPABLE_TYPES)

    def enqueue(self, text: str, *, droppable: bool) -> None:
        if self._overflowed:
            return
        if len(self._queue) >= self._limit and not self._drop_stale():
            # Терять chat_delta/state нельзя — снимок разошёлся бы с ядром. Лучше переподключение.
            self._overflowed = True
            log.warning(
                "WS-клиент %s не успевает получать события — отключаю", self._connection.remote_address
            )
        else:
            self._queue.append((droppable, text))
        self._wakeup.set()

    def _drop_stale(self) -> bool:
        for index, (droppable, _) in enumerate(self._queue):
            if droppable:
                del self._queue[index]
                return True
        return False

    async def pump(self) -> None:
        """Отправлять очередь по порядку, пока соединение живо."""
        while True:
            while not self._queue and not self._overflowed:
                self._wakeup.clear()
                await self._wakeup.wait()
            if self._overflowed:
                await self._connection.close(CLOSE_TRY_AGAIN_LATER, "client too slow")
                return
            _, text = self._queue.popleft()
            await self._connection.send(text)


class WsServer:
    def __init__(
        self,
        *,
        port: int,
        token: str,
        dev: bool,
        bus: EventBus[ServerMessage],
        handler: MessageHandler,
        snapshot: SnapshotProvider,
        host: str = HOST,
        auth_timeout: float = AUTH_TIMEOUT,
        max_clients: int = MAX_CLIENTS,
        max_message_size: int = MAX_MESSAGE_SIZE,
        send_queue_limit: int = SEND_QUEUE_LIMIT,
        redactor: SecretRedactor = REDACTOR,
    ) -> None:
        self._host = host
        self._port = port
        self._token = token
        self._origins = ALLOWED_ORIGINS | DEV_ORIGINS if dev else ALLOWED_ORIGINS
        self._bus = bus
        self._handler = handler
        self._snapshot = snapshot
        self._auth_timeout = auth_timeout
        self._max_clients = max_clients
        self._max_message_size = max_message_size
        self._send_queue_limit = send_queue_limit
        self._redactor = redactor
        self._clients: set[ClientChannel] = set()
        self._server: Server | None = None
        self._unsubscribe: Callable[[], None] | None = None

    @property
    def client_count(self) -> int:
        return len(self._clients)

    async def start(self) -> int:
        """Начать слушать. Возвращает фактический порт; OSError — порт недоступен."""
        self._server = await serve(
            self._handle,
            self._host,
            self._port,
            process_request=self._process_request,
            max_size=self._max_message_size,
            compression=None,
            server_header=None,
            open_timeout=5,
            close_timeout=2,
        )
        port = int(self._server.sockets[0].getsockname()[1])
        self._unsubscribe = self._bus.subscribe(self._broadcast)
        return port

    async def close(self, grace: float = 1.5) -> None:
        if self._unsubscribe is not None:
            self._unsubscribe()
            self._unsubscribe = None
        if self._server is None:
            return
        self._server.close()
        try:
            async with asyncio.timeout(grace):
                await self._server.wait_closed()
        except TimeoutError:
            log.warning("WebSocket-сервер не закрылся за %.1f с", grace)
        self._server = None

    # ---------- кодирование ----------

    def _encode(self, message: ServerMessage) -> str:
        text = encode_server_message(message)
        cleaned = self._redactor.redact_values(text)
        if cleaned != text:
            # Последний рубеж: секрета не должно быть ни в одном сообщении протокола.
            log.error("В исходящем сообщении %s обнаружен секрет — вырезан", message.type)
        return cleaned

    def _broadcast(self, message: ServerMessage) -> None:
        if not self._clients:
            return
        text = self._encode(message)
        droppable = message.type in DROPPABLE_TYPES
        for client in tuple(self._clients):
            client.enqueue(text, droppable=droppable)

    # ---------- рукопожатие ----------

    def _process_request(self, connection: ServerConnection, request: Request) -> Response | None:
        origin = _single_header(request.headers, "Origin")
        if origin is None or origin not in self._origins:
            log.warning("WS: отклонено подключение с Origin %r", origin[:100] if origin else None)
            return connection.respond(HTTPStatus.FORBIDDEN, "Forbidden\n")
        if urlsplit(request.path).path != WS_PATH:
            return connection.respond(HTTPStatus.NOT_FOUND, "Not Found\n")
        return None

    # ---------- соединение ----------

    async def _handle(self, connection: ServerConnection) -> None:
        if not await self._authenticate(connection):
            return
        if len(self._clients) >= self._max_clients:
            log.warning("WS: превышено число клиентов (%d) — отключаю нового", self._max_clients)
            await connection.close(CLOSE_TOO_MANY_CLIENTS, "too many clients")
            return
        client = ClientChannel(connection, self._encode, self._send_queue_limit)
        # Снимок и подписка — без await между ними: ни одно событие не потеряется и не задвоится.
        for message in self._snapshot():
            client.send(message)
        self._clients.add(client)
        log.info("WS: клиент подключён (%d из %d)", len(self._clients), self._max_clients)
        sender = asyncio.create_task(client.pump(), name="ws-send")
        try:
            async for raw in connection:
                await self._dispatch(raw, client)
        except ConnectionClosed:
            pass
        finally:
            self._clients.discard(client)
            sender.cancel()
            await asyncio.gather(sender, return_exceptions=True)
            log.info("WS: клиент отключён (код %s)", connection.close_code)

    async def _authenticate(self, connection: ServerConnection) -> bool:
        try:
            async with asyncio.timeout(self._auth_timeout):
                raw = await connection.recv()
        except TimeoutError:
            log.warning("WS: нет авторизации за %.0f с — отключаю", self._auth_timeout)
            await connection.close(CLOSE_UNAUTHORIZED, "auth timeout")
            return False
        except ConnectionClosed:
            return False
        try:
            message = parse_client_message(raw)
        except ProtocolError:
            message = None
        if not isinstance(message, AuthMessage) or not _tokens_equal(message.token, self._token):
            log.warning("WS: неверная авторизация — отключаю")
            await connection.close(CLOSE_UNAUTHORIZED, "unauthorized")
            return False
        return True

    async def _dispatch(self, raw: str | bytes, client: ClientChannel) -> None:
        try:
            message = parse_client_message(raw)
            if isinstance(message, AuthMessage):
                raise ProtocolError("bad_message", "Авторизация уже выполнена")
            await self._handler(message, client)
        except ProtocolError as exc:
            client.send(ErrorMessage(code=exc.code, message=exc.message))
        except Exception:
            log.exception("Ошибка обработки сообщения UI")
            client.send(ErrorMessage(code="internal", message="Внутренняя ошибка ядра"))


def _single_header(headers: Headers, name: str) -> str | None:
    """Ровно одно значение заголовка; несколько Origin — подозрительно, считаем отсутствующим."""
    values = headers.get_all(name)
    return values[0] if len(values) == 1 else None
