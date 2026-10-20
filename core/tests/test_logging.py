from __future__ import annotations

import io
import logging
import sys
import threading
from collections.abc import Iterator
from pathlib import Path

import pytest

from jarvis.logging_setup import REDACTED, SecretRedactor, setup_logging

SECRET_TOKEN = "ipc-Token-Value-42xyz"
API_KEY = "sk-ant-api03-AbCdEf0123456789_-zz"


@pytest.fixture
def redactor() -> SecretRedactor:
    r = SecretRedactor()
    r.register(SECRET_TOKEN)
    return r


@pytest.fixture
def logged(
    tmp_path: Path, redactor: SecretRedactor, monkeypatch: pytest.MonkeyPatch
) -> Iterator[tuple[io.StringIO, Path]]:
    """Наше логирование в StringIO и файл; после теста — снять обработчики и вернуть хуки."""
    monkeypatch.setattr(sys, "excepthook", sys.excepthook)
    monkeypatch.setattr(threading, "excepthook", threading.excepthook)
    stream = io.StringIO()
    log_file = tmp_path / "logs" / "core.log"
    setup_logging(level="DEBUG", log_file=log_file, stream=stream, redactor=redactor)
    yield stream, log_file
    root = logging.getLogger()
    for handler in [h for h in root.handlers if h.get_name() == "jarvis"]:
        root.removeHandler(handler)
        handler.close()
    root.setLevel(logging.WARNING)


@pytest.mark.parametrize(
    ("text", "leak"),
    [
        (f"токен {SECRET_TOKEN} пришёл", SECRET_TOKEN),
        (f"ключ {API_KEY}", API_KEY),
        ("ANTHROPIC_API_KEY=abc123secret", "abc123secret"),
        ("api-key: qwerty987", "qwerty987"),
        ("JARVIS_IPC_TOKEN=zzz111", "zzz111"),
        ("{'token': 'tok-in-repr'}", "tok-in-repr"),
        ('{"password": "hunter2"}', "hunter2"),
        ("client_secret=s3cr3t&x=1", "s3cr3t"),
        ("Authorization: Bearer eyJhbGciOi.abc", "eyJhbGciOi"),
    ],
)
def test_redact_patterns(redactor: SecretRedactor, text: str, leak: str) -> None:
    result = redactor.redact(text)
    assert leak not in result
    assert REDACTED in result


def test_redact_keeps_ordinary_text(redactor: SecretRedactor) -> None:
    text = "max_tokens=256, состояние idle, токены не трогаем"
    assert redactor.redact(text) == text


def test_short_values_are_not_registered() -> None:
    r = SecretRedactor()
    r.register("ab")
    r.register("")
    r.register(None)
    assert r.redact_values("ab ab") == "ab ab"


def test_longer_secret_wins_over_prefix() -> None:
    r = SecretRedactor()
    r.register("abcd")
    r.register("abcdefgh")
    assert r.redact_values("x abcdefgh y") == f"x {REDACTED} y"


def test_redact_values_skips_key_value_heuristic(redactor: SecretRedactor) -> None:
    # Для сообщений протокола: «пароль: 123» в чате пользователя — не секрет ядра.
    assert redactor.redact_values("password: 123") == "password: 123"
    assert SECRET_TOKEN not in redactor.redact_values(f"echo {SECRET_TOKEN}")


def test_log_message_and_args_redacted_in_all_handlers(logged: tuple[io.StringIO, Path]) -> None:
    stream, log_file = logged
    logging.getLogger("jarvis.test").info("токен=%s и ключ %s", SECRET_TOKEN, API_KEY)
    for handler in logging.getLogger().handlers:
        handler.flush()
    for text in (stream.getvalue(), log_file.read_text(encoding="utf-8")):
        assert SECRET_TOKEN not in text
        assert API_KEY not in text
        assert REDACTED in text


def test_traceback_redacted(logged: tuple[io.StringIO, Path]) -> None:
    stream, log_file = logged
    try:
        raise ValueError(f"плохой токен {SECRET_TOKEN} api_key={API_KEY}")
    except ValueError:
        logging.getLogger("jarvis.test").exception("сбой")
    for handler in logging.getLogger().handlers:
        handler.flush()
    for text in (stream.getvalue(), log_file.read_text(encoding="utf-8")):
        assert "Traceback" in text
        assert "ValueError" in text
        assert SECRET_TOKEN not in text
        assert API_KEY not in text


def test_uncaught_exception_hook_goes_through_filter(logged: tuple[io.StringIO, Path]) -> None:
    stream, _ = logged
    try:
        raise RuntimeError(SECRET_TOKEN)
    except RuntimeError as exc:
        sys.excepthook(type(exc), exc, exc.__traceback__)
    assert "Необработанное исключение" in stream.getvalue()
    assert SECRET_TOKEN not in stream.getvalue()


def test_bad_format_args_do_not_leak(logged: tuple[io.StringIO, Path]) -> None:
    stream, _ = logged
    logging.getLogger("jarvis.test").warning("%d", SECRET_TOKEN)
    assert SECRET_TOKEN not in stream.getvalue()


def test_never_writes_to_stdout(logged: tuple[io.StringIO, Path], capsys: pytest.CaptureFixture[str]) -> None:
    logging.getLogger("jarvis.test").error("ошибка для проверки")
    assert capsys.readouterr().out == ""


def test_setup_is_idempotent(
    logged: tuple[io.StringIO, Path], tmp_path: Path, redactor: SecretRedactor
) -> None:
    setup_logging(
        level="INFO", log_file=tmp_path / "logs" / "core.log", stream=io.StringIO(), redactor=redactor
    )
    ours = [h for h in logging.getLogger().handlers if h.get_name() == "jarvis"]
    assert len(ours) == 2


def test_unwritable_log_file_falls_back_to_stderr(
    tmp_path: Path, redactor: SecretRedactor, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(sys, "excepthook", sys.excepthook)
    monkeypatch.setattr(threading, "excepthook", threading.excepthook)
    blocker = tmp_path / "file"
    blocker.write_text("не папка", encoding="utf-8")
    stream = io.StringIO()
    try:
        setup_logging(level="INFO", log_file=blocker / "logs" / "core.log", stream=stream, redactor=redactor)
        assert "Файл журнала недоступен" in stream.getvalue()
    finally:
        root = logging.getLogger()
        for handler in [h for h in root.handlers if h.get_name() == "jarvis"]:
            root.removeHandler(handler)
            handler.close()
