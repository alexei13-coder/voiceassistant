"""Оценка стоимости ответов Claude по таблице цен (docs/brain.md, «Расходы»).

Цены — оценка в долларах за 1 млн токенов; точные суммы — в консоли Anthropic. Запись
в кэш на 5 минут стоит 1,25 × цены входа, на час — 2 × (оценка по правилам кэширования).
Один ответ может состоять из нескольких «итераций» (серверный цикл поиска, сжатие
контекста, ответ запасной модели) — каждая считается по цене своей модели.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from typing import Any

log = logging.getLogger(__name__)

MILLION = 1_000_000
CACHE_WRITE_5M_MULTIPLIER = 1.25
CACHE_WRITE_1H_MULTIPLIER = 2.0
WEB_SEARCH_USD = 10.0 / 1000  # $10 за 1000 поисков


@dataclass(frozen=True, slots=True)
class Rates:
    """Доллары за 1 млн токенов."""

    input: float
    output: float
    cache_read: float


@dataclass(frozen=True, slots=True)
class ModelPrices:
    base: Rates
    # Haiku 5.5: у длинных запросов (больше long_prompt_tokens во входе) своя, более дорогая цена.
    long_prompt: Rates | None = None
    long_prompt_tokens: int = 0

    def rates_for(self, prompt_tokens: int) -> Rates:
        if self.long_prompt is not None and prompt_tokens > self.long_prompt_tokens:
            return self.long_prompt
        return self.base


PRICES: dict[str, ModelPrices] = {
    "claude-opus-5-5": ModelPrices(Rates(input=4.0, output=20.0, cache_read=0.20)),
    "claude-sonnet-5-5": ModelPrices(Rates(input=2.0, output=10.0, cache_read=0.20)),
    # Чтение кэша — 0,1 × входа (оценка).
    "claude-haiku-5-5": ModelPrices(
        Rates(input=0.10, output=0.50, cache_read=0.01),
        long_prompt=Rates(input=0.50, output=2.50, cache_read=0.05),
        long_prompt_tokens=100_000,
    ),
    # Куда сервер может отправить запрос при ложном отказе (fallbacks: "default").
    "claude-opus-5": ModelPrices(Rates(input=5.0, output=25.0, cache_read=0.50)),
    "claude-opus-4-8": ModelPrices(Rates(input=5.0, output=25.0, cache_read=0.50)),
    "claude-sonnet-5": ModelPrices(Rates(input=2.0, output=10.0, cache_read=0.20)),
}

# Неизвестная модель (опечатка или новая в settings.toml) считается по самой дорогой цене
# таблицы: лимит расходов лучше сработать раньше, чем позже.
UNKNOWN_MODEL_PRICES = ModelPrices(Rates(input=5.0, output=25.0, cache_read=0.50))

_warned_models: set[str] = set()


@dataclass(frozen=True, slots=True)
class TokenUsage:
    """Токены одной итерации ответа."""

    model: str
    input_tokens: int = 0
    output_tokens: int = 0
    cache_read_tokens: int = 0
    cache_write_5m_tokens: int = 0
    cache_write_1h_tokens: int = 0

    @property
    def cache_write_tokens(self) -> int:
        return self.cache_write_5m_tokens + self.cache_write_1h_tokens

    @property
    def prompt_tokens(self) -> int:
        """Весь вход запроса: некэшированный + прочитанный и записанный в кэш."""
        return self.input_tokens + self.cache_read_tokens + self.cache_write_tokens


@dataclass(frozen=True, slots=True)
class ResponseUsage:
    """Всё, за что платят в одном ответе API."""

    iterations: tuple[TokenUsage, ...]
    web_searches: int = 0

    def total(self, field: str) -> int:
        return sum(getattr(item, field) for item in self.iterations)


def prices_for(model: str) -> ModelPrices:
    prices = PRICES.get(model)
    if prices is None:
        if model not in _warned_models:
            _warned_models.add(model)
            log.warning("Нет цены для модели %s — считаю по самой дорогой из таблицы", model)
        return UNKNOWN_MODEL_PRICES
    return prices


def iteration_cost(usage: TokenUsage) -> float:
    rates = prices_for(usage.model).rates_for(usage.prompt_tokens)
    dollars_per_million = (
        usage.input_tokens * rates.input
        + usage.output_tokens * rates.output
        + usage.cache_read_tokens * rates.cache_read
        + usage.cache_write_5m_tokens * rates.input * CACHE_WRITE_5M_MULTIPLIER
        + usage.cache_write_1h_tokens * rates.input * CACHE_WRITE_1H_MULTIPLIER
    )
    return dollars_per_million / MILLION


def response_cost(usage: ResponseUsage) -> float:
    return sum(iteration_cost(item) for item in usage.iterations) + usage.web_searches * WEB_SEARCH_USD


def from_api_usage(usage: Any, model: str) -> ResponseUsage:
    """Разобрать usage ответа API (BetaUsage или его снимок из message_start).

    Если есть usage.iterations, считаются они: в них отдельно видны сжатие контекста (его
    нет в общих полях) и ответ запасной модели со своей ценой. Иначе — общие поля.
    """
    server_tools = getattr(usage, "server_tool_use", None)
    searches = int(getattr(server_tools, "web_search_requests", 0) or 0) if server_tools else 0
    iterations = getattr(usage, "iterations", None) or []
    items = [_token_usage(entry, getattr(entry, "model", None) or model) for entry in iterations]
    if not items:
        items = [_token_usage(usage, model)]
    return ResponseUsage(iterations=tuple(items), web_searches=searches)


def _token_usage(source: Any, model: str) -> TokenUsage:
    cache_write = int(getattr(source, "cache_creation_input_tokens", 0) or 0)
    breakdown = getattr(source, "cache_creation", None)
    write_1h = int(getattr(breakdown, "ephemeral_1h_input_tokens", 0) or 0) if breakdown else 0
    return TokenUsage(
        model=str(model),
        input_tokens=int(getattr(source, "input_tokens", 0) or 0),
        output_tokens=int(getattr(source, "output_tokens", 0) or 0),
        cache_read_tokens=int(getattr(source, "cache_read_input_tokens", 0) or 0),
        cache_write_5m_tokens=max(0, cache_write - write_1h),
        cache_write_1h_tokens=write_1h,
    )
