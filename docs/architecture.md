# Архитектура (этап 1)

## Процессы

1. **Jarvis.exe** — Rust-оболочка Tauri 2. Окно HUD (WebView2), трей, глобальные горячие клавиши, автозапуск, запуск и аварийная остановка ядра.
2. **jarvis-core.exe** — Python-ядро (PyInstaller, onedir, консольная сборка без окна). Вся логика: состояние, демо-сценарий, метрики, позже — мозг, голос, инструменты, безопасность.

Оболочка запускает ядро как дочерний процесс в Job Object, передаёт `JARVIS_IPC_TOKEN` и `PYTHONUTF8=1`, читает `ready` из stdout. Протокол — в [protocol.md](protocol.md).

Собранное PyInstaller ядро игнорирует переменные `PYTHON*`, поэтому режим UTF-8 зашит в сборку флагом `--python-option "X utf8"` (см. `scripts/build-core.ps1`). `PYTHONUTF8=1` нужен только при запуске из исходников.

## Структура репозитория

```
core/                      Python 3.12 (uv)
  jarvis/
    __main__.py            точка входа: python -m jarvis
    app.py                 сборка компонентов и главный цикл
    cli.py                 разбор аргументов
    config.py              settings.toml + .env (SecretStr)
    paths.py               папка данных
    logging_setup.py       логирование + фильтр секретов
    bus.py                 шина событий (asyncio)
    state.py               машина состояний ассистента
    protocol.py            модели сообщений (pydantic) по docs/protocol.md
    session.py             история чата, журнал действий, mute, уведомления (снимок для hello)
    confirmation.py        единственное ожидающее подтверждение: nonce, тайм-аут
    killswitch.py          «Стоп»: отмена задач текущего хода
    metrics.py             CPU/RAM/сеть/время (psutil), 1 Гц
    demo.py                демо-сценарий этапа 1
    demo_audio.py          синтетические уровни «речи» для демо
    api/ws_server.py       WebSocket для UI (127.0.0.1, Origin, токен)
    api/control.py         stdio-канал оболочки (JSON Lines)
    platform/elevation.py  запрет запуска от администратора
  tests/
ui/                        React 19 + TypeScript + Vite
  src/
    protocol.ts            типы протокола (зеркало docs/protocol.md)
    store.ts               zustand-хранилище (состояние для React)
    live.ts                быстро меняющиеся значения вне React (уровни звука)
    core/connection.ts     WebSocket-клиент с переподключением
    platform/tauri.ts      мост к Tauri (порт/токен, аварийный стоп, окно)
    orb/                   анимированное ядро (WebGL2), владелец — только этот модуль
    components/            панели HUD
    styles/tokens.css      цвета, шрифты, отступы — единые для всех
  src-tauri/               Rust-оболочка
scripts/                   запуск для разработки, сборка ядра
.github/workflows/         CI: тесты (Windows + Linux), сборка установщика на Windows
docs/                      протокол, настройки, архитектура
```

## Правила

- Ядро — единственный источник решений. UI не выполняет действий, только шлёт команды.
- В stdout ядра — только JSON Lines для оболочки. Логи — в stderr и файл.
- Высокочастотные данные (уровень звука) не проходят через React-состояние: они пишутся в `live.ts`, анимация читает их в `requestAnimationFrame`.
- Секреты (ключ API, токен IPC) никогда не логируются и не отправляются в UI.
- Ядро отказывается работать от имени администратора.
