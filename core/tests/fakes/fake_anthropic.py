"""Поддельный Claude Messages API для тестов и ручных прогонов без настоящего ключа.

События SSE — как у настоящего API: message_start, content_block_start/delta/stop для
thinking, text, tool_use, server_tool_use и web_search_tool_result, message_delta с usage и
stop_reason, message_stop; ошибки — HTTP-кодом с телом {"type":"error",…} или событием error
посреди стрима. Каждый запрос проверяется на правила, которые нарушить легко, а заметить
трудно (system-сообщения, пары tool_use/tool_result, префилл, strict-схемы инструментов):
нарушение — 400, как ответил бы настоящий API.

Два способа подключения:
- в тестах — FakeAnthropic.http_client() (httpx2.MockTransport, без сети);
- вручную — локальный HTTP-сервер:

    cd core
    uv run python -m tests.fakes.fake_anthropic --port 8899

  и ядро в режиме разработки (в другом окне):

    SWYVORN_ANTHROPIC_BASE_URL=http://127.0.0.1:8899 ANTHROPIC_API_KEY=sk-ant-test-fake-key-123 \\
    SWYVORN_IPC_TOKEN=devtoken SWYVORN_DATA_DIR=/tmp/swyvorn-dev \\
    uv run python -m swyvorn --dev --no-stdin --port 18765

Ответы по ключевым словам в реплике: «меня зовут Алексей», «называй меня шеф» — инструмент
remember; «забудь» — forget; «погода», «найди», «новости» — поиск в интернете; «подробно»,
«расскажи» — длинный ответ в Markdown; «медленно» — долгий ответ (проверить «Стоп»);
«откажи» — отказ; «ошибка 401 / 429 / 500 / 529», «баланс» — ошибки API; «обрыв» — ошибка
посреди стрима. Первая реплика без выбранного обращения — приветствие с вопросом, как обращаться.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import re
import sys
import threading
import time
import uuid
from collections import deque
from collections.abc import AsyncIterator, Callable, Iterator
from dataclasses import dataclass, field
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any

import anthropic
import httpx2

DEFAULT_MODEL = "claude-opus-5-5"
FALLBACK_BETA = "server-side-fallback-2026-07-01"
COMPACTION_BETA = "compact-2026-01-12"
CREDIT_MESSAGE = (
    "Your credit balance is too low to access the Anthropic API. "
    "Please go to Plans & Billing to upgrade or purchase credits."
)


# ---------- ответы ----------


@dataclass
class Reply:
    """Один ответ: поток событий SSE (status 200) или ошибка HTTP с JSON-телом."""

    events: list[dict[str, Any]] = field(default_factory=list)
    status: int = 200
    body: dict[str, Any] | None = None
    headers: dict[str, str] = field(default_factory=dict)
    # Только для MockTransport: после события с этим номером стрим ждёт hold (для «Стопа»).
    hold_after: int | None = None
    hold: asyncio.Event | None = None


def error_reply(status: int, error_type: str, message: str, **headers: str) -> Reply:
    body = {
        "type": "error",
        "error": {"type": error_type, "message": message},
        "request_id": f"req_{uuid.uuid4().hex[:20]}",
    }
    base = {"request-id": body["request_id"]}
    if status in (429, 529) or status >= 500:
        # SDK повторяет такие ответы сам; пусть ждёт миллисекунды, а не секунды.
        base["retry-after-ms"] = "10"
    return Reply(status=status, body=body, headers={**base, **headers})


class Script:
    """Построитель потока событий одного ответа: блоки получают номера по порядку."""

    def __init__(
        self,
        model: str = DEFAULT_MODEL,
        *,
        input_tokens: int = 120,
        cache_read: int = 0,
        cache_write: int = 0,
        thinking: bool = True,
    ) -> None:
        self.model = model
        self._events: list[dict[str, Any]] = [
            {
                "type": "message_start",
                "message": {
                    "id": f"msg_{uuid.uuid4().hex[:24]}",
                    "type": "message",
                    "role": "assistant",
                    "model": model,
                    "content": [],
                    "stop_reason": None,
                    "stop_sequence": None,
                    "usage": {
                        "input_tokens": input_tokens,
                        "output_tokens": 1,
                        "cache_creation_input_tokens": cache_write,
                        "cache_read_input_tokens": cache_read,
                    },
                },
            },
            {"type": "ping"},
        ]
        self._index = 0
        self._text_length = 0
        self._searches = 0
        if thinking:
            self.thinking()

    def _block(self, start: dict[str, Any], deltas: list[dict[str, Any]]) -> Script:
        index = self._index
        self._index += 1
        self._events.append({"type": "content_block_start", "index": index, "content_block": start})
        self._events.extend({"type": "content_block_delta", "index": index, "delta": d} for d in deltas)
        self._events.append({"type": "content_block_stop", "index": index})
        return self

    def thinking(self) -> Script:
        # display по умолчанию omitted: текста нет, только подпись.
        signature = f"sig_{uuid.uuid4().hex}"
        return self._block(
            {"type": "thinking", "thinking": "", "signature": ""},
            [{"type": "signature_delta", "signature": signature}],
        )

    def text(self, text: str, *, citation: dict[str, Any] | None = None) -> Script:
        self._text_length += len(text)
        deltas: list[dict[str, Any]] = [{"type": "text_delta", "text": chunk} for chunk in _chunks(text)]
        if citation is not None:
            deltas.append({"type": "citations_delta", "citation": citation})
        return self._block({"type": "text", "text": ""}, deltas)

    def tool_use(self, name: str, tool_input: Any = None, *, raw_json: str | None = None) -> Script:
        payload = raw_json if raw_json is not None else json.dumps(tool_input, ensure_ascii=False)
        start = {"type": "tool_use", "id": f"toolu_{uuid.uuid4().hex[:20]}", "name": name, "input": {}}
        return self._block(
            start, [{"type": "input_json_delta", "partial_json": part} for part in _halves(payload)]
        )

    def search(
        self, query: str, results: list[tuple[str, str]] | None = None, *, error: str | None = None
    ) -> Script:
        tool_id = f"srvtoolu_{uuid.uuid4().hex[:20]}"
        payload = json.dumps({"query": query}, ensure_ascii=False)
        start = {"type": "server_tool_use", "id": tool_id, "name": "web_search", "input": {}}
        self._block(start, [{"type": "input_json_delta", "partial_json": part} for part in _halves(payload)])
        self._searches += 1
        content: Any
        if error is not None:
            content = {"type": "web_search_tool_result_error", "error_code": error}
        else:
            content = [
                {
                    "type": "web_search_result",
                    "title": title,
                    "url": url,
                    "encrypted_content": uuid.uuid4().hex,
                    "page_age": "1 час назад",
                }
                for title, url in (results or [("Пример", "https://example.org/")])
            ]
        return self._block({"type": "web_search_tool_result", "tool_use_id": tool_id, "content": content}, [])

    def pending_search(self, query: str) -> Script:
        """Серверный вызов без результата — так заканчивается ответ с pause_turn."""
        payload = json.dumps({"query": query}, ensure_ascii=False)
        start = {
            "type": "server_tool_use",
            "id": f"srvtoolu_{uuid.uuid4().hex[:20]}",
            "name": "web_search",
            "input": {},
        }
        self._searches += 1
        return self._block(start, [{"type": "input_json_delta", "partial_json": payload}])

    def fallback(self, from_model: str, to_model: str) -> Script:
        self.model = to_model
        return self._block({"type": "fallback", "from": {"model": from_model}, "to": {"model": to_model}}, [])

    def end(
        self,
        stop_reason: str = "end_turn",
        *,
        output_tokens: int | None = None,
        stop_details: dict[str, Any] | None = None,
        iterations: list[dict[str, Any]] | None = None,
    ) -> Reply:
        usage: dict[str, Any] = {"output_tokens": output_tokens or 20 + self._text_length // 3}
        if self._searches:
            usage["server_tool_use"] = {"web_search_requests": self._searches, "web_fetch_requests": 0}
        if iterations is not None:
            usage["iterations"] = iterations
        delta: dict[str, Any] = {"stop_reason": stop_reason, "stop_sequence": None}
        if stop_details is not None:
            delta["stop_details"] = stop_details
        events = [
            *self._events,
            {"type": "message_delta", "delta": delta, "usage": usage},
            {"type": "message_stop"},
        ]
        return Reply(events=events)

    def stream_error(self, error_type: str = "overloaded_error", message: str = "Overloaded") -> Reply:
        """Ошибка посреди стрима: HTTP 200 уже отправлен, приходит событие error."""
        error = {"type": "error", "error": {"type": error_type, "message": message}}
        return Reply(events=[*self._events, error])


def text_reply(text: str, **kwargs: Any) -> Reply:
    return Script(**kwargs).text(text).end()


def _chunks(text: str, words: int = 3) -> Iterator[str]:
    parts = re.findall(r"\S+\s*|\s+", text)
    for start in range(0, len(parts), words):
        yield "".join(parts[start : start + words])


def _halves(payload: str) -> list[str]:
    middle = len(payload) // 2
    return [payload[:middle], payload[middle:]] if middle else [payload]


def encode_event(event: dict[str, Any]) -> bytes:
    return f"event: {event['type']}\ndata: {json.dumps(event, ensure_ascii=False)}\n\n".encode()


# ---------- проверка запроса ----------


def validate_request(body: dict[str, Any], headers: dict[str, str]) -> list[str]:
    """Нарушения, на которые настоящий API ответил бы 400."""
    problems: list[str] = []
    messages = body.get("messages")
    if not isinstance(body.get("model"), str) or not isinstance(body.get("max_tokens"), int):
        problems.append("model и max_tokens обязательны")
    if not isinstance(messages, list) or not messages:
        return [*problems, "messages: пустой список"]
    for name in ("temperature", "top_p", "top_k"):
        if name in body:
            problems.append(f"{name}: не поддерживается моделью")
    thinking = body.get("thinking")
    if thinking is not None and thinking.get("type") != "adaptive":
        problems.append("thinking: на Opus 5.5 допустим только adaptive")
    if (body.get("tool_choice") or {}).get("type") in ("any", "tool"):
        problems.append('tool_choice: type "tool" and "any" are not supported for this model.')
    betas = {beta.strip() for beta in headers.get("anthropic-beta", "").split(",") if beta.strip()}
    if "fallbacks" in body and FALLBACK_BETA not in betas:
        problems.append(f"fallbacks: нужен заголовок {FALLBACK_BETA}")
    if "context_management" in body and COMPACTION_BETA not in betas:
        problems.append(f"context_management: нужен заголовок {COMPACTION_BETA}")
    for tool in body.get("tools") or []:
        if "type" in tool and tool["type"] != "custom":
            continue
        schema = tool.get("input_schema") or {}
        if not tool.get("strict") or not tool.get("eager_input_streaming"):
            problems.append(f"tools.{tool.get('name')}: ожидаются strict и eager_input_streaming")
        if schema.get("additionalProperties") is not False:
            problems.append(f"tools.{tool.get('name')}: additionalProperties должно быть false")
    problems.extend(_check_messages(messages))
    return problems


def _blocks(message: dict[str, Any]) -> list[dict[str, Any]]:
    content = message.get("content")
    if isinstance(content, str):
        return [{"type": "text", "text": content}]
    return list(content or [])


def _check_messages(messages: list[dict[str, Any]]) -> list[str]:
    problems: list[str] = []
    if messages[0].get("role") != "user":
        problems.append("messages.0: первым должно быть сообщение user")
    for index, message in enumerate(messages):
        role = message.get("role")
        blocks = _blocks(message)
        if role == "system":
            before = messages[index - 1] if index else None
            after = messages[index + 1] if index + 1 < len(messages) else None
            if before is None or before.get("role") != "user":
                problems.append(f"messages.{index}: system должно идти после user")
            if after is not None and after.get("role") != "assistant":
                problems.append(f"messages.{index}: system должно быть последним или перед assistant")
        if role == "assistant":
            calls = {b["id"] for b in blocks if b.get("type") == "tool_use"}
            if calls:
                after = messages[index + 1] if index + 1 < len(messages) else None
                answered = {
                    b.get("tool_use_id") for b in _blocks(after or {}) if b.get("type") == "tool_result"
                }
                if after is None or after.get("role") != "user" or not calls <= answered:
                    problems.append(f"messages.{index}: tool_use без tool_result в следующем сообщении")
            for block in blocks:
                if block.get("type") == "thinking" and not block.get("signature"):
                    problems.append(f"messages.{index}: блок thinking без подписи")
        if role == "user":
            results = {b.get("tool_use_id") for b in blocks if b.get("type") == "tool_result"}
            if results:
                before = messages[index - 1] if index else {}
                calls = {b.get("id") for b in _blocks(before) if b.get("type") == "tool_use"}
                if before.get("role") != "assistant" or not results <= calls:
                    problems.append(f"messages.{index}: tool_result без tool_use в предыдущем сообщении")
    last = messages[-1]
    if last.get("role") == "assistant":
        tail = _blocks(last)[-1:] or [{}]
        if tail[0].get("type") != "server_tool_use":
            problems.append("последнее сообщение assistant: префилл на этой модели не поддерживается")
    return problems


# ---------- готовые ответы по ключевым словам ----------

_NAME_RE = re.compile(r"меня зовут\s+([А-ЯЁA-Z][\w-]*)", re.IGNORECASE)
_ADDRESS_RE = re.compile(
    r"(?:называй|зови) меня\s+[«\"]?([^»\".!?,]+)|обращайся ко мне\s+[«\"]?([^»\".!?,]+)", re.I
)

LONG_ANSWER = """\
Конечно. Вот короткий план, как навести порядок в папке «Загрузки»:

1. **Отсортируйте по дате** — всё старше месяца почти наверняка не нужно.
2. **Разнесите по папкам**: документы, установщики, фото.
3. **Удалите установщики** программ, которые уже стоят.

Если хочется автоматизировать, PowerShell справится одной командой:

```powershell
Get-ChildItem "$env:USERPROFILE\\Downloads" -File |
  Where-Object LastWriteTime -lt (Get-Date).AddDays(-30) |
  Select-Object Name, Length
```

Она только показывает старые файлы и ничего не удаляет — сначала стоит посмотреть на список."""


def _last_user_text(messages: list[dict[str, Any]]) -> str:
    for message in reversed(messages):
        if message.get("role") == "user":
            texts = [b.get("text", "") for b in _blocks(message) if b.get("type") == "text"]
            if texts:
                return texts[0]
    return ""


def canned_reply(body: dict[str, Any]) -> Reply:
    messages = body["messages"]
    model = body.get("model", DEFAULT_MODEL)
    last = messages[-1]
    cached = 1800 if len(messages) > 2 else 0
    usage = {"input_tokens": 40 + len(json.dumps(last, ensure_ascii=False)) // 3, "cache_read": cached}
    usage["cache_write"] = 1800 if not cached else 250
    if last.get("role") == "assistant":
        # Продолжение после pause_turn.
        return Script(model, **usage).text("Нашёл: сейчас +12 °C, облачно.").end()
    results = [b for b in _blocks(last) if b.get("type") == "tool_result"]
    if results:
        return _after_tool(messages, results[0], model, usage)
    text = _last_user_text(messages)
    low = text.lower()
    context = last.get("content", "") if last.get("role") == "system" else ""
    if "401" in low:
        return error_reply(401, "authentication_error", "invalid x-api-key")
    if "429" in low:
        return error_reply(429, "rate_limit_error", "Number of requests has exceeded your rate limit")
    if "529" in low or "перегруз" in low:
        return error_reply(529, "overloaded_error", "Overloaded")
    if "500" in low:
        return error_reply(500, "api_error", "Internal server error")
    if "баланс" in low or "credit" in low:
        return error_reply(400, "invalid_request_error", CREDIT_MESSAGE)
    if "обрыв" in low:
        return Script(model, **usage).text("Начинаю отвечать, но связь сейчас ").stream_error()
    if "откажи" in low:
        return (
            Script(model, **usage)
            .text("Это я ")
            .end("refusal", stop_details={"type": "refusal", "category": "cyber", "explanation": None})
        )
    if name := _NAME_RE.search(text):
        return (
            Script(model, **usage)
            .tool_use("remember", {"key": "user_name", "value": name.group(1)})
            .end("tool_use")
        )
    if address := _ADDRESS_RE.search(text):
        value = (address.group(1) or address.group(2)).strip()
        return (
            Script(model, **usage)
            .tool_use("remember", {"key": "address_form", "value": value})
            .end("tool_use")
        )
    if "забудь" in low:
        key = "address_form" if "обращ" in low else "user_name"
        return Script(model, **usage).tool_use("forget", {"key": key}).end("tool_use")
    if any(word in low for word in ("погод", "найди", "новост", "поищи", "курс")):
        query = "погода в Москве сегодня" if "погод" in low else text[:60]
        source = {
            "type": "web_search_result_location",
            "cited_text": "+12 °C, облачно",
            "url": "https://example.org/",
            "title": "Пример",
            "encrypted_index": "x",
        }
        return (
            Script(model, **usage)
            .text("Сейчас посмотрю.")
            .search(query, [("Погода в Москве — пример", "https://example.org/")])
            .text("По данным поиска, сейчас в Москве ")
            .text("+12 °C и облачно", citation=source)
            .text(", к вечеру возможен дождь.")
            .end()
        )
    if any(word in low for word in ("подробно", "расскажи", "markdown", "длинн")):
        return Script(model, **usage).text(LONG_ANSWER).end()
    if "медленно" in low:
        return Script(model, **usage).text(" ".join(["Это очень длинный и медленный ответ."] * 60)).end()
    if "Форму обращения нужно спросить" in str(context):
        return (
            Script(model, **usage)
            .text(
                "Здравствуйте. Я SWYVORN, ваш ассистент. "
                "Как к вам обращаться — «сэр», по имени или как-то иначе?"
            )
            .end()
        )
    return (
        Script(model, **usage)
        .text(f"Понял вас. (Это ответ поддельного API; вы написали {len(text)} симв.)")
        .end()
    )


def _after_tool(
    messages: list[dict[str, Any]], result: dict[str, Any], model: str, usage: dict[str, int]
) -> Reply:
    calls = {b.get("id"): b for b in _blocks(messages[-2]) if b.get("type") == "tool_use"}
    call = calls.get(result.get("tool_use_id"), {})
    if result.get("is_error"):
        return Script(model, **usage).text("Не получилось сохранить это в память.").end()
    tool_input = call.get("input") or {}
    if call.get("name") == "remember" and tool_input.get("key") == "address_form":
        return Script(model, **usage).text(f"Хорошо, буду обращаться «{tool_input.get('value')}».").end()
    if call.get("name") == "remember":
        return Script(model, **usage).text(f"Запомнил, {tool_input.get('value')}.").end()
    return Script(model, **usage).text("Готово, забыл.").end()


# ---------- поддельный API ----------


class FakeAnthropic:
    """Очередь заготовленных ответов (push), иначе — responder, иначе — canned_reply."""

    def __init__(self, responder: Callable[[dict[str, Any]], Reply] | None = None) -> None:
        self._responder = responder or canned_reply
        self._queue: deque[Reply] = deque()
        self._lock = threading.Lock()
        self.requests: list[dict[str, Any]] = []
        self.headers: list[dict[str, str]] = []
        self.problems: list[str] = []

    def push(self, *replies: Reply) -> None:
        with self._lock:
            self._queue.extend(replies)

    def respond(self, body: dict[str, Any], headers: dict[str, str]) -> Reply:
        with self._lock:
            self.requests.append(body)
            self.headers.append(headers)
            if not headers.get("x-api-key"):
                return error_reply(401, "authentication_error", "x-api-key header is required")
            problems = validate_request(body, headers)
            if problems:
                self.problems.extend(problems)
                return error_reply(400, "invalid_request_error", "; ".join(problems))
            if self._queue:
                return self._queue.popleft()
        return self._responder(body)

    # ---------- httpx2.MockTransport ----------

    def http_client(self) -> anthropic.DefaultAsyncHttpxClient:
        return anthropic.DefaultAsyncHttpxClient(transport=httpx2.MockTransport(self._handle))

    async def _handle(self, request: httpx2.Request) -> httpx2.Response:
        body = json.loads(await request.aread())
        reply = self.respond(body, {k.lower(): v for k, v in request.headers.items()})
        if reply.status != 200:
            return httpx2.Response(reply.status, json=reply.body, headers=reply.headers)
        return httpx2.Response(200, headers={"content-type": "text/event-stream"}, content=_stream(reply))

    # ---------- локальный HTTP-сервер ----------

    def serve(self, host: str = "127.0.0.1", port: int = 0, *, delay: float = 0.0) -> ThreadingHTTPServer:
        """Запустить в потоке-демоне; адрес — server.server_address, остановка — shutdown()."""
        fake = self

        class Handler(BaseHTTPRequestHandler):
            def do_POST(self) -> None:
                if self.path.split("?")[0] != "/v1/messages":
                    self.send_error(404)
                    return
                length = int(self.headers.get("Content-Length", "0"))
                body = json.loads(self.rfile.read(length))
                reply = fake.respond(body, {k.lower(): v for k, v in self.headers.items()})
                self.send_response(reply.status)
                for name, value in reply.headers.items():
                    self.send_header(name, value)
                if reply.status != 200:
                    data = json.dumps(reply.body, ensure_ascii=False).encode()
                    self.send_header("content-type", "application/json")
                    self.send_header("content-length", str(len(data)))
                    self.end_headers()
                    self.wfile.write(data)
                    return
                self.send_header("content-type", "text/event-stream")
                self.send_header("connection", "close")
                self.end_headers()
                for event in reply.events:
                    self.wfile.write(encode_event(event))
                    self.wfile.flush()
                    if delay and event["type"] == "content_block_delta":
                        time.sleep(delay)

            def log_message(self, format: str, *args: Any) -> None:
                sys.stderr.write(f"[fake-anthropic] {format % args}\n")

        server = ThreadingHTTPServer((host, port), Handler)
        server.daemon_threads = True
        threading.Thread(target=server.serve_forever, name="fake-anthropic", daemon=True).start()
        return server


async def _stream(reply: Reply) -> AsyncIterator[bytes]:
    for index, event in enumerate(reply.events):
        yield encode_event(event)
        await asyncio.sleep(0)
        if reply.hold is not None and index == reply.hold_after:
            await reply.hold.wait()


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Поддельный Claude Messages API для разработки SWYVORN.")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8899)
    parser.add_argument("--delay", type=float, default=0.03, help="пауза между кусками текста, с")
    args = parser.parse_args(argv)
    server = FakeAnthropic().serve(args.host, args.port, delay=args.delay)
    host, port = server.server_address[:2]
    print(f"[fake-anthropic] слушаю http://{host}:{port}/v1/messages", file=sys.stderr, flush=True)
    print(
        f"[fake-anthropic] для ядра: SWYVORN_ANTHROPIC_BASE_URL=http://{host}:{port} и флаг --dev",
        file=sys.stderr,
    )
    try:
        threading.Event().wait()
    except KeyboardInterrupt:
        pass
    finally:
        server.shutdown()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
