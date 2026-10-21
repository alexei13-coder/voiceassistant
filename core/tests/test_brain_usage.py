"""Итоги расходов: диалог и месяц, usage.json, смена месяца, лимит, испорченный файл."""

from __future__ import annotations

import json
from datetime import datetime
from pathlib import Path

import pytest

from swyvorn.brain.pricing import ResponseUsage, TokenUsage
from swyvorn.brain.usage import UsageTracker


def one_dollar_output() -> ResponseUsage:
    # 50 000 выходных токенов Opus 5.5 по $20 за миллион = $1.
    return ResponseUsage(iterations=(TokenUsage("claude-opus-5-5", output_tokens=50_000),))


class Clock:
    def __init__(self, now: datetime) -> None:
        self.now = now

    def __call__(self) -> datetime:
        return self.now


def test_record_adds_to_session_and_month(tmp_path: Path) -> None:
    tracker = UsageTracker(tmp_path / "usage.json", monthly_limit_usd=0, clock=Clock(datetime(2026, 10, 21)))
    totals = tracker.record(
        ResponseUsage(
            iterations=(TokenUsage("claude-opus-5-5", input_tokens=100, output_tokens=10, cache_read_tokens=5),),
            web_searches=1,
        )
    )
    assert (totals.input_tokens, totals.output_tokens, totals.cache_read_tokens, totals.web_searches) == (100, 10, 5, 1)
    tracker.record(one_dollar_output())
    assert tracker.session.output_tokens == 50_010
    assert tracker.month.cost_usd == pytest.approx(totals.cost_usd + 1.0)


def test_month_totals_survive_restart_session_does_not(tmp_path: Path) -> None:
    path = tmp_path / "usage.json"
    clock = Clock(datetime(2026, 10, 21))
    first = UsageTracker(path, monthly_limit_usd=0, clock=clock)
    first.record(one_dollar_output())
    data = json.loads(path.read_text(encoding="utf-8"))
    assert data["version"] == 1
    assert data["months"]["2026-10"]["cost_usd"] == pytest.approx(1.0)

    second = UsageTracker(path, monthly_limit_usd=0, clock=clock)
    assert second.load() is None
    assert second.month.cost_usd == pytest.approx(1.0)
    assert second.session.cost_usd == 0


def test_month_rollover_starts_from_zero_and_keeps_history(tmp_path: Path) -> None:
    path = tmp_path / "usage.json"
    clock = Clock(datetime(2026, 10, 31, 23, 59))
    tracker = UsageTracker(path, monthly_limit_usd=1.5, clock=clock)
    tracker.record(one_dollar_output())
    tracker.record(one_dollar_output())
    assert tracker.limit_reached()

    clock.now = datetime(2026, 11, 1, 0, 0)  # местная полночь — новый месяц
    assert tracker.month.cost_usd == 0
    assert not tracker.limit_reached()
    assert tracker.session.cost_usd == pytest.approx(2.0)  # диалог тот же
    tracker.record(one_dollar_output())
    months = json.loads(path.read_text(encoding="utf-8"))["months"]
    assert months["2026-10"]["cost_usd"] == pytest.approx(2.0)
    assert months["2026-11"]["cost_usd"] == pytest.approx(1.0)


def test_limit_zero_means_unlimited_and_limit_is_inclusive(tmp_path: Path) -> None:
    tracker = UsageTracker(tmp_path / "usage.json", monthly_limit_usd=0, clock=Clock(datetime(2026, 10, 1)))
    for _ in range(3):
        tracker.record(one_dollar_output())
    assert not tracker.limit_reached()
    tracker.monthly_limit_usd = 3.0
    assert tracker.limit_reached()


def test_reset_session(tmp_path: Path) -> None:
    tracker = UsageTracker(tmp_path / "usage.json", monthly_limit_usd=0, clock=Clock(datetime(2026, 10, 1)))
    tracker.record(one_dollar_output())
    tracker.reset_session()
    assert tracker.session.cost_usd == 0
    assert tracker.month.cost_usd == pytest.approx(1.0)


def test_old_months_are_pruned(tmp_path: Path) -> None:
    clock = Clock(datetime(2024, 1, 1))
    tracker = UsageTracker(tmp_path / "usage.json", monthly_limit_usd=0, clock=clock)
    for month in range(30):
        clock.now = datetime(2024 + month // 12, month % 12 + 1, 1)
        tracker.record(one_dollar_output())
    months = json.loads((tmp_path / "usage.json").read_text(encoding="utf-8"))["months"]
    assert len(months) == 24
    assert min(months) == "2024-07"


@pytest.mark.parametrize(
    "content",
    [
        "не json",
        "[]",
        '{"version": 2, "months": {}}',
        '{"version": 1, "months": []}',
        '{"version": 1, "months": {"октябрь": {}}}',
        '{"version": 1, "months": {"2026-10": {"cost_usd": "много"}}}',
    ],
)
def test_corrupted_file_is_backed_up(tmp_path: Path, content: str) -> None:
    path = tmp_path / "usage.json"
    path.write_text(content, encoding="utf-8")
    tracker = UsageTracker(path, monthly_limit_usd=0, clock=Clock(datetime(2026, 10, 1)))
    problem = tracker.load()
    assert problem is not None
    assert problem.backup is not None
    assert problem.backup.read_text(encoding="utf-8") == content
    assert not path.exists()
    assert tracker.month.cost_usd == 0
