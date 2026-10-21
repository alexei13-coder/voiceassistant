"""Параметры запроса к Claude (docs/brain.md, «Запрос к Claude»).

Порядок отрисовки запроса: tools → system → messages. Всё, что до последнего блока system,
вычисляется один раз и не меняется до перезапуска ядра — это кэшируемый префикс. Явная точка
кэша стоит на системном промпте, а автоматическая (cache_control верхнего уровня) двигается
за растущей историей диалога.
"""

from __future__ import annotations

from collections.abc import Sequence
from typing import Any

from ..config import LlmSettings
from .prompts import SYSTEM_PROMPT

COMPACTION_BETA = "compact-2026-01-12"
FALLBACK_BETA = "server-side-fallback-2026-07-01"
WEB_SEARCH_TOOL = {"type": "web_search_20260209", "name": "web_search", "max_uses": 3}
EPHEMERAL = {"type": "ephemeral"}


def supports_server_fallback(model: str) -> bool:
    """У Haiku 5.5 нет серверного запасного маршрута: с fallbacks: "default" отказ так и
    останется отказом, поэтому параметр ей не передаём."""
    return not model.startswith("claude-haiku")


class RequestBuilder:
    def __init__(self, llm: LlmSettings, tool_definitions: Sequence[dict[str, Any]]) -> None:
        self.model = llm.model
        self.web_search = llm.web_search
        tools = [*tool_definitions, WEB_SEARCH_TOOL] if llm.web_search else list(tool_definitions)
        fallback = supports_server_fallback(llm.model)
        self._fixed: dict[str, Any] = {
            "model": llm.model,
            "max_tokens": llm.max_tokens,
            "system": [{"type": "text", "text": SYSTEM_PROMPT, "cache_control": EPHEMERAL}],
            "tools": tools,
            # Без принуждения: на Opus 5.5 tool_choice any/tool — ошибка 400.
            "tool_choice": {"type": "auto"},
            # На Opus 5.5 мышление не выключается; глубину задаёт effort.
            "thinking": {"type": "adaptive"},
            "output_config": {"effort": llm.effort},
            "cache_control": EPHEMERAL,
            "context_management": {"edits": [{"type": "compact_20260112"}]},
            "betas": [COMPACTION_BETA, FALLBACK_BETA] if fallback else [COMPACTION_BETA],
        }
        if fallback:
            self._fixed["fallbacks"] = "default"

    def build(self, messages: Sequence[dict[str, Any]]) -> dict[str, Any]:
        """Аргументы для client.beta.messages.stream(**params)."""
        return {**self._fixed, "messages": list(messages)}
