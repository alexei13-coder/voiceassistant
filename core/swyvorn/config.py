"""Настройки (settings.toml) и секреты (.env) — docs/configuration.md.

Опечатка в настройках не должна ронять ядро: каждый ключ проверяется отдельно, неверное
значение заменяется значением по умолчанию с предупреждением в логе.
"""

from __future__ import annotations

import io
import logging
import os
import secrets
import tomllib
from collections.abc import Mapping, MutableMapping, Sequence
from pathlib import Path
from typing import Annotated, Any, Literal

from dotenv import dotenv_values
from pydantic import (
    BaseModel,
    ConfigDict,
    Field,
    SecretStr,
    StringConstraints,
    ValidationError,
    field_validator,
)

from .paths import DataPaths
from .protocol import MAX_TOKEN_LENGTH

log = logging.getLogger(__name__)

API_KEY_ENV = "ANTHROPIC_API_KEY"
IPC_TOKEN_ENV = "SWYVORN_IPC_TOKEN"  # noqa: S105 — имя переменной окружения, а не токен
# Секреты, которые не должны оставаться в окружении процесса после запуска (scrub_secret_environment).
SECRET_ENV_NAMES = (IPC_TOKEN_ENV, API_KEY_ENV)

# Текст файла, который создаётся при первом запуске. Должен совпадать с docs/configuration.md.
DEFAULT_SETTINGS_TOML = """\
[assistant]
name = "SWYVORN"              # имя ассистента (как пишется)
wake_word = "Свайворн"        # как произносится: слово для голосового вызова (этап 3)
address_form = "сэр"          # как обращаться к пользователю; спросим при первом запуске (этап 2)

[llm]
model = "claude-opus-5-5"
effort = "low"                # low | medium | high

[hotkeys]
activate = "Ctrl+Alt+J"       # нажатие — вызов, удержание — говорить, пока держите
stop = "Ctrl+Alt+Escape"      # остановить всё
stop_fallback = "Ctrl+Alt+Backspace"  # если основное сочетание занято
mute = "Ctrl+Alt+M"           # не слушать / слушать
repeat = "Ctrl+Alt+R"         # повторить последний ответ
screen = "Ctrl+Alt+S"         # посмотреть на экран

[ui]
reduced_motion = false        # меньше анимаций для слабых ПК

[demo]
enabled = true                # этап 1: демонстрационный сценарий вместо «мозга»

[logging]
level = "INFO"                # DEBUG | INFO | WARNING | ERROR
"""

# Модификаторы и клавиша через «+»: «Ctrl+Alt+J», «Ctrl+Alt+Escape». Регистрирует сочетание
# оболочка; если система его не примет, придёт hotkey_error.
Hotkey = Annotated[
    str,
    StringConstraints(
        strip_whitespace=True, min_length=1, max_length=64, pattern=r"^[A-Za-z0-9]+(\+[A-Za-z0-9]+)*$"
    ),
]


class _Section(BaseModel):
    # strict: «reduced_motion = "yes"» — ошибка, а не неожиданное True.
    model_config = ConfigDict(strict=True, frozen=True, extra="forbid")


# Только кириллица, пробел и дефис: так слово выглядит в выводе распознавателя речи.
WAKE_WORD_PATTERN = r"^[А-Яа-яЁё][А-Яа-яЁё -]*$"


class AssistantSettings(_Section):
    name: Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=40)] = "SWYVORN"
    # Произношение имени кириллицей: распознаватель речи пишет услышанное по-русски.
    wake_word: Annotated[
        str,
        StringConstraints(strip_whitespace=True, min_length=2, max_length=40, pattern=WAKE_WORD_PATTERN),
    ] = "Свайворн"
    address_form: Annotated[str, StringConstraints(strip_whitespace=True, max_length=40)] = "сэр"


class LlmSettings(_Section):
    model: Annotated[
        str,
        StringConstraints(strip_whitespace=True, min_length=1, max_length=100, pattern=r"^[A-Za-z0-9._:-]+$"),
    ] = "claude-opus-5-5"
    effort: Literal["low", "medium", "high"] = "low"


class HotkeySettings(_Section):
    activate: Hotkey = "Ctrl+Alt+J"
    stop: Hotkey = "Ctrl+Alt+Escape"
    stop_fallback: Hotkey = "Ctrl+Alt+Backspace"
    mute: Hotkey = "Ctrl+Alt+M"
    repeat: Hotkey = "Ctrl+Alt+R"
    screen: Hotkey = "Ctrl+Alt+S"


class UiSettings(_Section):
    reduced_motion: bool = False


class DemoSettings(_Section):
    enabled: bool = True


class LoggingSettings(_Section):
    level: Literal["DEBUG", "INFO", "WARNING", "ERROR"] = "INFO"

    @field_validator("level", mode="before")
    @classmethod
    def _upper(cls, value: object) -> object:
        return value.strip().upper() if isinstance(value, str) else value


class Settings(BaseModel):
    model_config = ConfigDict(frozen=True)

    assistant: AssistantSettings = Field(default_factory=AssistantSettings)
    llm: LlmSettings = Field(default_factory=LlmSettings)
    hotkeys: HotkeySettings = Field(default_factory=HotkeySettings)
    ui: UiSettings = Field(default_factory=UiSettings)
    demo: DemoSettings = Field(default_factory=DemoSettings)
    logging: LoggingSettings = Field(default_factory=LoggingSettings)


_SECTIONS: dict[str, type[_Section]] = {
    "assistant": AssistantSettings,
    "llm": LlmSettings,
    "hotkeys": HotkeySettings,
    "ui": UiSettings,
    "demo": DemoSettings,
    "logging": LoggingSettings,
}


def load_settings(path: Path) -> Settings:
    """Прочитать settings.toml; при отсутствии — создать файл по умолчанию."""
    if not path.exists():
        _write_default(path)
        return Settings()
    try:
        # utf-8-sig: Блокнот Windows может сохранить файл с BOM, tomllib его не принимает.
        text = path.read_bytes().decode("utf-8-sig")
        data = tomllib.loads(text)
    except (OSError, UnicodeDecodeError, tomllib.TOMLDecodeError) as exc:
        log.error("Не удалось прочитать %s (%s) — использую настройки по умолчанию", path, exc)
        return Settings()
    return settings_from_mapping(data)


def settings_from_mapping(data: Mapping[str, Any]) -> Settings:
    sections: dict[str, _Section] = {}
    for name, raw in data.items():
        model = _SECTIONS.get(name)
        if model is None:
            log.warning("Неизвестный раздел настроек [%s] — игнорирую", name)
            continue
        if not isinstance(raw, Mapping):
            log.warning(
                "[%s] должен быть разделом таблицы, а не значением — использую значения по умолчанию", name
            )
            continue
        sections[name] = _load_section(name, model, raw)
    return Settings.model_validate(sections)


def _load_section(name: str, model: type[_Section], raw: Mapping[str, Any]) -> _Section:
    accepted: dict[str, Any] = {}
    for key, value in raw.items():
        if key not in model.model_fields:
            log.warning("Неизвестный ключ настроек [%s] %s — игнорирую", name, key)
            continue
        try:
            # Остальные поля берут значения по умолчанию, поэтому проверяется ровно этот ключ.
            accepted[key] = getattr(model.model_validate({key: value}), key)
        except ValidationError as exc:
            default = model.model_fields[key].default
            reason = exc.errors()[0]["msg"]
            log.warning(
                "Неверное значение [%s] %s = %s (%s) — использую значение по умолчанию %r",
                name,
                key,
                _short_repr(value),
                reason,
                default,
            )
    return model.model_validate(accepted)


def _short_repr(value: object, limit: int = 80) -> str:
    text = repr(value)
    return text if len(text) <= limit else text[: limit - 1] + "…"


def _write_default(path: Path) -> None:
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(DEFAULT_SETTINGS_TOML, encoding="utf-8")
    except OSError as exc:
        log.warning("Не удалось создать %s (%s) — работаю с настройками по умолчанию", path, exc)
    else:
        log.info("Создан файл настроек по умолчанию: %s", path)


# ---------- секреты и .env ----------


class Secrets(BaseModel):
    """SecretStr не раскрывает значение ни в repr, ни в model_dump."""

    model_config = ConfigDict(frozen=True)

    anthropic_api_key: SecretStr | None = None


def repo_root() -> Path | None:
    """Корень репозитория (core/..), если ядро запущено из исходников, а не из сборки."""
    root = Path(__file__).resolve().parents[2]
    return root if (root / "core" / "pyproject.toml").is_file() else None


def env_files(paths: DataPaths, *, dev: bool) -> list[Path]:
    """Файлы .env в порядке убывания приоритета."""
    files = [paths.env_file]
    root = repo_root() if dev else None
    if root is not None and (root / ".env").is_file():
        files.append(root / ".env")
    return files


def read_env_file(path: Path) -> dict[str, str]:
    if not path.is_file():
        return {}
    try:
        text = path.read_bytes().decode("utf-8-sig")
    except (OSError, UnicodeDecodeError) as exc:
        log.warning("Не удалось прочитать %s (%s) — пропускаю", path, exc)
        return {}
    return {key: value for key, value in dotenv_values(stream=io.StringIO(text)).items() if value is not None}


def load_environment(files: Sequence[Path], environ: Mapping[str, str]) -> dict[str, str]:
    """Окружение процесса важнее файлов, файл раньше в списке — важнее следующих.

    Это семантика python-dotenv без override, но без записи в os.environ: секреты из
    файлов не наследуются дочерними процессами (на следующих этапах — PowerShell и т.п.).
    """
    merged: dict[str, str] = {}
    for path in reversed(files):
        merged.update(read_env_file(path))
    merged.update(environ)
    return merged


def scrub_secret_environment(environ: MutableMapping[str, str] = os.environ) -> None:
    """Убрать токен IPC и ключ API из окружения процесса — их унаследовал бы любой дочерний
    процесс (на этапе 4 — PowerShell). Вызывать, когда значения уже прочитаны в память."""
    for name in SECRET_ENV_NAMES:
        environ.pop(name, None)


def load_secrets(env: Mapping[str, str]) -> Secrets:
    key = env.get(API_KEY_ENV, "").strip()
    return Secrets(anthropic_api_key=SecretStr(key) if key else None)


class TokenError(Exception):
    """Нет пригодного токена IPC; текст — для пользователя (уходит в fatal)."""


def resolve_ipc_token(env: Mapping[str, str], *, dev: bool) -> tuple[str, bool]:
    """Токен для WebSocket и признак «сгенерирован ядром» (только в режиме --dev)."""
    token = env.get(IPC_TOKEN_ENV, "").strip()
    if token:
        if len(token) > MAX_TOKEN_LENGTH:
            raise TokenError(f"Токен {IPC_TOKEN_ENV} длиннее {MAX_TOKEN_LENGTH} символов.")
        return token, False
    if dev:
        return secrets.token_urlsafe(24), True
    raise TokenError("Ядро запущено без токена доступа. Запустите SWYVORN через приложение, а не напрямую.")
