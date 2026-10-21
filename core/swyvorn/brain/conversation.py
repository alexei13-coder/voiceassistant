"""История диалога и цикл одного ответа: стрим → инструменты → следующий запрос (docs/brain.md).

История только дописывается. Ответы ассистента сохраняются ровно так, как пришли (вместе
с блоками мышления, поиска и сжатия): на Opus 5.5 блок мышления действителен, только пока
всё до него не менялось («preserved thinking»), а кэш промпта — префиксный.

Ход копится отдельно (pending) и попадает в историю целиком, когда завершён. Прерванный
или неудавшийся ход в историю не попадает: остаётся только реплика пользователя с пометкой
для модели. Так история всегда корректна для API — каждому tool_use есть tool_result,
сообщение system стоит последним или перед ответом ассистента, нет «префилла».
"""

from __future__ import annotations

import asyncio
import logging
import time
from collections.abc import Callable, Sequence
from dataclasses import dataclass
from enum import StrEnum
from typing import Any

import anthropic

from .pricing import ResponseUsage, from_api_usage
from .prompts import FAILED_NOTE, STEP_LIMIT_NOTE, STOPPED_NOTE, TRUNCATED_NOTE
from .reply import ReplyView
from .request import RequestBuilder
from .tools import ToolRegistry

log = logging.getLogger(__name__)

MAX_ITERATIONS = 8
# Сколько раз подряд повторять запрос, если SDK не смог разобрать JSON входа инструмента.
MAX_JSON_RETRIES = 2

Message = dict[str, Any]


class Outcome(StrEnum):
    COMPLETED = "completed"
    TRUNCATED = "truncated"  # max_tokens: текст обрезан, но это ответ
    TOOL_TRUNCATED = "tool_truncated"  # max_tokens посреди входа инструмента — вызывать нельзя
    REFUSED = "refused"
    STEP_LIMIT = "step_limit"


@dataclass(frozen=True, slots=True)
class ResponseInfo:
    """Метаданные одного ответа API — то, что можно логировать и считать."""

    model: str
    stop_reason: str | None
    usage: ResponseUsage
    duration_s: float


class ToolInputError(Exception):
    """SDK несколько раз подряд не смог разобрать вход инструмента."""


class _UnparsableToolInput(Exception):
    pass


class Conversation:
    def __init__(
        self,
        *,
        requests: RequestBuilder,
        tools: ToolRegistry,
        on_response: Callable[[ResponseInfo], None],
        max_iterations: int = MAX_ITERATIONS,
    ) -> None:
        self._requests = requests
        self._tools = tools
        self._on_response = on_response
        self._max_iterations = max_iterations
        self._history: list[Message] = []
        # Растёт с каждым reset(): ход, прерванный новым диалогом, не допишет пометку
        # в уже очищенную историю.
        self._generation = 0

    @property
    def history(self) -> list[Message]:
        return list(self._history)

    @property
    def has_replies(self) -> bool:
        return any(message["role"] == "assistant" for message in self._history)

    def reset(self) -> None:
        self._history = []
        self._generation += 1

    async def run(
        self, client: anthropic.AsyncAnthropic, text: str, context: str, view: ReplyView
    ) -> Outcome:
        """Один ответ на реплику пользователя. Исключения SDK пробрасываются (их разбирает
        вызывающий), но история к этому моменту уже корректна."""
        generation = self._generation
        pending: list[Message] = [
            {"role": "user", "content": [{"type": "text", "text": text}]},
            {"role": "system", "content": context},
        ]
        try:
            outcome = await self._loop(client, pending, view)
        except asyncio.CancelledError:
            self._abandon(generation, text, STOPPED_NOTE)
            raise
        except BaseException:
            self._abandon(generation, text, FAILED_NOTE)
            raise
        match outcome:
            case Outcome.COMPLETED | Outcome.TRUNCATED:
                if generation == self._generation:
                    self._history.extend(pending)
            case Outcome.REFUSED:
                # Отклонённый запрос не сохраняется совсем: иначе классификатор видел бы его
                # в каждом следующем запросе и отказывал бы во всём диалоге.
                pass
            case Outcome.TOOL_TRUNCATED:
                self._abandon(generation, text, TRUNCATED_NOTE)
            case Outcome.STEP_LIMIT:
                self._abandon(generation, text, STEP_LIMIT_NOTE)
        return outcome

    def _abandon(self, generation: int, text: str, note: str) -> None:
        if generation != self._generation:
            return
        # Без сообщения system: оно допустимо только последним или перед ответом ассистента,
        # а следующей будет реплика пользователя. Две реплики пользователя подряд API склеит.
        self._history.append(
            {"role": "user", "content": [{"type": "text", "text": text}, {"type": "text", "text": note}]}
        )

    async def _loop(
        self, client: anthropic.AsyncAnthropic, pending: list[Message], view: ReplyView
    ) -> Outcome:
        bad_json = 0
        for _ in range(self._max_iterations):
            mark = view.mark()
            try:
                message = await self._request(client, [*self._history, *pending], view)
            except _UnparsableToolInput:
                bad_json += 1
                log.warning("Не удалось разобрать вход инструмента (попытка %d)", bad_json)
                if bad_json > MAX_JSON_RETRIES:
                    raise ToolInputError("вход инструмента не разбирается") from None
                view.rollback(mark)
                continue
            bad_json = 0
            # stop_reason — до чтения содержимого: при отказе оно пустое или частичное.
            stop = message.stop_reason
            if stop == "refusal":
                return Outcome.REFUSED
            tool_uses = [block for block in message.content if block.type == "tool_use"]
            if stop == "max_tokens" and tool_uses:
                # Обрезанный вход парсится как «правильный» неполный объект — выполнять нельзя.
                return Outcome.TOOL_TRUNCATED
            pending.append({"role": "assistant", "content": echo_content(message.content)})
            if stop == "max_tokens":
                return Outcome.TRUNCATED
            if stop == "pause_turn":
                # Серверный цикл поиска упёрся в свой лимит: тот же запрос продолжит его сам.
                continue
            if stop == "tool_use" and tool_uses:
                async with view.executing():
                    results = [await self._tools.execute(b.id, b.name, b.input) for b in tool_uses]
                pending.append({"role": "user", "content": results})
                await view.thinking()
                continue
            return Outcome.COMPLETED
        return Outcome.STEP_LIMIT

    async def _request(
        self, client: anthropic.AsyncAnthropic, messages: Sequence[Message], view: ReplyView
    ) -> Any:
        started = time.monotonic()
        start: Any = None
        try:
            async with client.beta.messages.stream(**self._requests.build(messages)) as stream:
                events = aiter(stream)
                while True:
                    try:
                        event = await anext(events)
                    except StopAsyncIteration:
                        break
                    except ValueError as exc:
                        # Так SDK сообщает о JSON входа инструмента, который не разобрать.
                        raise _UnparsableToolInput from exc
                    if event.type == "message_start":
                        start = event.message
                    await _show(event, view)
                message = await stream.get_final_message()
        except BaseException:
            # Вход уже оплачен, даже если ответ оборван: учитываем то, что известно из начала.
            if start is not None:
                self._report(start.model, None, start.usage, started)
            raise
        self._report(message.model, message.stop_reason, message.usage, started)
        return message

    def _report(self, model: str, stop_reason: str | None, usage: Any, started: float) -> None:
        self._on_response(
            ResponseInfo(
                model=model,
                stop_reason=stop_reason,
                usage=from_api_usage(usage, model),
                duration_s=time.monotonic() - started,
            )
        )


async def _show(event: Any, view: ReplyView) -> None:
    """Перевести событие стрима в то, что видит пользователь."""
    match event.type:
        case "content_block_start":
            block = event.content_block
            view.block_started(block.type)
            if block.type == "server_tool_use":
                await view.search_started()
            elif block.type == "web_search_tool_result":
                view.search_finished(block.tool_use_id, block.content)
        case "text":
            await view.text(event.text)
        case "content_block_stop":
            block = event.content_block
            if block.type == "text":
                view.text_finished()
            elif block.type == "server_tool_use" and block.name == "web_search":
                query = block.input.get("query") if isinstance(block.input, dict) else None
                view.search_requested(block.id, str(query or "—"))


def echo_content(blocks: Sequence[Any]) -> list[dict[str, Any]]:
    """Содержимое ответа для истории — как пришло, кроме случая запасной модели.

    После отказа посреди ответа (блок fallback) API требует не возвращать блоки отказавшей
    модели до последней границы: мышление, tool_use и серверные вызовы без результата.
    Текст и парные серверные блоки остаются, всё после границы — без изменений.
    """
    items = [block.to_dict(mode="json") for block in blocks]
    boundaries = [index for index, item in enumerate(items) if item.get("type") == "fallback"]
    if not boundaries:
        return items
    boundary = boundaries[-1]
    before = items[:boundary]
    server_calls = {item.get("id") for item in before if item.get("type") == "server_tool_use"}
    answered = {
        item.get("tool_use_id")
        for item in before
        if str(item.get("type", "")).endswith("_tool_result") and item.get("tool_use_id") in server_calls
    }
    kept = [
        item
        for item in before
        if item.get("type") == "text"
        or (item.get("type") == "server_tool_use" and item.get("id") in answered)
        or (str(item.get("type", "")).endswith("_tool_result") and item.get("tool_use_id") in answered)
    ]
    return kept + items[boundary:]
