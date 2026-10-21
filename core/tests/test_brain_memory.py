"""Долговременная память: лимиты, нормализация, атомарная запись, испорченный файл, потоки."""

from __future__ import annotations

import json
import os
import threading
from pathlib import Path

import pytest

from swyvorn.brain import storage
from swyvorn.brain.memory import MAX_FACTS, MemoryStore, MemoryUpdateError
from swyvorn.protocol import MemoryFact


def make_store(tmp_path: Path) -> MemoryStore:
    ticks = iter(range(1_000, 1_000_000))
    return MemoryStore(tmp_path / "memory.json", clock=lambda: next(ticks))


def file_facts(tmp_path: Path) -> list[dict[str, object]]:
    data = json.loads((tmp_path / "memory.json").read_text(encoding="utf-8"))
    assert data["version"] == 1
    return data["facts"]


def test_remember_replace_forget_clear(tmp_path: Path) -> None:
    store = make_store(tmp_path)
    changes: list[list[MemoryFact]] = []
    store.add_listener(changes.append)

    assert store.remember("address_form", "сэр") is None
    assert store.remember("user_name", "Алексей") is None
    previous = store.remember("address_form", "шеф")
    assert previous is not None
    assert previous.value == "сэр"
    # Заменённый факт остаётся на своём месте.
    assert [(f.key, f.value) for f in store.facts()] == [("address_form", "шеф"), ("user_name", "Алексей")]
    assert [f["value"] for f in file_facts(tmp_path)] == ["шеф", "Алексей"]

    assert store.forget("nothing_here") is None
    forgotten = store.forget("user_name")
    assert forgotten is not None
    assert forgotten.value == "Алексей"
    assert store.clear() == 1
    assert store.clear() == 0
    assert file_facts(tmp_path) == []
    # Слушатель вызывается только при настоящих изменениях: 3 remember, forget, clear.
    assert len(changes) == 5
    assert changes[-1] == []


def test_value_whitespace_is_collapsed(tmp_path: Path) -> None:
    store = make_store(tmp_path)
    store.remember("city", "  Нижний\n   Новгород\t")
    assert store.get("city") == "Нижний Новгород"


@pytest.mark.parametrize(
    "key",
    ["", "Address_form", "address-form", "1city", "город", "a__b", "trailing_", "_lead", "k" * 41, "two words"],
)
def test_bad_keys_are_rejected(tmp_path: Path, key: str) -> None:
    store = make_store(tmp_path)
    with pytest.raises(MemoryUpdateError, match="snake_case"):
        store.remember(key, "x")
    assert store.facts() == []
    assert not (tmp_path / "memory.json").exists()


def test_value_limits(tmp_path: Path) -> None:
    store = make_store(tmp_path)
    store.remember("k" * 40, "я" * 200)
    with pytest.raises(MemoryUpdateError, match="200"):
        store.remember("long", "я" * 201)
    with pytest.raises(MemoryUpdateError, match="пуст"):
        store.remember("empty", " \n ")


def test_at_most_50_facts_but_replacing_is_allowed(tmp_path: Path) -> None:
    store = make_store(tmp_path)
    for index in range(MAX_FACTS):
        store.remember(f"fact_{index}", str(index))
    with pytest.raises(MemoryUpdateError, match="заполнена"):
        store.remember("one_more", "x")
    store.remember("fact_7", "новое значение")
    assert len(store.facts()) == MAX_FACTS
    assert store.get("fact_7") == "новое значение"


def test_failed_write_changes_nothing(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    store = make_store(tmp_path)
    store.remember("city", "Москва")
    before = (tmp_path / "memory.json").read_bytes()

    def broken_replace(src: object, dst: object) -> None:
        raise PermissionError("файл занят")

    monkeypatch.setattr(storage.os, "replace", broken_replace)
    with pytest.raises(MemoryUpdateError, match="диск"):
        store.remember("city", "Казань")
    assert store.get("city") == "Москва"
    assert (tmp_path / "memory.json").read_bytes() == before
    # Временный файл не остался в папке данных.
    assert sorted(p.name for p in tmp_path.iterdir()) == ["memory.json"]


def test_write_is_atomic_via_replace(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    calls: list[tuple[str, str]] = []
    real_replace = os.replace

    def spy(src: str, dst: str) -> None:
        calls.append((Path(src).name, Path(dst).name))
        real_replace(src, dst)

    monkeypatch.setattr(storage.os, "replace", spy)
    make_store(tmp_path).remember("city", "Москва")
    assert len(calls) == 1
    tmp_name, target = calls[0]
    assert target == "memory.json"
    assert tmp_name.startswith(".memory.json.") and tmp_name.endswith(".tmp")


def test_load_roundtrip(tmp_path: Path) -> None:
    make_store(tmp_path).remember("address_form", "шеф")
    store = MemoryStore(tmp_path / "memory.json")
    assert store.load() is None
    assert [(f.key, f.value) for f in store.facts()] == [("address_form", "шеф")]


@pytest.mark.parametrize("content", ["{битый", '{"version": 3, "facts": []}', '{"version": 1}', '"строка"'])
def test_corrupted_file_goes_to_backup(tmp_path: Path, content: str) -> None:
    path = tmp_path / "memory.json"
    path.write_text(content, encoding="utf-8")
    store = MemoryStore(path)
    problem = store.load()
    assert problem is not None
    assert problem.backup is not None
    assert problem.backup.name.startswith("memory.json.bak-")
    assert problem.backup.read_text(encoding="utf-8") == content
    assert store.facts() == []
    # Память работает дальше и пишет новый файл.
    store.remember("city", "Москва")
    assert file_facts(tmp_path)[0]["value"] == "Москва"


def test_invalid_entries_are_dropped_on_load(tmp_path: Path) -> None:
    facts = [
        {"key": "city", "value": "Москва", "updated_at": 1},
        {"key": "Bad Key", "value": "x", "updated_at": 2},
        {"key": "empty", "value": "  ", "updated_at": 3},
        {"key": "no_time", "value": "x"},
        "мусор",
        {"key": "city", "value": "Казань", "updated_at": 4},
    ]
    (tmp_path / "memory.json").write_text(json.dumps({"version": 1, "facts": facts}), encoding="utf-8")
    store = MemoryStore(tmp_path / "memory.json")
    assert store.load() is None
    assert [(f.key, f.value) for f in store.facts()] == [("city", "Казань")]


def test_too_many_facts_on_disk_keeps_newest(tmp_path: Path) -> None:
    facts = [{"key": f"fact_{i}", "value": str(i), "updated_at": i} for i in range(MAX_FACTS + 5)]
    (tmp_path / "memory.json").write_text(json.dumps({"version": 1, "facts": facts}), encoding="utf-8")
    store = MemoryStore(tmp_path / "memory.json")
    store.load()
    keys = [f.key for f in store.facts()]
    assert len(keys) == MAX_FACTS
    assert "fact_0" not in keys
    assert "fact_54" in keys


def test_concurrent_writers_do_not_lose_updates(tmp_path: Path) -> None:
    store = make_store(tmp_path)

    def writer(prefix: str) -> None:
        for index in range(10):
            store.remember(f"{prefix}_{index}", "значение")

    threads = [threading.Thread(target=writer, args=(f"t{n}",)) for n in range(4)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join()
    assert len(store.facts()) == 40
    assert len(file_facts(tmp_path)) == 40
