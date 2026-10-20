"""Логирование ядра: stderr + core.log с ротацией, секреты вырезаются из каждой записи.

stdout сюда не попадает никогда — это управляющий канал оболочки (docs/protocol.md §2).
Файл можно подключить позже (attach_log_file): до проверки прав администратора ядро
не создаёт на диске ничего, а первые записи всё равно попадут в core.log.
"""

from __future__ import annotations

import logging
import re
import sys
import threading
from collections import deque
from logging.handlers import RotatingFileHandler
from pathlib import Path
from types import TracebackType
from typing import TextIO

REDACTED = "[скрыто]"

# Короче этого значение не считается секретом: иначе фильтр испортил бы весь лог.
MIN_SECRET_LENGTH = 4

LOG_FILE_MAX_BYTES = 1024 * 1024
# core.log + 4 архива = 5 файлов, как в docs/configuration.md.
LOG_FILE_BACKUPS = 4

# Сколько записей держать до подключения файла: при запуске их единицы.
EARLY_RECORDS_LIMIT = 200

_FORMAT = "%(asctime)s %(levelname)-7s %(name)s: %(message)s"
_HANDLER_NAME = "swyvorn"

_ANTHROPIC_KEY_RE = re.compile(r"sk-ant-[A-Za-z0-9_-]{8,}")

# Пары «ключ=значение» и «ключ: значение», в т.ч. JSON/repr ('token': 'x') и заголовки
# (Authorization: Bearer x). Окончание «\b» не даёт сработать на «max_tokens=…».
_KEY_VALUE_RE = re.compile(
    r"""
    (?P<key>[\w-]*(?:api[_-]?key|token|secret|password|authorization)(?:[_-]?key)?)\b
    (?P<sep>["']?\s*[:=]\s*)
    (?P<value>(?:(?:bearer|basic)\s+)?(?:"[^"]*"|'[^']*'|[^\s"',;&}\]]+))
    """,
    re.IGNORECASE | re.VERBOSE,
)


class SecretRedactor:
    """Реестр секретов и вырезание их из текста. Потокобезопасен: логируют и потоки."""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._values: set[str] = set()
        self._values_re: re.Pattern[str] | None = None

    def register(self, value: str | None) -> None:
        """Зарегистрировать секрет сразу, как только он стал известен."""
        if not value or len(value) < MIN_SECRET_LENGTH:
            return
        with self._lock:
            if value in self._values:
                return
            self._values.add(value)
            # Длинные первыми, чтобы секрет-префикс не оставил хвост другого секрета.
            alternatives = sorted(self._values, key=len, reverse=True)
            self._values_re = re.compile("|".join(re.escape(v) for v in alternatives))

    def redact_values(self, text: str) -> str:
        """Только известные значения и ключи Anthropic — для исходящих сообщений протокола,
        где эвристика «ключ=значение» испортила бы обычный текст пользователя."""
        pattern = self._values_re
        if pattern is not None:
            text = pattern.sub(REDACTED, text)
        return _ANTHROPIC_KEY_RE.sub(REDACTED, text)

    def redact(self, text: str) -> str:
        """Полная очистка для логов."""
        text = self.redact_values(text)
        return _KEY_VALUE_RE.sub(lambda m: f"{m['key']}{m['sep']}{REDACTED}", text)


REDACTOR = SecretRedactor()


class SecretRedactingFilter(logging.Filter):
    """Сначала форматирует запись (сообщение, исключение, стек), затем вырезает секреты.

    Висит на каждом обработчике, поэтому чистит и записи сторонних библиотек.
    """

    def __init__(self, redactor: SecretRedactor = REDACTOR) -> None:
        super().__init__()
        self._redactor = redactor
        self._formatter = logging.Formatter()

    def filter(self, record: logging.LogRecord) -> bool:
        try:
            message = record.getMessage()
        except Exception:
            # Кривой формат не должен ронять лог и выводить сырые args мимо фильтра.
            message = f"{record.msg!r} (не удалось подставить аргументы)"
        record.msg = self._redactor.redact(message)
        record.args = None
        if record.exc_info:
            if not record.exc_text:
                record.exc_text = self._formatter.formatException(record.exc_info)
            # Без exc_info ни один обработчик не отрисует трассировку заново, без фильтра.
            record.exc_info = None
        if record.exc_text:
            record.exc_text = self._redactor.redact(record.exc_text)
        if record.stack_info:
            record.stack_info = self._redactor.redact(record.stack_info)
        return True


class _EarlyRecords(logging.Handler):
    """Записи, сделанные до появления core.log; attach_log_file допишет их в файл."""

    def __init__(self) -> None:
        super().__init__()
        self.records: deque[logging.LogRecord] = deque(maxlen=EARLY_RECORDS_LIMIT)

    def emit(self, record: logging.LogRecord) -> None:
        self.records.append(record)


def _make_handler(handler: logging.Handler, redactor: SecretRedactor) -> logging.Handler:
    handler.setFormatter(logging.Formatter(_FORMAT))
    handler.addFilter(SecretRedactingFilter(redactor))
    handler.set_name(_HANDLER_NAME)
    return handler


def setup_logging(
    *,
    level: str = "INFO",
    log_file: Path | None,
    stream: TextIO | None = None,
    redactor: SecretRedactor = REDACTOR,
) -> None:
    """Настроить корневой логгер. Повторный вызов заменяет свои обработчики, а не дублирует их;
    чужие (например, pytest) не трогает.

    Без log_file — только stderr, а записи копятся до attach_log_file: так ядро ничего
    не пишет на диск, пока не убедится, что запущено не от имени администратора.
    """
    root = logging.getLogger()
    for handler in [h for h in root.handlers if h.get_name() == _HANDLER_NAME]:
        root.removeHandler(handler)
        handler.close()

    root.addHandler(_make_handler(logging.StreamHandler(stream or sys.stderr), redactor))
    if log_file is None:
        root.addHandler(_make_handler(_EarlyRecords(), redactor))

    set_level(level)
    logging.captureWarnings(True)
    _install_excepthooks()
    if log_file is not None:
        attach_log_file(log_file, redactor=redactor)


def attach_log_file(log_file: Path, *, redactor: SecretRedactor = REDACTOR) -> bool:
    """Подключить core.log с ротацией (папка создаётся здесь) и дописать в него записи,
    накопленные с setup_logging(log_file=None). False — файл недоступен, журнал только в stderr."""
    root = logging.getLogger()
    early = next((h for h in root.handlers if isinstance(h, _EarlyRecords)), None)
    if early is not None:
        root.removeHandler(early)
        early.close()
    try:
        log_file.parent.mkdir(parents=True, exist_ok=True)
        file_handler = RotatingFileHandler(
            log_file,
            maxBytes=LOG_FILE_MAX_BYTES,
            backupCount=LOG_FILE_BACKUPS,
            encoding="utf-8",
            errors="backslashreplace",
            delay=True,
        )
    except OSError as exc:
        logging.getLogger(__name__).warning("Файл журнала недоступен (%s), пишу только в stderr", exc)
        return False
    _make_handler(file_handler, redactor)
    if early is not None:
        # Записи уже прошли фильтр секретов; повторная очистка ничего не портит.
        for record in early.records:
            file_handler.handle(record)
    root.addHandler(file_handler)
    return True


def set_level(level: str) -> None:
    logging.getLogger().setLevel(level)
    # websockets на INFO сообщает о каждом отклонённом рукопожатии — это шум, не события.
    logging.getLogger("websockets").setLevel(logging.DEBUG if level == "DEBUG" else logging.WARNING)


def _install_excepthooks() -> None:
    """Стандартные хуки печатают трассировку в stderr мимо фильтра — направляем их в лог."""
    log = logging.getLogger("swyvorn")

    def excepthook(exc_type: type[BaseException], exc: BaseException, tb: TracebackType | None) -> None:
        log.critical("Необработанное исключение", exc_info=(exc_type, exc, tb))

    def thread_excepthook(args: threading.ExceptHookArgs) -> None:
        if args.exc_type is SystemExit:
            return
        name = args.thread.name if args.thread is not None else "?"
        log.error(
            "Необработанное исключение в потоке %s",
            name,
            exc_info=(args.exc_type, args.exc_value, args.exc_traceback),
        )

    sys.excepthook = excepthook
    threading.excepthook = thread_excepthook
