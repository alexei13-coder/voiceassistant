"""Стоимость ответа по usage: входные, выходные, кэш, поиски, итерации разных моделей."""

from __future__ import annotations

import logging
from types import SimpleNamespace

import pytest

from swyvorn.brain.pricing import (
    WEB_SEARCH_USD,
    ResponseUsage,
    TokenUsage,
    from_api_usage,
    iteration_cost,
    response_cost,
)

M = 1_000_000


def usage(**fields: object) -> SimpleNamespace:
    """Как BetaUsage: отсутствующие поля SDK отдаёт как None."""
    base: dict[str, object] = {
        "input_tokens": 0,
        "output_tokens": 0,
        "cache_read_input_tokens": None,
        "cache_creation_input_tokens": None,
        "cache_creation": None,
        "server_tool_use": None,
        "iterations": None,
    }
    return SimpleNamespace(**(base | fields))


@pytest.mark.parametrize(
    ("model", "input_price", "output_price", "cache_read_price"),
    [
        ("claude-opus-5-5", 4.0, 20.0, 0.20),
        ("claude-sonnet-5-5", 2.0, 10.0, 0.20),
        ("claude-haiku-5-5", 0.10, 0.50, 0.01),
    ],
)
def test_price_table(model: str, input_price: float, output_price: float, cache_read_price: float) -> None:
    n = 50_000  # меньше порога «длинного запроса» Haiku: считается по основной цене
    assert iteration_cost(TokenUsage(model, input_tokens=n)) == pytest.approx(input_price * n / M)
    assert iteration_cost(TokenUsage(model, output_tokens=n)) == pytest.approx(output_price * n / M)
    assert iteration_cost(TokenUsage(model, cache_read_tokens=n)) == pytest.approx(cache_read_price * n / M)
    # Запись в кэш — оценка: 1,25 × вход на 5 минут, 2 × на час.
    assert iteration_cost(TokenUsage(model, cache_write_5m_tokens=n)) == pytest.approx(input_price * 1.25 * n / M)
    assert iteration_cost(TokenUsage(model, cache_write_1h_tokens=n)) == pytest.approx(input_price * 2 * n / M)


def test_realistic_opus_turn() -> None:
    cost = iteration_cost(
        TokenUsage(
            "claude-opus-5-5",
            input_tokens=300,
            output_tokens=150,
            cache_read_tokens=2000,
            cache_write_5m_tokens=400,
        )
    )
    expected = (300 * 4 + 150 * 20 + 2000 * 0.2 + 400 * 5) / M
    assert cost == pytest.approx(expected)


def test_haiku_long_prompt_uses_second_rate_card() -> None:
    short = TokenUsage("claude-haiku-5-5", input_tokens=60_000, cache_read_tokens=40_000, output_tokens=1000)
    long = TokenUsage("claude-haiku-5-5", input_tokens=60_001, cache_read_tokens=40_000, output_tokens=1000)
    assert iteration_cost(short) == pytest.approx((60_000 * 0.10 + 40_000 * 0.01 + 1000 * 0.50) / M)
    assert iteration_cost(long) == pytest.approx((60_001 * 0.50 + 40_000 * 0.05 + 1000 * 2.50) / M)


def test_web_searches_are_billed_per_request() -> None:
    response = ResponseUsage(iterations=(TokenUsage("claude-opus-5-5"),), web_searches=3)
    assert response_cost(response) == pytest.approx(3 * WEB_SEARCH_USD) == pytest.approx(0.03)


def test_unknown_model_is_priced_conservatively_and_warned_once(caplog: pytest.LogCaptureFixture) -> None:
    caplog.set_level(logging.WARNING)
    unknown = TokenUsage("claude-future-9", input_tokens=M)
    assert iteration_cost(unknown) == pytest.approx(5.0)
    assert iteration_cost(unknown) == pytest.approx(5.0)
    assert caplog.text.count("claude-future-9") == 1


def test_from_api_usage_top_level_fields() -> None:
    parsed = from_api_usage(
        usage(
            input_tokens=100,
            output_tokens=50,
            cache_read_input_tokens=2000,
            cache_creation_input_tokens=300,
            server_tool_use=SimpleNamespace(web_search_requests=2, web_fetch_requests=0),
        ),
        "claude-opus-5-5",
    )
    assert parsed.web_searches == 2
    assert parsed.iterations == (
        TokenUsage(
            "claude-opus-5-5", input_tokens=100, output_tokens=50, cache_read_tokens=2000, cache_write_5m_tokens=300
        ),
    )


def test_from_api_usage_splits_cache_ttl() -> None:
    parsed = from_api_usage(
        usage(
            input_tokens=1,
            cache_creation_input_tokens=1000,
            cache_creation=SimpleNamespace(ephemeral_5m_input_tokens=600, ephemeral_1h_input_tokens=400),
        ),
        "claude-opus-5-5",
    )
    assert parsed.iterations[0].cache_write_5m_tokens == 600
    assert parsed.iterations[0].cache_write_1h_tokens == 400


def test_iterations_are_priced_by_their_own_model() -> None:
    """Сжатие контекста не входит в общие поля usage, а ответ запасной модели — по её цене."""
    iterations = [
        SimpleNamespace(type="compaction", input_tokens=10_000, output_tokens=1000, cache_read_input_tokens=0,
                        cache_creation_input_tokens=0, cache_creation=None),
        SimpleNamespace(type="message", model="claude-opus-5-5", input_tokens=500, output_tokens=0,
                        cache_read_input_tokens=0, cache_creation_input_tokens=0, cache_creation=None),
        SimpleNamespace(type="fallback_message", model="claude-opus-5", input_tokens=500, output_tokens=200,
                        cache_read_input_tokens=0, cache_creation_input_tokens=0, cache_creation=None),
    ]  # fmt: skip
    parsed = from_api_usage(usage(input_tokens=500, output_tokens=200, iterations=iterations), "claude-opus-5-5")
    assert [item.model for item in parsed.iterations] == ["claude-opus-5-5", "claude-opus-5-5", "claude-opus-5"]
    expected = (10_000 * 4 + 1000 * 20 + 500 * 4 + 500 * 5 + 200 * 25) / M
    assert response_cost(parsed) == pytest.approx(expected)
    assert parsed.total("input_tokens") == 11_000
