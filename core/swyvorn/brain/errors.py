"""Ошибки API → что видит пользователь (docs/brain.md, таблица «Ошибки API»).

Типизированные исключения SDK разбираются от частного к общему. Ошибка посреди уже
открытого стрима приходит событием error при HTTP 200 — тогда SDK бросает базовый
APIStatusError, и решает поле type из тела ошибки.
"""

from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path

import anthropic

from ..protocol import BrainStatus, NoticeLevel


@dataclass(frozen=True, slots=True)
class Failure:
    """Почему ответа нет: новый статус «мозга», уведомление и системное сообщение в чат."""

    status: BrainStatus
    code: str
    level: NoticeLevel
    text: str


INVALID_KEY = Failure(
    "invalid_key",
    "brain_invalid_key",
    "error",
    "Ключ API не подошёл. Проверьте его в console.anthropic.com → API Keys.",
)
CREDIT = Failure(
    "ready",
    "brain_credit",
    "error",
    "На балансе API закончились деньги. Пополните его в console.anthropic.com → Billing.",
)
RATE_LIMITED = Failure(
    "ready", "brain_rate_limited", "warning", "Слишком много запросов — подождите немного."
)
OVERLOADED = Failure("ready", "brain_overloaded", "warning", "Сервис Claude перегружен, попробуйте ещё раз.")
OFFLINE = Failure("offline", "brain_offline", "warning", "Нет связи с Claude. Проверьте интернет.")
REFUSAL = Failure("ready", "brain_refusal", "info", "Не могу помочь с этим запросом.")
UNEXPECTED = Failure(
    "ready",
    "brain_error",
    "error",
    "Не удалось получить ответ от Claude. Подробности — в журнале logs/core.log.",
)


def model_access(model: str) -> Failure:
    return Failure(
        "ready",
        "brain_model_access",
        "error",
        f"Нет доступа к модели {model}. Проверьте [llm] model в settings.toml.",
    )


def no_key(env_file: Path) -> Failure:
    return Failure(
        "no_key",
        "brain_no_key",
        "warning",
        f"Ключ API не задан. Добавьте строку ANTHROPIC_API_KEY=… в {env_file_hint(env_file)} — "
        "ядро подхватит её без перезапуска.",
    )


def limit_reached(spent_usd: float, limit_usd: float) -> Failure:
    return Failure(
        "limit",
        "brain_limit",
        "warning",
        f"Достигнут месячный лимит расходов на API: ${spent_usd:.2f} из ${limit_usd:.2f}. Запросы не "
        "отправляются — поднимите [llm] monthly_limit_usd в settings.toml или дождитесь нового месяца.",
    )


def env_file_hint(env_file: Path) -> str:
    """Путь к .env так, как его проще найти: для папки по умолчанию на Windows — %APPDATA%\\…"""
    appdata = os.environ.get("APPDATA")
    if appdata and env_file == Path(appdata) / "Swyvorn" / ".env":
        return r"%APPDATA%\Swyvorn\.env"
    return str(env_file)


_BY_ERROR_TYPE = {
    "authentication_error": INVALID_KEY,
    "billing_error": CREDIT,
    "rate_limit_error": RATE_LIMITED,
    "overloaded_error": OVERLOADED,
    "api_error": OVERLOADED,
}


def classify(exc: BaseException, model: str) -> Failure:
    """Сопоставить исключение SDK строке таблицы; всё прочее — brain_error."""
    if isinstance(exc, anthropic.AuthenticationError):
        return INVALID_KEY
    if isinstance(exc, anthropic.PermissionDeniedError | anthropic.NotFoundError):
        return model_access(model)
    if isinstance(exc, anthropic.RateLimitError):
        return RATE_LIMITED
    if isinstance(exc, anthropic.BadRequestError):
        return CREDIT if _is_credit_problem(exc) else UNEXPECTED
    if isinstance(exc, anthropic.APIStatusError):
        if exc.status_code == 402 or _is_credit_problem(exc):
            return CREDIT
        if exc.status_code >= 500:
            return OVERLOADED
        if exc.type in ("permission_error", "not_found_error"):
            return model_access(model)
        return _BY_ERROR_TYPE.get(exc.type or "", UNEXPECTED)
    # APITimeoutError — подкласс APIConnectionError: для пользователя это тоже «нет связи».
    if isinstance(exc, anthropic.APIConnectionError):
        return OFFLINE
    return UNEXPECTED


def _is_credit_problem(exc: anthropic.APIStatusError) -> bool:
    return exc.type == "billing_error" or "credit balance" in exc.message.lower()
