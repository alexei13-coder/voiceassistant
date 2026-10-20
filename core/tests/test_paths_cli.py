from __future__ import annotations

from pathlib import Path

import pytest

from swyvorn.__main__ import main
from swyvorn.cli import DEV_DEFAULT_PORT, ExitCode, parse_args
from swyvorn.paths import DataPaths, default_data_dir, resolve_data_dir

HOME = Path("/home/u")
LINUX_DEFAULT = HOME / ".config" / "swyvorn"


def test_windows_data_dir() -> None:
    path = default_data_dir(platform="win32", env={"APPDATA": "/appdata"}, home=HOME)
    assert path == Path("/appdata/Swyvorn")
    roaming = HOME / "AppData" / "Roaming" / "Swyvorn"
    assert default_data_dir(platform="win32", env={}, home=HOME) == roaming


def test_linux_data_dir() -> None:
    assert default_data_dir(platform="linux", env={}, home=HOME) == LINUX_DEFAULT
    assert default_data_dir(platform="linux", env={"XDG_CONFIG_HOME": "/xdg"}, home=HOME) == Path(
        "/xdg/swyvorn"
    )
    # Относительный XDG_CONFIG_HOME по спецификации игнорируется.
    assert default_data_dir(platform="linux", env={"XDG_CONFIG_HOME": "rel"}, home=HOME) == LINUX_DEFAULT


def test_macos_data_dir() -> None:
    expected = HOME / "Library" / "Application Support" / "Swyvorn"
    assert default_data_dir(platform="darwin", env={}, home=HOME) == expected


def test_override_precedence(tmp_path: Path) -> None:
    env = {"SWYVORN_DATA_DIR": str(tmp_path / "from-env")}
    assert resolve_data_dir(tmp_path / "from-cli", env=env) == (tmp_path / "from-cli").resolve()
    assert resolve_data_dir(None, env=env) == (tmp_path / "from-env").resolve()
    assert resolve_data_dir(None, env={}, platform="linux") == default_data_dir(platform="linux", env={})


def test_data_paths_layout_and_logs_dir_on_demand(tmp_path: Path) -> None:
    paths = DataPaths(tmp_path / "data")
    assert paths.settings_file == tmp_path / "data" / "settings.toml"
    assert paths.env_file == tmp_path / "data" / ".env"
    assert paths.core_log == tmp_path / "data" / "logs" / "core.log"
    assert not paths.logs_dir.exists()
    assert paths.ensure_logs_dir().is_dir()


def test_port_defaults() -> None:
    assert parse_args([]).port == 0
    assert parse_args(["--dev"]).port == DEV_DEFAULT_PORT
    assert parse_args(["--dev", "--port", "0"]).port == 0
    assert parse_args(["--port", "9000"]).port == 9000


def test_flags() -> None:
    options = parse_args(["--dev", "--no-demo", "--no-stdin", "--data-dir", "x", "--log-level", "debug"])
    assert options.dev is True
    assert options.demo is False
    assert options.no_stdin is True
    assert options.data_dir == Path("x")
    assert options.log_level == "DEBUG"
    assert parse_args(["--demo"]).demo is True
    assert parse_args([]).demo is None


@pytest.mark.parametrize(
    "argv",
    [["--port", "abc"], ["--port", "70000"], ["--log-level", "LOUD"], ["--unknown"], ["--demo", "--port"]],
)
def test_bad_arguments_exit_code_2(argv: list[str], capsys: pytest.CaptureFixture[str]) -> None:
    assert main(argv) == ExitCode.BAD_ARGUMENTS == 2
    captured = capsys.readouterr()
    assert captured.out == ""  # stdout — канал оболочки
    assert "usage" in captured.err


def test_exit_codes_match_docs() -> None:
    assert [int(c) for c in (ExitCode.OK, ExitCode.FAILURE, ExitCode.BAD_ARGUMENTS)] == [0, 1, 2]
    assert int(ExitCode.ELEVATED) == 3
    assert int(ExitCode.PORT_UNAVAILABLE) == 4
