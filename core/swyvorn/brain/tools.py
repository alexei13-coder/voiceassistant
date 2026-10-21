"""Свои инструменты модели и их выполнение (docs/brain.md). На этапе 2 — только память.

Вход каждого вызова проверяется pydantic до выполнения: при eager_input_streaming сервер
вход не валидирует, а терпимый парсер SDK может вернуть обрезанный объект. Неверный вход —
tool_result с is_error, модель видит причину и может повторить вызов.

Шов для этапа 4: решение «выполнять ли» принимает ApprovalPolicy. Сейчас она пропускает
только safe-инструменты; RiskPolicy и ConfirmationGate этапа 4 встанут на её место, не
меняя цикла ответа.
"""

from __future__ import annotations

import json
import logging
from abc import ABC, abstractmethod
from collections.abc import Iterable, Mapping
from dataclasses import dataclass
from typing import Annotated, Any, ClassVar, Protocol

import anthropic
from pydantic import BaseModel, ConfigDict, Field, ValidationError

from ..protocol import (
    MEMORY_KEY_MAX_LENGTH,
    MEMORY_KEY_PATTERN,
    MEMORY_VALUE_MAX_LENGTH,
    ActionDecision,
    Risk,
)
from ..session import Session
from .memory import MemoryStore, MemoryUpdateError, key_label

log = logging.getLogger(__name__)


@dataclass(frozen=True, slots=True)
class ToolResult:
    content: str  # для модели
    detail: str | None = None  # для журнала действий


class ToolFailure(Exception):
    """Инструмент не смог выполнить действие; текст увидят модель и журнал."""


class Tool[ArgsT: BaseModel](ABC):
    name: ClassVar[str]
    description: ClassVar[str]
    args_model: ClassVar[type[BaseModel]]
    risk: ClassVar[Risk] = "safe"

    @abstractmethod
    def title(self, args: ArgsT) -> str:
        """Человеческое описание для журнала действий."""

    @abstractmethod
    async def run(self, args: ArgsT) -> ToolResult: ...

    def definition(self) -> dict[str, Any]:
        # transform_schema переносит неподдерживаемые strict-режимом ограничения (длина,
        # шаблон) в описание поля: модель их видит, а проверяет их pydantic здесь.
        return {
            "name": self.name,
            "description": self.description,
            "input_schema": anthropic.transform_schema(self.args_model),
            "strict": True,
            "eager_input_streaming": True,
        }


@dataclass(frozen=True, slots=True)
class Approval:
    allowed: bool
    decision: ActionDecision
    reason: str | None = None


class ApprovalPolicy(Protocol):
    async def approve(self, tool: Tool[Any], args: BaseModel) -> Approval: ...


class SafeOnlyPolicy:
    """Этап 2: safe-инструменты выполняются сразу, остальные запрещены (их пока и нет)."""

    async def approve(self, tool: Tool[Any], args: BaseModel) -> Approval:
        if tool.risk == "safe":
            return Approval(allowed=True, decision="auto")
        return Approval(
            allowed=False, decision="forbidden", reason="Подтверждение действий появится на этапе 4"
        )


class ToolRegistry:
    def __init__(
        self, tools: Iterable[Tool[Any]], *, session: Session, policy: ApprovalPolicy | None = None
    ) -> None:
        # Порядок по имени: определения инструментов — начало кэшируемого префикса,
        # их байты не должны зависеть от порядка регистрации.
        self._tools = {tool.name: tool for tool in sorted(tools, key=lambda t: t.name)}
        self._session = session
        self._policy = policy or SafeOnlyPolicy()

    def definitions(self) -> list[dict[str, Any]]:
        return [tool.definition() for tool in self._tools.values()]

    async def execute(self, tool_use_id: str, name: str, raw_input: object) -> dict[str, Any]:
        """Выполнить один tool_use; всегда возвращает tool_result для следующего запроса."""
        tool = self._tools.get(name)
        if tool is None:
            log.warning("Модель вызвала неизвестный инструмент %s", name[:64])
            return _error(tool_use_id, f"Неизвестный инструмент: {name[:64]}.")
        try:
            args = tool.args_model.model_validate(raw_input if isinstance(raw_input, Mapping) else {})
        except ValidationError as exc:
            # В лог — только где ошибка, без значений: в них может быть текст пользователя.
            log.warning("Неверный вход инструмента %s: %s", name, _error_locations(exc))
            details = json.dumps({"INVALID_INPUT": _describe(exc)}, ensure_ascii=False)
            return _error(tool_use_id, details)

        title = tool.title(args)
        approval = await self._policy.approve(tool, args)
        if not approval.allowed:
            self._session.add_action(
                tool=name,
                title=title,
                risk=tool.risk,
                status="forbidden" if approval.decision == "forbidden" else "denied",
                decision=approval.decision,
                detail=approval.reason,
            )
            return _error(tool_use_id, f"Действие не выполнено: {approval.reason or 'не разрешено'}.")

        entry = self._session.add_action(
            tool=name, title=title, risk=tool.risk, status="running", decision=approval.decision
        )
        try:
            result = await tool.run(args)
        except ToolFailure as exc:
            self._session.update_action(entry.id, status="error", detail=str(exc))
            return _error(tool_use_id, str(exc))
        self._session.update_action(entry.id, status="ok", detail=result.detail)
        return {"type": "tool_result", "tool_use_id": tool_use_id, "content": result.content}


def _error(tool_use_id: str, text: str) -> dict[str, Any]:
    return {"type": "tool_result", "tool_use_id": tool_use_id, "content": text, "is_error": True}


def _error_locations(exc: ValidationError) -> str:
    return ", ".join(
        f"{'.'.join(str(p) for p in e['loc']) or '—'}:{e['type']}" for e in exc.errors(include_input=False)
    )


def _describe(exc: ValidationError) -> list[str]:
    return [
        f"{'.'.join(str(p) for p in e['loc']) or 'input'}: {e['msg']}"
        for e in exc.errors(include_input=False, include_url=False)
    ]


# ---------- память ----------


class _Args(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True, frozen=True)


MemoryKeyField = Annotated[
    str,
    Field(
        min_length=1,
        max_length=MEMORY_KEY_MAX_LENGTH,
        pattern=MEMORY_KEY_PATTERN,
        description="Ключ факта: snake_case латиницей, например address_form, user_name, city.",
    ),
]


class RememberArgs(_Args):
    key: MemoryKeyField
    value: Annotated[
        str,
        Field(
            min_length=1,
            max_length=MEMORY_VALUE_MAX_LENGTH,
            description="Значение коротко, как его сказал пользователь, например «шеф» или «Москва».",
        ),
    ]


class ForgetArgs(_Args):
    key: MemoryKeyField


class RememberTool(Tool[RememberArgs]):
    name = "remember"
    args_model = RememberArgs
    description = (
        "Сохранить факт о пользователе в долговременную память или заменить значение по тому же ключу. "
        "Вызывай, когда пользователь сообщает о себе то, что пригодится в следующих разговорах, или прямо "
        "просит запомнить. Особые ключи: address_form — как обращаться к пользователю («сэр», «шеф», имя); "
        "user_name — имя пользователя; city — город, где он живёт (для погоды и местного времени). "
        "Для остального придумай короткий понятный ключ. Не сохраняй пароли, коды и другие секреты."
    )

    def __init__(self, memory: MemoryStore) -> None:
        self._memory = memory

    def title(self, args: RememberArgs) -> str:
        return f"Запомнил: {key_label(args.key)} — «{args.value}»"

    async def run(self, args: RememberArgs) -> ToolResult:
        try:
            previous = self._memory.remember(args.key, args.value)
        except MemoryUpdateError as exc:
            raise ToolFailure(str(exc)) from None
        stored = self._memory.get(args.key)
        detail = f"Было: «{previous.value}»" if previous is not None else "Новый факт"
        return ToolResult(content=f"Сохранено: {args.key} = «{stored}».", detail=detail)


class ForgetTool(Tool[ForgetArgs]):
    name = "forget"
    args_model = ForgetArgs
    description = (
        "Удалить факт из долговременной памяти по ключу. Вызывай, когда пользователь просит что-то забыть "
        "или факт устарел, а нового значения нет. Существующие ключи — в блоке контекста."
    )

    def __init__(self, memory: MemoryStore) -> None:
        self._memory = memory

    def title(self, args: ForgetArgs) -> str:
        return f"Забыл: {key_label(args.key)}"

    async def run(self, args: ForgetArgs) -> ToolResult:
        try:
            previous = self._memory.forget(args.key)
        except MemoryUpdateError as exc:
            raise ToolFailure(str(exc)) from None
        if previous is None:
            return ToolResult(content=f"Такого факта нет: {args.key}.", detail="Такого факта не было")
        return ToolResult(content=f"Удалено: {args.key}.", detail=f"Было: «{previous.value}»")


def memory_tools(memory: MemoryStore) -> list[Tool[Any]]:
    return [RememberTool(memory), ForgetTool(memory)]
