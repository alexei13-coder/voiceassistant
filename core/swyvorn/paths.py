"""Папка данных ассистента (docs/configuration.md, «Где лежат данные»)."""

from __future__ import annotations

import os
import posixpath
import sys
from collections.abc import Mapping
from dataclasses import dataclass
from pathlib import Path

DATA_DIR_ENV = "SWYVORN_DATA_DIR"


def default_data_dir(
    *,
    platform: str = sys.platform,
    env: Mapping[str, str] = os.environ,
    home: Path | None = None,
) -> Path:
    """Папка данных по умолчанию для текущей ОС."""
    home = home if home is not None else Path.home()
    if platform == "win32":
        appdata = env.get("APPDATA")
        base = Path(appdata) if appdata else home / "AppData" / "Roaming"
        return base / "Swyvorn"
    if platform == "darwin":
        return home / "Library" / "Application Support" / "Swyvorn"
    # По спецификации XDG относительный путь в XDG_CONFIG_HOME недействителен. Проверка по правилам
    # POSIX, а не текущей ОС: на Windows Path("/xdg").is_absolute() ложно из-за отсутствия диска.
    xdg = env.get("XDG_CONFIG_HOME")
    base = Path(xdg) if xdg and posixpath.isabs(xdg) else home / ".config"
    return base / "swyvorn"


def resolve_data_dir(
    cli_value: Path | None,
    *,
    env: Mapping[str, str] = os.environ,
    platform: str = sys.platform,
) -> Path:
    """Флаг --data-dir важнее SWYVORN_DATA_DIR, тот — важнее папки по умолчанию."""
    if cli_value is not None:
        raw = cli_value
    elif env.get(DATA_DIR_ENV, "").strip():
        raw = Path(env[DATA_DIR_ENV].strip())
    else:
        return default_data_dir(platform=platform, env=env)
    return raw.expanduser().resolve()


@dataclass(frozen=True, slots=True)
class DataPaths:
    """Расположение файлов внутри папки данных. Папки создаются по требованию."""

    root: Path

    @property
    def settings_file(self) -> Path:
        return self.root / "settings.toml"

    @property
    def env_file(self) -> Path:
        return self.root / ".env"

    @property
    def logs_dir(self) -> Path:
        return self.root / "logs"

    @property
    def core_log(self) -> Path:
        return self.logs_dir / "core.log"

    @property
    def memory_file(self) -> Path:
        return self.root / "memory.json"

    @property
    def usage_file(self) -> Path:
        return self.root / "usage.json"

    def ensure_logs_dir(self) -> Path:
        self.logs_dir.mkdir(parents=True, exist_ok=True)
        return self.logs_dir
