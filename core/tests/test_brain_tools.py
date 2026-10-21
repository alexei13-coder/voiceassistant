"""Инструменты памяти: строгие схемы, выполнение с записью в журнал, отказ неверному входу."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest
from conftest import Core, build_core
from pydantic import BaseModel

from swyvorn.brain.memory import MAX_FACTS, MemoryStore
from swyvorn.brain.tools import Approval, RememberArgs, Tool, ToolRegistry, ToolResult, memory_tools


def make_registry(tmp_path: Path, core: Core, **kwargs: Any) -> tuple[ToolRegistry, MemoryStore]:
    memory = MemoryStore(tmp_path / "memory.json")
    return ToolRegistry(memory_tools(memory), session=core.session, **kwargs), memory


def test_definitions_are_strict_eager_and_sorted(tmp_path: Path) -> None:
    registry, _ = make_registry(tmp_path, build_core())
    definitions = registry.definitions()
    assert [d["name"] for d in definitions] == ["forget", "remember"]
    for definition in definitions:
        assert definition["strict"] is True
        assert definition["eager_input_streaming"] is True
        schema = definition["input_schema"]
        assert schema["type"] == "object"
        assert schema["additionalProperties"] is False
        # Ограничения, которых нет в strict-схемах, перенесены в описание поля.
        assert "maxLength" not in schema["properties"]["key"]
        assert "pattern" not in schema["properties"]["key"]
        assert "maxLength: 40" in schema["properties"]["key"]["description"]
    remember = definitions[1]
    assert remember["input_schema"]["required"] == ["key", "value"]
    for special in ("address_form", "user_name", "city"):
        assert special in remember["description"]
    # Детерминированные байты: от этого зависит кэш промпта.
    again, _ = make_registry(tmp_path, build_core())
    assert json.dumps(definitions) == json.dumps(again.definitions())


async def test_remember_and_forget_write_memory_and_journal(tmp_path: Path) -> None:
    core = build_core()
    registry, memory = make_registry(tmp_path, core)

    result = await registry.execute("toolu_1", "remember", {"key": "address_form", "value": "шеф"})
    assert result == {"type": "tool_result", "tool_use_id": "toolu_1", "content": "Сохранено: address_form = «шеф»."}
    assert memory.get("address_form") == "шеф"
    entries = [e.entry for e in core.rec.of_type("action")]
    assert [e.status for e in entries] == ["running", "ok"]
    final = entries[-1]
    assert (final.tool, final.risk, final.decision) == ("remember", "safe", "auto")
    assert final.title == "Запомнил: обращение — «шеф»"
    assert final.detail == "Новый факт"
    assert final.duration_ms is not None
    assert final.demo is False

    await registry.execute("toolu_2", "remember", {"key": "address_form", "value": "командир"})
    assert core.rec.of_type("action")[-1].entry.detail == "Было: «шеф»"

    result = await registry.execute("toolu_3", "forget", {"key": "address_form"})
    assert result["content"] == "Удалено: address_form."
    assert core.rec.of_type("action")[-1].entry.title == "Забыл: обращение"
    result = await registry.execute("toolu_4", "forget", {"key": "address_form"})
    assert result["content"] == "Такого факта нет: address_form."
    assert "is_error" not in result
    assert memory.facts() == []


@pytest.mark.parametrize(
    "tool_input",
    [
        {"key": "address_form"},
        {"key": "address_form", "value": "шеф", "extra": 1},
        {"key": "Address Form", "value": "шеф"},
        {"key": "address_form", "value": ""},
        {"key": "address_form", "value": "я" * 201},
        {"key": 42, "value": "шеф"},
        "не объект",
        None,
    ],
)
async def test_invalid_input_is_rejected_before_running(tmp_path: Path, tool_input: object) -> None:
    core = build_core()
    registry, memory = make_registry(tmp_path, core)
    result = await registry.execute("toolu_x", "remember", tool_input)
    assert result["is_error"] is True
    assert result["tool_use_id"] == "toolu_x"
    assert "INVALID_INPUT" in json.loads(result["content"])
    assert memory.facts() == []
    assert core.rec.of_type("action") == []


async def test_unknown_tool(tmp_path: Path) -> None:
    registry, _ = make_registry(tmp_path, build_core())
    result = await registry.execute("toolu_y", "format_disk", {})
    assert result["is_error"] is True
    assert "format_disk" in result["content"]


async def test_full_memory_is_an_error_entry(tmp_path: Path) -> None:
    core = build_core()
    registry, memory = make_registry(tmp_path, core)
    for index in range(MAX_FACTS):
        memory.remember(f"fact_{index}", "x")
    result = await registry.execute("toolu_z", "remember", {"key": "one_more", "value": "x"})
    assert result["is_error"] is True
    assert "заполнена" in result["content"]
    entry = core.rec.of_type("action")[-1].entry
    assert entry.status == "error"
    assert "заполнена" in (entry.detail or "")


class _DenyAll:
    async def approve(self, tool: Tool[Any], args: BaseModel) -> Approval:
        return Approval(allowed=False, decision="denied", reason="пользователь отказал")


async def test_policy_hook_can_block_execution(tmp_path: Path) -> None:
    """Шов этапа 4: решение принимает политика, инструмент без разрешения не запускается."""
    core = build_core()
    registry, memory = make_registry(tmp_path, core, policy=_DenyAll())
    result = await registry.execute("toolu_d", "remember", {"key": "city", "value": "Москва"})
    assert result["is_error"] is True
    assert "пользователь отказал" in result["content"]
    assert memory.get("city") is None
    entry = core.rec.of_type("action")[-1].entry
    assert (entry.status, entry.decision) == ("denied", "denied")


async def test_tool_failure_becomes_error_result(tmp_path: Path) -> None:
    class Broken(Tool[RememberArgs]):
        name = "broken"
        description = "ломается"
        args_model = RememberArgs

        def title(self, args: RememberArgs) -> str:
            return "Сломанный"

        async def run(self, args: RememberArgs) -> ToolResult:
            from swyvorn.brain.tools import ToolFailure

            raise ToolFailure("не вышло")

    core = build_core()
    registry = ToolRegistry([Broken()], session=core.session)
    result = await registry.execute("toolu_b", "broken", {"key": "a", "value": "b"})
    assert result == {"type": "tool_result", "tool_use_id": "toolu_b", "content": "не вышло", "is_error": True}
    assert core.rec.of_type("action")[-1].entry.status == "error"
