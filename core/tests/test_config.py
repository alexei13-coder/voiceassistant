from __future__ import annotations

import logging
import os
import re
import tomllib
from pathlib import Path

import pytest

from swyvorn import config
from swyvorn.config import (
    DEFAULT_SETTINGS_TOML,
    Settings,
    TokenError,
    env_files,
    load_environment,
    load_secrets,
    load_settings,
    resolve_ipc_token,
    scrub_secret_environment,
    settings_from_mapping,
)
from swyvorn.paths import DataPaths

DOCS = Path(__file__).resolve().parents[2] / "docs" / "configuration.md"


def test_default_text_matches_docs() -> None:
    if not DOCS.is_file():
        pytest.skip("docs/configuration.md недоступен")
    match = re.search(r"## `settings.toml`\s+```toml\n(.*?)```", DOCS.read_text(encoding="utf-8"), re.S)
    assert match is not None
    assert match.group(1) == DEFAULT_SETTINGS_TOML


def test_default_text_parses_to_defaults() -> None:
    assert settings_from_mapping(tomllib.loads(DEFAULT_SETTINGS_TOML)) == Settings()


def test_missing_file_is_created_with_defaults(tmp_path: Path) -> None:
    path = tmp_path / "nested" / "settings.toml"
    assert load_settings(path) == Settings()
    assert path.read_text(encoding="utf-8") == DEFAULT_SETTINGS_TOML


def test_defaults() -> None:
    s = Settings()
    assert s.assistant.name == "SWYVORN"
    assert s.assistant.wake_word == "Свайворн"
    assert s.assistant.address_form == "сэр"
    assert s.llm.model == "claude-opus-5-5"
    assert s.llm.effort == "low"
    assert s.hotkeys.activate == "Ctrl+Alt+J"
    assert s.hotkeys.stop_fallback == "Ctrl+Alt+Backspace"
    assert s.ui.reduced_motion is False
    assert s.demo.enabled is True
    assert s.logging.level == "INFO"


def test_valid_values_are_applied(tmp_path: Path) -> None:
    path = tmp_path / "settings.toml"
    path.write_text(
        '[assistant]\nname = "Пятница"\nwake_word = " Пятница "\naddress_form = "  мэм "\n'
        '[llm]\neffort = "high"\n[hotkeys]\nmute = "Ctrl+Shift+F12"\n'
        "[ui]\nreduced_motion = true\n[demo]\nenabled = false\n"
        '[logging]\nlevel = "debug"\n',
        encoding="utf-8",
    )
    s = load_settings(path)
    assert s.assistant.name == "Пятница"
    assert s.assistant.wake_word == "Пятница"
    assert s.assistant.address_form == "мэм"
    assert s.llm.effort == "high"
    assert s.hotkeys.mute == "Ctrl+Shift+F12"
    assert s.ui.reduced_motion is True
    assert s.demo.enabled is False
    assert s.logging.level == "DEBUG"


@pytest.mark.parametrize(
    ("section", "key", "value"),
    [
        ("llm", "effort", "extreme"),
        ("llm", "model", "модель с пробелами"),
        ("ui", "reduced_motion", "yes"),
        ("demo", "enabled", 1),
        ("logging", "level", "TRACE"),
        ("hotkeys", "activate", "Ctrl+Alt+"),
        ("hotkeys", "stop", 42),
        ("assistant", "name", "   "),
        ("assistant", "address_form", "x" * 100),
        ("assistant", "wake_word", "Swyvorn"),  # латиница: распознаватель пишет по-русски
        ("assistant", "wake_word", "я"),
    ],
)
def test_invalid_value_falls_back_to_default_with_warning(
    section: str, key: str, value: object, caplog: pytest.LogCaptureFixture
) -> None:
    caplog.set_level(logging.WARNING)
    s = settings_from_mapping({section: {key: value}})
    default = getattr(getattr(Settings(), section), key)
    assert getattr(getattr(s, section), key) == default
    assert f"[{section}] {key}" in caplog.text


def test_one_bad_key_does_not_reset_neighbours() -> None:
    s = settings_from_mapping({"llm": {"effort": "extreme", "model": "claude-other-1"}})
    assert s.llm.effort == "low"
    assert s.llm.model == "claude-other-1"


def test_unknown_keys_and_sections_are_ignored(caplog: pytest.LogCaptureFixture) -> None:
    caplog.set_level(logging.WARNING)
    s = settings_from_mapping({"assistant": {"colour": "red"}, "extra": {"a": 1}, "ui": 5})
    assert s == Settings()
    assert "colour" in caplog.text
    assert "[extra]" in caplog.text
    assert "[ui]" in caplog.text


def test_bad_toml_does_not_crash_or_overwrite(tmp_path: Path, caplog: pytest.LogCaptureFixture) -> None:
    path = tmp_path / "settings.toml"
    path.write_text("[assistant\nname = ", encoding="utf-8")
    assert load_settings(path) == Settings()
    assert path.read_text(encoding="utf-8") == "[assistant\nname = "
    assert "Не удалось прочитать" in caplog.text


def test_invalid_utf8_does_not_crash(tmp_path: Path) -> None:
    path = tmp_path / "settings.toml"
    path.write_bytes(b"\xff\xfe[assistant]")
    assert load_settings(path) == Settings()


def test_bom_from_windows_notepad_is_accepted(tmp_path: Path) -> None:
    path = tmp_path / "settings.toml"
    path.write_bytes('[assistant]\nname = "Вика"\n'.encode("utf-8-sig"))
    assert load_settings(path).assistant.name == "Вика"


# ---------- .env и секреты ----------


def test_process_env_wins_then_data_dir_then_repo(tmp_path: Path) -> None:
    data_env = tmp_path / "data.env"
    repo_env = tmp_path / "repo.env"
    data_env.write_text("A=data\nB=data\n", encoding="utf-8")
    repo_env.write_text("A=repo\nB=repo\nC=repo\n", encoding="utf-8")
    env = load_environment([data_env, repo_env], {"A": "process"})
    assert env["A"] == "process"
    assert env["B"] == "data"
    assert env["C"] == "repo"


def test_env_files_do_not_touch_os_environ(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("SWYVORN_TEST_ONLY_VAR", raising=False)
    env_file = tmp_path / ".env"
    env_file.write_text("SWYVORN_TEST_ONLY_VAR=1\n", encoding="utf-8")
    load_environment([env_file], {})
    assert "SWYVORN_TEST_ONLY_VAR" not in os.environ


def test_scrub_removes_only_secrets() -> None:
    environ = {"SWYVORN_IPC_TOKEN": "t" * 20, "ANTHROPIC_API_KEY": "sk-ant-x", "PATH": "/bin"}
    scrub_secret_environment(environ)
    assert environ == {"PATH": "/bin"}
    scrub_secret_environment(environ)  # повторно и без секретов — не ошибка
    assert environ == {"PATH": "/bin"}


def test_scrub_defaults_to_process_environment(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("SWYVORN_IPC_TOKEN", "process-token-123")
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-ant-process")
    scrub_secret_environment()
    assert "SWYVORN_IPC_TOKEN" not in os.environ
    assert "ANTHROPIC_API_KEY" not in os.environ


def test_repo_env_only_in_dev(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    repo = tmp_path / "repo"
    repo.mkdir()
    (repo / ".env").write_text("X=1\n", encoding="utf-8")
    monkeypatch.setattr(config, "repo_root", lambda: repo)
    paths = DataPaths(tmp_path / "data")
    assert env_files(paths, dev=False) == [paths.env_file]
    assert env_files(paths, dev=True) == [paths.env_file, repo / ".env"]


def test_repo_root_detects_source_checkout() -> None:
    root = config.repo_root()
    assert root is not None
    assert (root / "core" / "pyproject.toml").is_file()


def test_api_key_is_secret(tmp_path: Path) -> None:
    secrets = load_secrets({"ANTHROPIC_API_KEY": " sk-ant-api03-secretvalue "})
    assert secrets.anthropic_api_key is not None
    assert secrets.anthropic_api_key.get_secret_value() == "sk-ant-api03-secretvalue"
    assert "secretvalue" not in repr(secrets)
    assert "secretvalue" not in str(secrets.model_dump())
    assert load_secrets({}).anthropic_api_key is None


def test_ipc_token_from_env() -> None:
    assert resolve_ipc_token({"SWYVORN_IPC_TOKEN": " tok "}, dev=False) == ("tok", False)


def test_ipc_token_generated_only_in_dev() -> None:
    token, generated = resolve_ipc_token({}, dev=True)
    assert generated is True
    assert len(token) >= 24
    with pytest.raises(TokenError):
        resolve_ipc_token({}, dev=False)


def test_ipc_token_too_long() -> None:
    with pytest.raises(TokenError):
        resolve_ipc_token({"SWYVORN_IPC_TOKEN": "x" * 257}, dev=True)
