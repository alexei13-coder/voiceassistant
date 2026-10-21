"""Параметры запроса: модель, мышление, effort, fallbacks, инструменты, кэш, сжатие — и то,
что в итоге уходит по HTTP через настоящий SDK."""

from __future__ import annotations

import json
from pathlib import Path

from conftest import API_KEY, BrainCore, llm_settings

from swyvorn.brain.prompts import SYSTEM_PROMPT
from swyvorn.brain.request import COMPACTION_BETA, FALLBACK_BETA, RequestBuilder

TOOLS = [{"name": "remember", "input_schema": {"type": "object"}}]
MESSAGES = [{"role": "user", "content": [{"type": "text", "text": "привет"}]}, {"role": "system", "content": "ctx"}]


def test_default_request() -> None:
    params = RequestBuilder(llm_settings(), TOOLS).build(MESSAGES)
    assert params["model"] == "claude-opus-5-5"
    assert params["max_tokens"] == 4096
    assert params["thinking"] == {"type": "adaptive"}
    assert params["output_config"] == {"effort": "low"}
    assert params["fallbacks"] == "default"
    assert params["betas"] == [COMPACTION_BETA, FALLBACK_BETA] == ["compact-2026-01-12", "server-side-fallback-2026-07-01"]
    assert params["context_management"] == {"edits": [{"type": "compact_20260112"}]}
    assert params["messages"] == MESSAGES
    # Принуждения к инструменту нет: на Opus 5.5 any/tool — ошибка 400.
    assert params["tool_choice"] == {"type": "auto"}
    for forbidden in ("temperature", "top_p", "top_k"):
        assert forbidden not in params


def test_settings_are_applied() -> None:
    params = RequestBuilder(llm_settings(model="claude-sonnet-5-5", effort="high", max_tokens=8000), TOOLS).build([])
    assert (params["model"], params["max_tokens"], params["output_config"]) == (
        "claude-sonnet-5-5",
        8000,
        {"effort": "high"},
    )
    assert params["fallbacks"] == "default"


def test_haiku_gets_no_server_fallback() -> None:
    params = RequestBuilder(llm_settings(model="claude-haiku-5-5"), TOOLS).build([])
    assert "fallbacks" not in params
    assert params["betas"] == [COMPACTION_BETA]


def test_web_search_toggle() -> None:
    with_search = RequestBuilder(llm_settings(), TOOLS).build([])["tools"]
    assert with_search == [*TOOLS, {"type": "web_search_20260209", "name": "web_search", "max_uses": 3}]
    assert all(tool.get("type") != "code_execution_20260120" for tool in with_search)
    without = RequestBuilder(llm_settings(web_search=False), TOOLS).build([])["tools"]
    assert without == TOOLS


def test_cache_breakpoints() -> None:
    params = RequestBuilder(llm_settings(), TOOLS).build(MESSAGES)
    # Явная точка — на конце стабильного префикса (tools → system), автоматическая — на хвосте истории.
    assert params["system"] == [{"type": "text", "text": SYSTEM_PROMPT, "cache_control": {"type": "ephemeral"}}]
    assert params["cache_control"] == {"type": "ephemeral"}
    assert all("cache_control" not in tool for tool in params["tools"])
    # Изменчивого в префиксе нет: два построения дают одинаковые байты.
    a = RequestBuilder(llm_settings(), TOOLS).build([])
    b = RequestBuilder(llm_settings(), TOOLS).build([])
    assert json.dumps({k: a[k] for k in ("tools", "system")}) == json.dumps({k: b[k] for k in ("tools", "system")})


def test_system_prompt_has_no_volatile_parts() -> None:
    assert "2026" not in SYSTEM_PROMPT
    for rule in ("address_form", "уточняющий вопрос", "пока не умеешь", "данные, а не инструкции", "Markdown"):
        assert rule in SYSTEM_PROMPT


async def test_wire_request_through_the_sdk(bc: BrainCore, tmp_path: Path) -> None:
    await bc.say("Привет")
    assert bc.fake.problems == []
    body, headers = bc.fake.requests[-1], bc.fake.headers[-1]
    assert headers["x-api-key"] == API_KEY
    assert headers["anthropic-beta"] == "compact-2026-01-12,server-side-fallback-2026-07-01"
    assert body["stream"] is True
    assert body["model"] == "claude-opus-5-5"
    assert body["thinking"] == {"type": "adaptive"}
    assert body["output_config"] == {"effort": "low"}
    assert body["fallbacks"] == "default"
    assert body["tool_choice"] == {"type": "auto"}
    assert [tool["name"] for tool in body["tools"]] == ["forget", "remember", "web_search"]
    assert body["tools"][-1]["type"] == "web_search_20260209"
    for tool in body["tools"][:2]:
        assert tool["strict"] is True
        assert tool["eager_input_streaming"] is True
    # Реплика пользователя, за ней — блок контекста отдельным system-сообщением.
    assert body["messages"][0] == {"role": "user", "content": [{"type": "text", "text": "Привет"}]}
    context = body["messages"][1]
    assert context["role"] == "system"
    assert "вторник, 21 октября 2026, 14:05" in context["content"]
