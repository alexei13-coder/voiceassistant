"""Каждая строка таблицы «Ошибки API → что видит пользователь» (docs/brain.md)."""

from __future__ import annotations

from pathlib import Path

import anthropic
import httpx2
import pytest

from swyvorn.brain import errors

REQUEST = httpx2.Request("POST", "https://api.anthropic.com/v1/messages")


def status_error(status: int, error_type: str, message: str = "x") -> anthropic.APIStatusError:
    body = {"type": "error", "error": {"type": error_type, "message": message}}
    response = httpx2.Response(status, request=REQUEST, json=body)
    return anthropic.AsyncAnthropic(api_key="sk-ant-x", base_url="http://t")._make_status_error(
        f"Error code: {status} - {body}", body=body, response=response
    )


@pytest.mark.parametrize(
    ("exc", "status", "code", "text"),
    [
        (status_error(401, "authentication_error"), "invalid_key", "brain_invalid_key", "Ключ API не подошёл. Проверьте его в console.anthropic.com → API Keys."),
        (status_error(400, "invalid_request_error", errors_credit := "Your credit balance is too low to access the Anthropic API."), "ready", "brain_credit", "На балансе API закончились деньги. Пополните его в console.anthropic.com → Billing."),
        (status_error(402, "billing_error"), "ready", "brain_credit", "На балансе API закончились деньги. Пополните его в console.anthropic.com → Billing."),
        (status_error(403, "permission_error"), "ready", "brain_model_access", "Нет доступа к модели claude-opus-5-5. Проверьте [llm] model в settings.toml."),
        (status_error(404, "not_found_error"), "ready", "brain_model_access", "Нет доступа к модели claude-opus-5-5. Проверьте [llm] model в settings.toml."),
        (status_error(429, "rate_limit_error"), "ready", "brain_rate_limited", "Слишком много запросов — подождите немного."),
        (status_error(500, "api_error"), "ready", "brain_overloaded", "Сервис Claude перегружен, попробуйте ещё раз."),
        (status_error(529, "overloaded_error"), "ready", "brain_overloaded", "Сервис Claude перегружен, попробуйте ещё раз."),
        (anthropic.APIConnectionError(request=REQUEST), "offline", "brain_offline", "Нет связи с Claude. Проверьте интернет."),
        (anthropic.APITimeoutError(request=REQUEST), "offline", "brain_offline", "Нет связи с Claude. Проверьте интернет."),
        (status_error(400, "invalid_request_error", "messages: bad"), "ready", "brain_error", "Не удалось получить ответ от Claude. Подробности — в журнале logs/core.log."),
        (RuntimeError("bug"), "ready", "brain_error", "Не удалось получить ответ от Claude. Подробности — в журнале logs/core.log."),
    ],
)  # fmt: skip
def test_http_errors(exc: BaseException, status: str, code: str, text: str) -> None:
    failure = errors.classify(exc, "claude-opus-5-5")
    assert (failure.status, failure.code, failure.text) == (status, code, text)


@pytest.mark.parametrize(
    ("error_type", "code"),
    [
        ("overloaded_error", "brain_overloaded"),
        ("api_error", "brain_overloaded"),
        ("rate_limit_error", "brain_rate_limited"),
        ("authentication_error", "brain_invalid_key"),
        ("permission_error", "brain_model_access"),
        ("billing_error", "brain_credit"),
        ("something_new", "brain_error"),
    ],
)
def test_errors_inside_open_stream_use_error_type(error_type: str, code: str) -> None:
    """Событие error посреди стрима приходит при HTTP 200 — решает тип ошибки."""
    assert errors.classify(status_error(200, error_type), "m").code == code


def test_refusal_no_key_and_limit_texts(tmp_path: Path) -> None:
    assert (errors.REFUSAL.status, errors.REFUSAL.code, errors.REFUSAL.text) == (
        "ready",
        "brain_refusal",
        "Не могу помочь с этим запросом.",
    )
    no_key = errors.no_key(tmp_path / ".env")
    assert (no_key.status, no_key.code) == ("no_key", "brain_no_key")
    assert no_key.text == (
        f"Ключ API не задан. Добавьте строку ANTHROPIC_API_KEY=… в {tmp_path / '.env'} — "
        "ядро подхватит её без перезапуска."
    )
    limit = errors.limit_reached(10.5, 10)
    assert (limit.status, limit.code) == ("limit", "brain_limit")
    assert "$10.50 из $10.00" in limit.text


def test_env_hint_uses_appdata_form_for_default_windows_folder(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("APPDATA", str(tmp_path))
    assert errors.env_file_hint(tmp_path / "Swyvorn" / ".env") == r"%APPDATA%\Swyvorn\.env"
    assert errors.env_file_hint(tmp_path / "other" / ".env") == str(tmp_path / "other" / ".env")
