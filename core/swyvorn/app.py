"""Сборка ядра и главный цикл.

Порядок запуска: логирование в stderr → запрет администратора → core.log → настройки
и секреты (после чтения убираются из окружения процесса) → компоненты → WebSocket → канал
оболочки → ready. Завершение (SIGINT/SIGTERM, EOF stdin, shutdown) — в пределах 2 с.
"""

from __future__ import annotations

import asyncio
import logging
import os
import signal
import sys
from collections.abc import Callable, Coroutine, Mapping
from typing import Any, BinaryIO

from . import __version__
from .api.control import ReadChunk, StdinReader, StdoutChannel, stdin_reader_source
from .api.ws_server import HOST, ClientChannel, WsServer
from .bus import EventBus
from .cli import CliOptions, ExitCode
from .config import (
    Settings,
    TokenError,
    env_files,
    load_environment,
    load_secrets,
    load_settings,
    resolve_ipc_token,
    scrub_secret_environment,
)
from .confirmation import ConfirmationGate
from .demo import DemoController, DemoTimings
from .killswitch import RETURN_TO_IDLE_AFTER, KillSwitch
from .logging_setup import REDACTOR, attach_log_file, set_level, setup_logging
from .metrics import SAMPLE_INTERVAL, MetricsSampler
from .paths import DataPaths, resolve_data_dir
from .platform.elevation import check_elevation
from .protocol import (
    AuthMessage,
    ClientMessage,
    ConfirmMessage,
    DemoMessage,
    HelloMessage,
    HotkeyAction,
    HotkeyErrorMessage,
    HotkeyMessage,
    Hotkeys,
    MicMessage,
    MuteMessage,
    PingMessage,
    PongMessage,
    ProtocolError,
    SendTextMessage,
    ServerMessage,
    ShellMessage,
    ShutdownMessage,
    StateMessage,
    StopMessage,
    TrayMessage,
    UiFlags,
)
from .session import Session
from .state import AssistantState, StateMachine

log = logging.getLogger(__name__)

SHUTDOWN_BUDGET = 1.8  # из 2 с, отведённых протоколом, — запас на выход интерпретатора

HOTKEY_TITLES = {
    "activate": "вызов ассистента",
    "stop": "«Стоп»",
    "stop_fallback": "запасной «Стоп»",
    "mute": "выключение микрофона",
    "repeat": "повтор ответа",
    "screen": "анализ экрана",
}


class Application:
    def __init__(
        self,
        *,
        options: CliOptions,
        settings: Settings,
        token: str,
        stdout: StdoutChannel,
        stdin: ReadChunk | None = None,
        demo_timings: DemoTimings | None = None,
        return_to_idle_after: float = RETURN_TO_IDLE_AFTER,
        metrics_interval: float = SAMPLE_INTERVAL,
        handle_signals: bool = True,
        on_ready: Callable[[int], None] | None = None,
    ) -> None:
        self._options = options
        self._settings = settings
        self._stdout = stdout
        self._stdin = stdin
        self._handle_signals = handle_signals
        self._on_ready = on_ready
        self.demo_enabled = settings.demo.enabled if options.demo is None else options.demo
        self.hotkeys = Hotkeys.model_validate(settings.hotkeys.model_dump())

        self.bus: EventBus[ServerMessage] = EventBus()
        self.state_machine = StateMachine()
        self.session = Session(self.bus)
        self.confirmations = ConfirmationGate(self.bus)
        self.killswitch = KillSwitch(
            state_machine=self.state_machine,
            confirmations=self.confirmations,
            session=self.session,
            bus=self.bus,
            return_to_idle_after=return_to_idle_after,
        )
        self.demo = DemoController(
            state_machine=self.state_machine,
            session=self.session,
            confirmations=self.confirmations,
            killswitch=self.killswitch,
            bus=self.bus,
            assistant=settings.assistant,
            scenario_enabled=self.demo_enabled,
            timings=demo_timings,
        )
        self.metrics = MetricsSampler(self.bus.publish, interval=metrics_interval)
        self.ws = WsServer(
            port=options.port,
            token=token,
            dev=options.dev,
            bus=self.bus,
            handler=self.handle_client_message,
            snapshot=self.snapshot,
        )
        self.state_machine.add_listener(self._publish_state)
        self.port: int | None = None
        self._shutdown = asyncio.Event()
        self._shutdown_reason = ""
        self._background: set[asyncio.Task[Any]] = set()

    # ---------- жизненный цикл ----------

    async def run(self) -> int:
        loop = asyncio.get_running_loop()
        restore_signals = self._install_signal_handlers(loop) if self._handle_signals else _noop
        try:
            try:
                self.port = await self.ws.start()
            except OSError as exc:
                log.error("Не удалось открыть порт %s:%d: %s", HOST, self._options.port, exc)
                self._stdout.fatal(_port_error_text(self._options.port))
                return ExitCode.PORT_UNAVAILABLE
            self.metrics.start()
            self.demo.start()
            if self._stdin is not None:
                StdinReader(
                    self._stdin,
                    loop=loop,
                    on_message=self.handle_shell_message,
                    on_eof=lambda: self.request_shutdown("stdin закрыт"),
                ).start()
            self._stdout.ready(self.port, self.hotkeys)
            log.info(
                "Ядро готово: ws://%s:%d/ws, демо: %s", HOST, self.port, "да" if self.demo_enabled else "нет"
            )
            if self._on_ready is not None:
                self._on_ready(self.port)
            await self._shutdown.wait()
            log.info("Завершение работы: %s", self._shutdown_reason)
            await self._stop_components()
            return ExitCode.OK
        finally:
            restore_signals()

    def request_shutdown(self, reason: str) -> None:
        if not self._shutdown.is_set():
            self._shutdown_reason = reason
            self._shutdown.set()

    async def _stop_components(self) -> None:
        self.demo.shutdown()
        try:
            async with asyncio.timeout(SHUTDOWN_BUDGET):
                await self.killswitch.shutdown(grace=0.3)
                await self.metrics.stop()
                await self.ws.close(grace=1.0)
                for task in tuple(self._background):
                    task.cancel()
        except TimeoutError:
            log.warning("Компоненты не остановились за %.1f с — выхожу принудительно", SHUTDOWN_BUDGET)

    def _install_signal_handlers(self, loop: asyncio.AbstractEventLoop) -> Callable[[], None]:
        restorers: list[Callable[[], None]] = []
        for name in ("SIGINT", "SIGTERM", "SIGBREAK"):
            sig = getattr(signal, name, None)
            if sig is None:
                continue
            try:
                loop.add_signal_handler(sig, self.request_shutdown, f"сигнал {name}")
                restorers.append(lambda sig=sig: loop.remove_signal_handler(sig))
            except (NotImplementedError, RuntimeError):
                # Windows: у Proactor-цикла нет add_signal_handler — обычный обработчик сигнала,
                # который передаёт запрос в цикл потокобезопасно.
                def handler(signum: int, _frame: object, name: str = name) -> None:
                    loop.call_soon_threadsafe(self.request_shutdown, f"сигнал {name}")

                try:
                    previous = signal.signal(sig, handler)
                except (ValueError, OSError):
                    continue  # не главный поток
                restorers.append(lambda sig=sig, previous=previous: signal.signal(sig, previous))

        def restore() -> None:
            for restorer in restorers:
                restorer()

        return restore

    # ---------- снимок и события ----------

    def snapshot(self) -> list[ServerMessage]:
        settings = self._settings
        hello = HelloMessage(
            core_version=__version__,
            state=self.state_machine.state,
            demo=self.demo_enabled,
            assistant_name=settings.assistant.name,
            wake_word=settings.assistant.wake_word,
            address_form=settings.assistant.address_form,
            model=settings.llm.model,
            hotkeys=self.hotkeys,
            ui=UiFlags(reduced_motion=settings.ui.reduced_motion),
            muted=self.session.muted,
            history=self.session.history(),
            actions=self.session.actions(),
            confirmation=self.confirmations.current,
        )
        return [hello, *self.session.sticky_notices()]

    async def _publish_state(
        self, _previous: AssistantState, state: AssistantState, reason: str | None
    ) -> None:
        self.bus.publish(StateMessage(state=state, reason=reason))

    # ---------- команды UI ----------

    async def handle_client_message(self, message: ClientMessage, client: ClientChannel) -> None:
        match message:
            case SendTextMessage(text=text):
                self.demo.handle_user_text(text)
            case ConfirmMessage(action_id=action_id, nonce=nonce, decision=decision):
                if not self.confirmations.submit(action_id, nonce, decision, "button"):
                    raise ProtocolError(
                        "stale_confirmation", "Подтверждение устарело или не найдено — ничего не выполнено"
                    )
            case StopMessage():
                await self.killswitch.stop("button")
            case MicMessage(action="toggle"):
                self.demo.voice_toggle()
            case MicMessage(action="ptt_down"):
                self.demo.push_to_talk_down()
            case MicMessage(action="ptt_up"):
                self.demo.end_capture()
            case MuteMessage(muted=muted):
                self._set_muted(muted)
            case PingMessage():
                client.send(PongMessage())
            case DemoMessage(action=action, state=state):
                if not self.demo_enabled:
                    raise ProtocolError("not_allowed", "Демо-режим выключен")
                await self.demo.command(action, state)
            case AuthMessage():
                raise ProtocolError("bad_message", "Авторизация уже выполнена")

    def _set_muted(self, muted: bool) -> None:
        if muted:
            self.demo.end_capture()
        self.session.set_muted(muted)

    # ---------- команды оболочки ----------

    def handle_shell_message(self, message: ShellMessage) -> None:
        match message:
            case ShutdownMessage():
                self.request_shutdown("команда shutdown")
            case HotkeyMessage(action=action):
                self._hotkey(action)
            case TrayMessage(action="stop"):
                self._spawn(self.killswitch.stop("tray"))
            case TrayMessage(action="mute_toggle"):
                self._set_muted(not self.session.muted)
            case HotkeyErrorMessage(action=action, combo=combo, error=error):
                log.warning("Оболочка не смогла назначить %s (%s): %s", combo, action, error)
                title = HOTKEY_TITLES.get(action, action)
                self.session.notice(
                    "warning",
                    f"Не удалось назначить сочетание {combo or '—'} ({title}). Возможно, оно занято "
                    "другой программой — выберите другое в settings.toml.",
                    "hotkey_unavailable",
                    sticky=True,
                )

    def _hotkey(self, action: HotkeyAction) -> None:
        match action:
            case "activate":
                self._stdout.show_window()
                self.demo.voice_toggle()
            case "ptt_down":
                self.demo.push_to_talk_down()
            case "ptt_up":
                self.demo.end_capture()
            case "stop":
                self._spawn(self.killswitch.stop("hotkey"))
            case "mute_toggle":
                self._set_muted(not self.session.muted)
            case "repeat":
                self.session.notice(
                    "info", "Повтор последнего ответа появится на этапе 3", "not_available_yet"
                )
            case "screen":
                self.session.notice("info", "Анализ экрана появится на этапе 4", "not_available_yet")

    def _spawn(self, coro: Coroutine[Any, Any, None]) -> None:
        task = asyncio.get_running_loop().create_task(coro)
        self._background.add(task)
        task.add_done_callback(self._background.discard)


def _noop() -> None:
    return None


def _port_error_text(port: int) -> str:
    if port:
        return f"Не удалось открыть порт {port}: он занят другой программой или зарезервирован системой."
    return "Не удалось открыть сетевой порт для связи с интерфейсом."


def run(
    options: CliOptions,
    *,
    environ: Mapping[str, str] | None = None,
    stdout_stream: BinaryIO | None = None,
    stdin: ReadChunk | None = None,
) -> int:
    """Полный запуск ядра; возвращает код выхода (docs/configuration.md)."""
    environ = dict(os.environ) if environ is None else environ
    stdout = StdoutChannel(stdout_stream or sys.stdout.buffer)
    paths = DataPaths(resolve_data_dir(options.data_dir, env=environ))
    # Пока только stderr: процесс администратора не должен ничего записать — ни папку logs/,
    # ни core.log. Записи до проверки прав попадут в файл, когда он будет подключён.
    setup_logging(level=options.log_level or "INFO", log_file=None)
    try:
        log.info("SWYVORN %s, папка данных: %s", __version__, paths.root)
        if (code := check_elevation(stdout)) is not None:
            return code
        attach_log_file(paths.core_log)
        return _run(options, paths, stdout, environ, stdin)
    except KeyboardInterrupt:
        return ExitCode.OK
    except Exception:
        log.critical("Ядро аварийно завершилось", exc_info=True)
        stdout.fatal("Внутренняя ошибка ядра. Подробности — в журнале logs/core.log.")
        return ExitCode.FAILURE


def _run(
    options: CliOptions,
    paths: DataPaths,
    stdout: StdoutChannel,
    environ: Mapping[str, str],
    stdin: ReadChunk | None,
) -> int:
    settings = load_settings(paths.settings_file)
    set_level(options.log_level or settings.logging.level)

    env = load_environment(env_files(paths, dev=options.dev), environ)
    secrets = load_secrets(env)
    # Токен и ключ дальше живут только в памяти (env, SecretStr, фильтр логов): дочерние
    # процессы следующих этапов (PowerShell и т.п.) наследуют os.environ и не должны их получить.
    scrub_secret_environment()
    if secrets.anthropic_api_key is not None:
        REDACTOR.register(secrets.anthropic_api_key.get_secret_value())
    log.info("Ключ API: %s", "задан" if secrets.anthropic_api_key else "не задан (на этапе 1 не нужен)")

    try:
        token, generated = resolve_ipc_token(env, dev=options.dev)
    except TokenError as exc:
        log.error("%s", exc)
        stdout.fatal(str(exc))
        return ExitCode.FAILURE
    REDACTOR.register(token)

    def announce_dev_token(port: int) -> None:
        # Мимо логирования намеренно: фильтр вырезал бы токен, а он нужен разработчику.
        print(f"[swyvorn] Режим разработки, токен UI: {token}", file=sys.stderr, flush=True)
        print(
            f"[swyvorn] Откройте http://localhost:1420/?port={port}&token={token}",
            file=sys.stderr,
            flush=True,
        )

    if not options.no_stdin and stdin is None:
        stdin = stdin_reader_source()
        if stdin is None:
            log.warning("У процесса нет stdin — управляющий канал оболочки недоступен")

    async def serve() -> int:
        # Компоненты создаются внутри цикла: все примитивы asyncio принадлежат ему.
        app = Application(
            options=options,
            settings=settings,
            token=token,
            stdout=stdout,
            stdin=None if options.no_stdin else stdin,
            on_ready=announce_dev_token if generated else None,
        )
        return await app.run()

    return asyncio.run(serve())
