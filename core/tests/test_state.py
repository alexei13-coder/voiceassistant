from __future__ import annotations

import itertools

import pytest

from jarvis.state import ALLOWED_TRANSITIONS, AssistantState, IllegalTransitionError, StateMachine

S = AssistantState

# Таблица из docs/protocol.md §1.3, переписанная независимо от кода.
SPEC = {
    "idle": {"listening", "thinking", "speaking", "executing", "error", "stopped"},
    "listening": {"idle", "thinking", "error", "stopped"},
    "thinking": {"idle", "speaking", "awaiting_confirmation", "executing", "listening", "error", "stopped"},
    "speaking": {"idle", "listening", "thinking", "awaiting_confirmation", "executing", "error", "stopped"},
    "awaiting_confirmation": {"idle", "executing", "speaking", "error", "stopped"},
    "executing": {"idle", "thinking", "speaking", "error", "stopped"},
    "error": {"idle", "stopped"},
    "stopped": {"idle"},
}

ALLOWED = [(a, b) for a, targets in SPEC.items() for b in targets]
FORBIDDEN = [
    (a.value, b.value) for a, b in itertools.permutations(AssistantState, 2) if b.value not in SPEC[a.value]
]


def test_table_matches_spec() -> None:
    assert {k.value: {v.value for v in vs} for k, vs in ALLOWED_TRANSITIONS.items()} == SPEC


@pytest.mark.parametrize(("current", "target"), ALLOWED)
async def test_allowed_transition(current: str, target: str) -> None:
    calls: list[tuple[str, str, str | None]] = []

    async def listener(old: AssistantState, new: AssistantState, reason: str | None) -> None:
        calls.append((old, new, reason))

    sm = StateMachine(S(current))
    sm.add_listener(listener)
    assert await sm.transition(S(target), "причина") is True
    assert sm.state == target
    assert calls == [(current, target, "причина")]


@pytest.mark.parametrize(("current", "target"), FORBIDDEN)
async def test_forbidden_transition_raises_and_keeps_state(current: str, target: str) -> None:
    sm = StateMachine(S(current))
    with pytest.raises(IllegalTransitionError):
        await sm.transition(S(target))
    assert sm.state == current


async def test_forbidden_transition_is_logged(caplog: pytest.LogCaptureFixture) -> None:
    sm = StateMachine(S.STOPPED)
    with pytest.raises(IllegalTransitionError):
        await sm.transition(S.SPEAKING)
    assert "stopped → speaking" in caplog.text


@pytest.mark.parametrize("state", list(AssistantState))
async def test_same_state_is_noop(state: AssistantState) -> None:
    calls: list[object] = []

    async def listener(*args: object) -> None:
        calls.append(args)

    sm = StateMachine(state)
    sm.add_listener(listener)
    assert await sm.transition(state) is False
    assert calls == []


async def test_force_bypasses_table_but_not_noop() -> None:
    sm = StateMachine(S.STOPPED)
    assert await sm.force(S.SPEAKING) is True
    assert sm.state is S.SPEAKING
    assert await sm.force(S.SPEAKING) is False


async def test_failing_listener_does_not_break_transition() -> None:
    async def broken(*_args: object) -> None:
        raise RuntimeError("сломался")

    seen: list[AssistantState] = []

    async def good(_old: AssistantState, new: AssistantState, _reason: str | None) -> None:
        seen.append(new)

    sm = StateMachine()
    sm.add_listener(broken)
    sm.add_listener(good)
    await sm.transition(S.LISTENING)
    assert seen == [S.LISTENING]
