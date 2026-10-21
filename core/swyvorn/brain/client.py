"""Клиент Claude API и ключ к нему.

base_url передаётся всегда явно: иначе SDK взял бы ANTHROPIC_BASE_URL из окружения, и
подменённая переменная увела бы ключ на чужой сервер. Свой адрес допускается только
в режиме --dev через SWYVORN_ANTHROPIC_BASE_URL (поддельный сервер API для тестов).
"""

from __future__ import annotations

import logging
from collections.abc import Callable, Mapping
from urllib.parse import urlsplit

import anthropic
from pydantic import SecretStr

from ..logging_setup import REDACTOR

log = logging.getLogger(__name__)

DEFAULT_BASE_URL = "https://api.anthropic.com"
DEV_BASE_URL_ENV = "SWYVORN_ANTHROPIC_BASE_URL"
MAX_RETRIES = 2
# Чтение — между событиями стрима: при долгом мышлении сервер шлёт ping, тишина дольше
# двух минут — это обрыв связи, а не раздумья.
TIMEOUT = anthropic.Timeout(120.0, connect=10.0)

ClientFactory = Callable[[SecretStr], anthropic.AsyncAnthropic]


def resolve_base_url(env: Mapping[str, str], *, dev: bool) -> str:
    override = env.get(DEV_BASE_URL_ENV, "").strip()
    if not override:
        return DEFAULT_BASE_URL
    if not dev:
        log.warning("%s задана, но ядро запущено без --dev — переменная игнорируется", DEV_BASE_URL_ENV)
        return DEFAULT_BASE_URL
    if urlsplit(override).scheme not in ("http", "https"):
        log.warning("%s должна быть адресом http(s):// — игнорирую", DEV_BASE_URL_ENV)
        return DEFAULT_BASE_URL
    log.warning("Режим разработки: запросы к Claude идут на %s, а не в Anthropic", override)
    return override


def make_client(
    api_key: SecretStr,
    *,
    base_url: str = DEFAULT_BASE_URL,
    http_client: anthropic.DefaultAsyncHttpxClient | None = None,
    max_retries: int = MAX_RETRIES,
) -> anthropic.AsyncAnthropic:
    """Явный api_key: SDK не ищет учётные данные в окружении и профилях на диске."""
    return anthropic.AsyncAnthropic(
        api_key=api_key.get_secret_value(),
        base_url=base_url,
        timeout=TIMEOUT,
        max_retries=max_retries,
        http_client=http_client,
    )


class KeyStore:
    """Текущий ключ API и его повторное чтение из .env (no_key / invalid_key)."""

    def __init__(self, key: SecretStr | None, loader: Callable[[], SecretStr | None]) -> None:
        self._loader = loader
        self._key = key
        if key is not None:
            REDACTOR.register(key.get_secret_value())

    @property
    def key(self) -> SecretStr | None:
        return self._key

    def reload(self) -> bool:
        """Перечитать ключ. True — он изменился (появился, сменился или пропал)."""
        key = self._loader()
        if key is not None:
            # Сразу: ключ не должен попасть в лог даже в сообщении о его же ошибке.
            REDACTOR.register(key.get_secret_value())
        changed = _value(key) != _value(self._key)
        self._key = key
        if changed:
            log.info("Ключ API перечитан из .env: %s", "задан" if key is not None else "не задан")
        return changed


def _value(key: SecretStr | None) -> str | None:
    return key.get_secret_value() if key is not None else None
