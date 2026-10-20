from __future__ import annotations

import asyncio
import time
from datetime import datetime
from types import SimpleNamespace

import pytest

from swyvorn import metrics as metrics_module
from swyvorn.metrics import MetricsSampler
from swyvorn.protocol import MetricsMessage


def test_sample_has_all_fields_in_sane_ranges() -> None:
    sampler = MetricsSampler(lambda _m: None, started_at=time.monotonic() - 5)
    sample = sampler.sample()
    assert 0 <= sample.cpu_percent <= 100
    assert 0 <= sample.ram_percent <= 100
    assert 0 < sample.ram_used_mb <= sample.ram_total_mb
    assert sample.net_up_bps >= 0
    assert sample.net_down_bps >= 0
    assert sample.uptime_s >= 5
    parsed = datetime.fromisoformat(sample.time_iso)
    assert parsed.tzinfo is not None
    assert set(sample.model_dump()) == {
        "type", "cpu_percent", "ram_percent", "ram_used_mb", "ram_total_mb",
        "net_up_bps", "net_down_bps", "uptime_s", "time_iso",
    }  # fmt: skip


def test_net_rate_and_counter_reset(monkeypatch: pytest.MonkeyPatch) -> None:
    counters = iter(
        [
            SimpleNamespace(bytes_sent=1_000, bytes_recv=5_000),  # конструктор
            SimpleNamespace(bytes_sent=3_000, bytes_recv=9_000),
            SimpleNamespace(bytes_sent=10, bytes_recv=20),  # счётчик обнулился
            SimpleNamespace(bytes_sent=1_010, bytes_recv=2_020),
        ]
    )
    clock = iter([100.0, 102.0, 103.0, 104.0])
    monkeypatch.setattr(metrics_module.psutil, "net_io_counters", lambda: next(counters))
    monkeypatch.setattr(metrics_module.time, "monotonic", lambda: next(clock))
    sampler = MetricsSampler(lambda _m: None, started_at=0.0)
    assert sampler._read_net() == (1_000, 2_000)
    assert sampler._read_net() == (0, 0)
    assert sampler._read_net() == (1_000, 2_000)


def test_net_counters_unavailable(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(metrics_module.psutil, "net_io_counters", lambda: None)
    sampler = MetricsSampler(lambda _m: None)
    assert sampler._read_net() == (0, 0)


async def test_sampler_publishes_periodically() -> None:
    published: list[MetricsMessage] = []
    enough = asyncio.Event()

    def publish(message: MetricsMessage) -> None:
        published.append(message)
        if len(published) >= 3:
            enough.set()

    sampler = MetricsSampler(publish, interval=0.05)
    sampler.start()
    try:
        await asyncio.wait_for(enough.wait(), 2)
    finally:
        await sampler.stop()
    assert all(isinstance(m, MetricsMessage) for m in published)
