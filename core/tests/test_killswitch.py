"""«Стоп» (docs/protocol.md §3)."""

from __future__ import annotations

import asyncio
import time

from conftest import Core, build_core

from jarvis.state import AssistantState

S = AssistantState


async def test_stop_cancels_scenario_tasks_and_reaches_idle() -> None:
    c = build_core(scenario=True)
    c.demo.start()
    try:
        await c.rec.wait_type("state", state=S.SPEAKING, within=5)
        assert c.ks.active
        mark = c.rec.mark()
        await c.ks.stop("hotkey")
        assert c.sm.state is S.STOPPED
        assert (await c.rec.wait_type("stopped", start=mark)).source == "hotkey"
        await asyncio.sleep(0)  # дать отменённым задачам свернуться
        assert not c.ks.active
        # Начатый ответ закрыт, речь прекратилась.
        streaming = [e.message.id for e in c.rec.of_type("chat_message") if e.message.streaming]
        assert all(any(d.id == mid for d in c.rec.of_type("chat_done")) for mid in streaming)
        levels_after = len(c.rec.of_type("audio_level", c.rec.mark()))
        await c.rec.wait_type("state", state=S.IDLE, start=mark)
        assert len(c.rec.of_type("audio_level", c.rec.mark())) == levels_after == 0
        assert c.rec.states(mark)[:2] == ["stopped", "idle"]
    finally:
        c.demo.shutdown()
        await c.ks.shutdown()


async def test_stop_resolves_pending_confirmation_and_marks_actions(core: Core) -> None:
    await core.demo.command("confirmation")
    request = (await core.rec.wait_type("confirmation_request")).request
    await core.rec.wait_type("confirmation_countdown")
    mark = core.rec.mark()
    await core.ks.stop("button")
    resolved = await core.rec.wait_type("confirmation_resolved", start=mark)
    assert (resolved.action_id, resolved.outcome) == (request.action_id, "stopped")
    entry = [e.entry for e in core.rec.of_type("action", mark) if e.entry.id == request.action_id][-1]
    assert (entry.status, entry.decision) == ("stopped", "stopped")
    assert core.gate.current is None
    assert core.gate.submit(request.action_id, request.nonce, "yes", "button") is False
    await core.rec.wait_type("state", state=S.IDLE, start=mark)
    assert S.EXECUTING not in core.rec.states(mark)


async def test_stop_during_execution_keeps_decision(core: Core) -> None:
    await core.demo.command("confirmation")
    request = (await core.rec.wait_type("confirmation_request")).request
    await core.rec.wait_type("confirmation_countdown")
    core.gate.submit(request.action_id, request.nonce, "yes", "button")
    await core.rec.wait_type("state", state=S.EXECUTING)
    mark = core.rec.mark()
    await core.ks.stop("tray")
    entry = [e.entry for e in core.rec.of_type("action", mark)][-1]
    assert (entry.status, entry.decision) == ("stopped", "confirmed_button")
    assert entry.duration_ms is not None
    await asyncio.sleep(0.05)
    assert all(e.entry.status != "ok" for e in core.rec.of_type("action", mark))


async def test_stop_is_fast() -> None:
    c = build_core(scenario=True)
    c.demo.start()
    try:
        await c.rec.wait_type("state", state=S.LISTENING, within=5)
        started = time.perf_counter()
        await c.ks.stop("button")
        assert (time.perf_counter() - started) < 0.1
    finally:
        c.demo.shutdown()
        await c.ks.shutdown()


async def test_repeated_stop_is_safe(core: Core) -> None:
    core.demo.handle_user_text("привет")
    await core.rec.wait_type("state", state=S.THINKING)
    await core.ks.stop("button")
    await core.ks.stop("hotkey")
    await core.ks.stop("tray")
    assert [e.source for e in core.rec.of_type("stopped")] == ["button", "hotkey", "tray"]
    assert core.rec.states().count("stopped") == 1
    await core.rec.wait_type("state", state=S.IDLE)
    await asyncio.sleep(0.05)
    assert core.sm.state is S.IDLE


async def test_stop_when_idle(core: Core) -> None:
    await core.ks.stop("button")
    assert core.sm.state is S.STOPPED
    await core.rec.wait_type("state", state=S.IDLE)


async def test_scenario_resumes_after_stop() -> None:
    c = build_core(scenario=True)
    c.demo.start()
    try:
        await c.rec.wait_type("state", state=S.LISTENING, within=5)
        mark = c.rec.mark()
        await c.ks.stop("button")
        await c.rec.wait_type("state", state=S.IDLE, start=mark)
        resumed_at = c.rec.mark()
        await c.rec.wait_type("state", state=S.LISTENING, start=resumed_at, within=2)
    finally:
        c.demo.shutdown()
        await c.ks.shutdown()


async def test_interaction_preempts_and_new_turn_survives_old_cleanup() -> None:
    c = build_core(scenario=True)
    c.demo.start()
    try:
        await c.rec.wait_type("state", state=S.SPEAKING, within=5)
        mark = c.rec.mark()
        c.demo.handle_user_text("стоп-сценарий")
        await c.rec.wait_type("state", state=S.IDLE, start=mark)
        reply = "".join(e.delta for e in c.rec.of_type("chat_delta", mark))
        assert reply.endswith("„стоп-сценарий“")
    finally:
        c.demo.shutdown()
        await c.ks.shutdown()
