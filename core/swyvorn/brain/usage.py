"""Расходы на API: итоги диалога и календарного месяца, <папка данных>/usage.json.

Месяц — по местному времени пользователя: лимит «на октябрь» должен сбрасываться
в его полночь 1 ноября, а не по UTC. Месячные итоги переживают перезапуск ядра.
"""

from __future__ import annotations

import logging
import re
from collections.abc import Callable
from datetime import datetime
from pathlib import Path
from typing import Any

from pydantic import ValidationError

from ..protocol import UsageTotals
from .pricing import ResponseUsage, response_cost
from .storage import CorruptedFileError, quarantine, read_json, write_json_atomic

log = logging.getLogger(__name__)

FILE_VERSION = 1
MONTHS_KEPT = 24
_MONTH_RE = re.compile(r"^\d{4}-\d{2}$")

ZERO = UsageTotals()


def totals_of(usage: ResponseUsage) -> UsageTotals:
    return UsageTotals(
        input_tokens=usage.total("input_tokens"),
        output_tokens=usage.total("output_tokens"),
        cache_read_tokens=usage.total("cache_read_tokens"),
        cache_write_tokens=usage.total("cache_write_tokens"),
        web_searches=usage.web_searches,
        cost_usd=response_cost(usage),
    )


def add(a: UsageTotals, b: UsageTotals) -> UsageTotals:
    return UsageTotals(
        input_tokens=a.input_tokens + b.input_tokens,
        output_tokens=a.output_tokens + b.output_tokens,
        cache_read_tokens=a.cache_read_tokens + b.cache_read_tokens,
        cache_write_tokens=a.cache_write_tokens + b.cache_write_tokens,
        web_searches=a.web_searches + b.web_searches,
        cost_usd=a.cost_usd + b.cost_usd,
    )


def rounded(totals: UsageTotals) -> UsageTotals:
    """Для UI: доли цента дальше шестого знака — шум сложения float."""
    return totals.model_copy(update={"cost_usd": round(totals.cost_usd, 6)})


class UsageTracker:
    def __init__(
        self,
        path: Path,
        *,
        monthly_limit_usd: float,
        clock: Callable[[], datetime] = datetime.now,
    ) -> None:
        self._path = path
        self._clock = clock
        self.monthly_limit_usd = monthly_limit_usd
        self._months: dict[str, UsageTotals] = {}
        self.session = ZERO

    def load(self) -> CorruptedFileError | None:
        try:
            data = read_json(self._path)
        except CorruptedFileError as exc:
            return exc
        months, problem = _parse(data)
        if problem is not None:
            return quarantine(self._path, problem)
        self._months = months
        return None

    @property
    def month(self) -> UsageTotals:
        return self._months.get(self._month_key(), ZERO)

    def record(self, usage: ResponseUsage) -> UsageTotals:
        """Учесть один ответ API; возвращает его итоги."""
        totals = totals_of(usage)
        self.session = add(self.session, totals)
        key = self._month_key()
        self._months[key] = add(self._months.get(key, ZERO), totals)
        self._save()
        return totals

    def reset_session(self) -> None:
        self.session = ZERO

    def limit_reached(self) -> bool:
        return self.monthly_limit_usd > 0 and self.month.cost_usd >= self.monthly_limit_usd

    def _month_key(self) -> str:
        return self._clock().strftime("%Y-%m")

    def _save(self) -> None:
        keep = sorted(self._months)[-MONTHS_KEPT:]
        self._months = {key: self._months[key] for key in keep}
        payload = {"version": FILE_VERSION, "months": {k: v.model_dump() for k, v in self._months.items()}}
        try:
            write_json_atomic(self._path, payload)
        except OSError as exc:
            # Итоги остаются в памяти и запишутся со следующим ответом.
            log.error("Не удалось сохранить расходы в %s: %s", self._path, exc)


def _parse(data: Any) -> tuple[dict[str, UsageTotals], str | None]:
    if data is None:
        return {}, None
    if not isinstance(data, dict) or data.get("version") != FILE_VERSION:
        return {}, "неизвестный формат"
    raw_months = data.get("months")
    if not isinstance(raw_months, dict):
        return {}, "нет раздела months"
    months: dict[str, UsageTotals] = {}
    for key, raw in raw_months.items():
        if not _MONTH_RE.match(str(key)):
            return {}, f"неверный месяц {str(key)[:20]!r}"
        try:
            months[str(key)] = UsageTotals.model_validate(raw)
        except ValidationError:
            return {}, f"неверные итоги за {key}"
    return months, None
