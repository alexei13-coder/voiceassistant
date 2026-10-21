"""Общие помощники тестов: запись событий шины, быстрые тайминги, «мозг» с поддельным API,
запущенное ядро."""

from __future__ import annotations

import asyncio
import contextlib
import io
import json
import random
import tempfile
from collections.abc import AsyncIterator, Callable
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

import pytest
from fakes.fake_anthropic import FakeAnthropic
from pydantic import SecretStr
from websockets.asyncio.client import ClientConnection, connect

import swyvorn.app
from swyvorn.api.control import StdoutChannel
from swyvorn.app import Application
from swyvorn.brain.client import ClientFactory, KeyStore, make_client
from swyvorn.brain.memory import MemoryStore
from swyvorn.brain.service import Brain, BrainTimings
from swyvorn.brain.usage import UsageTracker
from swyvorn.bus import EventBus
from swyvorn.cli import CliOptions
from swyvorn.config import SECRET_ENV_NAMES, LlmSettings, Settings, settings_from_mapping
from swyvorn.confirmation import ConfirmationGate
from swyvorn.demo import DemoController, DemoTimings
from swyvorn.killswitch import KillSwitch
from swyvorn.paths import DataPaths
from swyvorn.platform.elevation import check_elevation
from swyvorn.protocol import ServerMessage, StateMessage
from swyvorn.session import Session
from swyvorn.state import StateMachine


@pytest.fixture(autouse=True)
def _not_elevated(monkeypatch: pytest.MonkeyPatch) -> None:
    """Раннеры GitHub для Windows работают от администратора — без этого run() сразу вернёт 3.

    Тесты, проверяющие сам запрет, ставят свой monkeypatch поверх этого.
    """
    monkeypatch.setattr(
        swyvorn.app, "check_elevation", lambda stdout: check_elevation(stdout, is_admin=lambda: False)
    )


@pytest.fixture(autouse=True)
def _secrets_not_in_environ(monkeypatch: pytest.MonkeyPatch) -> None:
    """run() убирает токен и ключ API из os.environ. Через monkeypatch значения из окружения
    разработчика вернутся после теста, а сами тесты от них не зависят."""
    for name in SECRET_ENV_NAMES:
        monkeypatch.delenv(name, raising=False)


TOKEN = "test-token-0123456789"
DEV_ORIGIN = "http://localhost:1420"
TAURI_ORIGIN = "http://tauri.localhost"

# Всё в 100 раз быстрее; подтверждение — 3 с реального времени, чтобы тест успел ответить.
FAST = DemoTimings(time_scale=0.01, confirmation_timeout=300.0)
FAST_BRAIN = BrainTimings(executing_min=0.0, error_flash=0.01)

API_KEY = "sk-ant-test-fake-key-123"  # совпадает с ключом из инструкции ручного прогона
FAKE_BASE_URL = "http://fake-anthropic.test"
# Вторник, 21 октября 2026, 14:05 по Москве — для блока контекста.
NOW = datetime(2026, 10, 21, 14, 5, tzinfo=timezone(timedelta(hours=3), "MSK"))


def fake_client_factory(fake: FakeAnthropic) -> ClientFactory:
    """Настоящий SDK поверх MockTransport; без повторов, чтобы ошибки приходили сразу."""

    def factory(key: SecretStr) -> Any:
        return make_client(key, base_url=FAKE_BASE_URL, http_client=fake.http_client(), max_retries=0)

    return factory


class Recorder:
    """Подписчик шины, который запоминает события и умеет ждать нужное."""

    def __init__(self, bus: EventBus[ServerMessage]) -> None:
        self.events: list[ServerMessage] = []
        self._changed = asyncio.Event()
        bus.subscribe(self._on_event)

    def _on_event(self, event: ServerMessage) -> None:
        self.events.append(event)
        self._changed.set()

    def mark(self) -> int:
        return len(self.events)

    def of_type(self, kind: str, start: int = 0) -> list[Any]:
        return [e for e in self.events[start:] if e.type == kind]

    def states(self, start: int = 0) -> list[str]:
        return [e.state for e in self.of_type("state", start)]

    async def wait_for(self, predicate: Callable[[Any], bool], *, start: int = 0, within: float = 3.0) -> Any:
        index = start
        async with asyncio.timeout(within):
            while True:
                while index < len(self.events):
                    event = self.events[index]
                    index += 1
                    if predicate(event):
                        return event
                self._changed.clear()
                await self._changed.wait()

    async def wait_type(self, kind: str, *, start: int = 0, within: float = 3.0, **fields: Any) -> Any:
        return await self.wait_for(
            lambda e: e.type == kind and all(getattr(e, k) == v for k, v in fields.items()),
            start=start,
            within=within,
        )


@dataclass
class Core:
    bus: EventBus[ServerMessage]
    sm: StateMachine
    session: Session
    gate: ConfirmationGate
    ks: KillSwitch
    demo: DemoController
    rec: Recorder
    settings: Settings = field(default_factory=Settings)


def build_core(*, scenario: bool = False, timings: DemoTimings = FAST, address_form: str = "сэр") -> Core:
    bus: EventBus[ServerMessage] = EventBus()
    rec = Recorder(bus)
    sm = StateMachine()

    async def publish_state(_old: Any, new: Any, reason: str | None) -> None:
        bus.publish(StateMessage(state=new, reason=reason))

    sm.add_listener(publish_state)
    session = Session(bus)
    gate = ConfirmationGate(bus)
    ks = KillSwitch(state_machine=sm, confirmations=gate, session=session, bus=bus, return_to_idle_after=0.02)
    settings = settings_from_mapping({"assistant": {"address_form": address_form}})
    demo = DemoController(
        state_machine=sm,
        session=session,
        confirmations=gate,
        killswitch=ks,
        bus=bus,
        assistant=settings.assistant,
        scenario_enabled=scenario,
        timings=timings,
        rng=random.Random(7),  # noqa: S311 — воспроизводимая огибающая, не криптография
    )
    return Core(bus, sm, session, gate, ks, demo, rec, settings)


@pytest.fixture
async def core() -> AsyncIterator[Core]:
    c = build_core()
    yield c
    c.demo.shutdown()
    await c.ks.shutdown()


# ---------- «мозг» с поддельным API ----------


@dataclass
class BrainCore:
    core: Core
    brain: Brain
    fake: FakeAnthropic
    memory: MemoryStore
    usage: UsageTracker
    keys: KeyStore
    paths: DataPaths

    @property
    def rec(self) -> Recorder:
        return self.core.rec

    async def say(self, text: str, *, within: float = 3.0) -> list[Any]:
        """Отправить реплику и дождаться конца хода; возвращает события этого хода."""
        mark = self.rec.mark()
        task = self.brain.send_text(text)
        done, _ = await asyncio.wait([task], timeout=within)
        assert done, "ход не закончился вовремя"
        return self.rec.events[mark:]


def build_brain(
    tmp_path: Path,
    *,
    key: str | None = API_KEY,
    llm: dict[str, Any] | None = None,
    fake: FakeAnthropic | None = None,
    key_loader: Callable[[], SecretStr | None] | None = None,
    limit_loader: Callable[[], float] | None = None,
    clock: Callable[[], datetime] = lambda: NOW,
) -> BrainCore:
    c = build_core()
    fake = fake or FakeAnthropic()
    settings = settings_from_mapping({"llm": llm or {}})
    paths = DataPaths(tmp_path)
    memory = MemoryStore(paths.memory_file)
    usage = UsageTracker(paths.usage_file, monthly_limit_usd=settings.llm.monthly_limit_usd, clock=clock)
    secret = SecretStr(key) if key else None
    keys = KeyStore(secret, key_loader or (lambda: secret))
    brain = Brain(
        llm=settings.llm,
        assistant=c.settings.assistant,
        session=c.session,
        state_machine=c.sm,
        killswitch=c.ks,
        bus=c.bus,
        memory=memory,
        usage=usage,
        keys=keys,
        client_factory=fake_client_factory(fake),
        env_file=paths.env_file,
        limit_loader=limit_loader or (lambda: settings.llm.monthly_limit_usd),
        demo=False,
        timings=FAST_BRAIN,
        clock=clock,
        rng=random.Random(7),  # noqa: S311 — воспроизводимая огибающая, не криптография
    )
    return BrainCore(c, brain, fake, memory, usage, keys, paths)


@pytest.fixture
async def bc(tmp_path: Path) -> AsyncIterator[BrainCore]:
    harness = build_brain(tmp_path)
    yield harness
    await harness.core.ks.shutdown()
    await harness.brain.aclose()


def llm_settings(**values: Any) -> LlmSettings:
    return settings_from_mapping({"llm": values}).llm


# ---------- запущенное приложение с настоящим WebSocket ----------


@dataclass
class RunningApp:
    app: Application
    port: int
    stdout: io.BytesIO
    rec: Recorder
    task: asyncio.Task[int]

    def url(self) -> str:
        return f"ws://127.0.0.1:{self.port}/ws"

    def stdout_lines(self) -> list[dict[str, Any]]:
        return [json.loads(line) for line in self.stdout.getvalue().decode("utf-8").splitlines()]


@contextlib.asynccontextmanager
async def running_app(
    *,
    demo: bool | None = False,
    dev: bool = True,
    settings: Settings | None = None,
    stdin: io.BytesIO | None = None,
    api_key: str | None = None,
    fake: FakeAnthropic | None = None,
    key_loader: Callable[[], SecretStr | None] | None = None,
    data_dir: Path | None = None,
) -> AsyncIterator[RunningApp]:
    """demo: True — --demo, False — --no-demo, None — по настройке [demo] enabled."""
    stdout = io.BytesIO()
    ready = asyncio.get_running_loop().create_future()
    with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as scratch:
        app = Application(
            options=CliOptions(dev=dev, port=0, demo=demo, no_stdin=stdin is None),
            settings=settings or Settings(),
            token=TOKEN,
            stdout=StdoutChannel(stdout),
            paths=DataPaths(data_dir or Path(scratch)),
            api_key=SecretStr(api_key) if api_key else None,
            key_loader=key_loader,
            client_factory=fake_client_factory(fake or FakeAnthropic()),
            stdin=stdin.read if stdin is not None else None,
            demo_timings=FAST,
            brain_timings=FAST_BRAIN,
            return_to_idle_after=0.02,
            metrics_interval=0.05,
            handle_signals=False,
            on_ready=lambda port: ready.set_result(port),
        )
        rec = Recorder(app.bus)
        task = asyncio.create_task(app.run())
        await asyncio.wait([ready, task], timeout=5, return_when=asyncio.FIRST_COMPLETED)
        if not ready.done():
            raise RuntimeError(f"ядро не стартовало: {task.result() if task.done() else 'таймаут'}")
        port = ready.result()
        try:
            yield RunningApp(app, port, stdout, rec, task)
        finally:
            app.request_shutdown("конец теста")
            await asyncio.wait_for(task, 5)


async def open_client(port: int, *, origin: str = DEV_ORIGIN, token: str = TOKEN) -> ClientConnection:
    ws = await connect(f"ws://127.0.0.1:{port}/ws", origin=origin)
    await ws.send(json.dumps({"type": "auth", "token": token}))
    return ws


async def recv_json(ws: ClientConnection, within: float = 3.0) -> dict[str, Any]:
    return json.loads(await asyncio.wait_for(ws.recv(), within))


async def recv_until(ws: ClientConnection, kind: str, within: float = 3.0, **fields: Any) -> dict[str, Any]:
    """Читать, пропуская посторонние события (метрики, уровни), до сообщения нужного типа."""
    async with asyncio.timeout(within):
        while True:
            message = json.loads(await ws.recv())
            if message["type"] == kind and all(message.get(k) == v for k, v in fields.items()):
                return message
