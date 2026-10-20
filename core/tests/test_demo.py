"""Демо-сценарий и подтверждения: всё на быстрых таймингах (FAST, ×0.01)."""

from __future__ import annotations

import asyncio
import itertools
from dataclasses import replace

import pytest
from conftest import FAST, Core, build_core

from jarvis.confirmation import ConfirmationGate
from jarvis.demo import EXECUTED_DETAIL, USER_TRASH, USER_WEATHER, DemoTimings
from jarvis.demo_audio import FRAME_RATE
from jarvis.state import AssistantState

S = AssistantState


async def start_confirmation(core: Core) -> tuple[str, str]:
    """Запустить демо-подтверждение и дождаться, пока договорится вопрос (пошёл отсчёт)."""
    await core.demo.command("confirmation")
    request = (await core.rec.wait_type("confirmation_request")).request
    countdown = await core.rec.wait_type("confirmation_countdown")
    assert countdown.action_id == request.action_id
    return request.action_id, request.nonce


async def test_full_scenario_round() -> None:
    c = build_core(scenario=True)
    c.demo.start()
    try:
        request = (await c.rec.wait_type("confirmation_request", within=5)).request
        await c.rec.wait_type("confirmation_countdown")
        assert c.gate.submit(request.action_id, request.nonce, "no", "button")
        await c.rec.wait_type("state", state=S.IDLE, start=len(c.rec.events))
    finally:
        c.demo.shutdown()
        await c.ks.shutdown()

    states = c.rec.states()
    expected = [
        "listening", "thinking", "speaking", "idle",
        "listening", "thinking", "speaking", "awaiting_confirmation", "speaking", "idle",
    ]  # fmt: skip
    assert states[: len(expected)] == expected

    users = [e.message.text for e in c.rec.of_type("chat_message") if e.message.role == "user"]
    assert users == [USER_WEATHER, USER_TRASH]

    weather = [e.entry for e in c.rec.of_type("action") if e.entry.tool == "weather"]
    assert weather[-1].status == "ok"
    assert weather[-1].risk == "safe"
    assert all(entry.demo for entry in weather)

    assert {e.source for e in c.rec.of_type("audio_level")} == {"mic", "tts"}
    assert all(0.0 <= e.level <= 1.0 for e in c.rec.of_type("audio_level"))


async def test_audio_levels_only_in_listening_and_speaking() -> None:
    c = build_core(scenario=True)
    c.demo.start()
    try:
        await c.rec.wait_type("confirmation_countdown", within=5)
    finally:
        c.demo.shutdown()
        await c.ks.shutdown()
    state = S.IDLE
    for event in c.rec.events:
        if event.type == "state":
            state = event.state
        elif event.type == "audio_level":
            assert (event.source, state) in {("mic", S.LISTENING), ("tts", S.SPEAKING)}


async def test_speech_is_streamed_word_by_word(core: Core) -> None:
    await core.demo.command("confirmation")
    request = (await core.rec.wait_type("confirmation_request")).request
    await core.rec.wait_type("confirmation_countdown")
    assistant = [e.message for e in core.rec.of_type("chat_message") if e.message.role == "assistant"][-1]
    deltas = [e.delta for e in core.rec.of_type("chat_delta") if e.id == assistant.id]
    assert len(deltas) > 5
    assert "".join(deltas) == request.spoken_text
    assert "Вы уверены, сэр?" in request.spoken_text
    done = await core.rec.wait_type("chat_done", id=assistant.id)
    assert done is not None


async def test_countdown_starts_after_question_is_spoken(core: Core) -> None:
    await core.demo.command("confirmation")
    request = (await core.rec.wait_type("confirmation_request")).request
    assert request.expires_at is None
    assert request.demo is True
    assert request.timeout_ms == round(FAST.real(FAST.confirmation_timeout) * 1000)
    countdown = await core.rec.wait_type("confirmation_countdown")
    kinds = [e.type for e in core.rec.events]
    question_done = kinds.index("chat_done", kinds.index("confirmation_request"))
    assert question_done < core.rec.events.index(countdown)
    assert core.sm.state is S.AWAITING_CONFIRMATION
    assert core.gate.current is not None
    assert core.gate.current.expires_at == countdown.expires_at


async def test_confirm_yes_executes_demo(core: Core) -> None:
    action_id, nonce = await start_confirmation(core)
    mark = core.rec.mark()
    assert core.gate.submit(action_id, nonce, "yes", "button") is True
    resolved = await core.rec.wait_type("confirmation_resolved", start=mark)
    assert (resolved.outcome, resolved.via) == ("confirmed", "button")
    await core.rec.wait_type("state", state=S.EXECUTING, start=mark)
    await core.rec.wait_type("state", state=S.IDLE, start=mark)

    entries = [e.entry for e in core.rec.of_type("action", mark) if e.entry.id == action_id]
    assert [e.status for e in entries] == ["running", "ok"]
    assert entries[-1].decision == "confirmed_button"
    assert entries[-1].detail == EXECUTED_DETAIL
    assert entries[-1].duration_ms is not None
    assert entries[-1].demo is True
    replies = [e.delta for e in core.rec.of_type("chat_delta", mark)]
    assert "".join(replies) == "Готово."


async def test_confirm_no_cancels(core: Core) -> None:
    action_id, nonce = await start_confirmation(core)
    mark = core.rec.mark()
    assert core.gate.submit(action_id, nonce, "no", "button")
    assert (await core.rec.wait_type("confirmation_resolved", start=mark)).outcome == "denied"
    await core.rec.wait_type("state", state=S.IDLE, start=mark)
    assert S.EXECUTING not in core.rec.states(mark)
    entry = [e.entry for e in core.rec.of_type("action", mark) if e.entry.id == action_id][-1]
    assert (entry.status, entry.decision) == ("denied", "denied")
    assert "".join(e.delta for e in core.rec.of_type("chat_delta", mark)) == "Отменено."


async def test_wrong_nonce_and_wrong_id_are_stale(core: Core) -> None:
    action_id, nonce = await start_confirmation(core)
    assert core.gate.submit(action_id, nonce + "x", "yes", "button") is False
    assert core.gate.submit("a_other", nonce, "yes", "button") is False
    assert core.gate.submit(action_id, "кириллица", "yes", "button") is False
    assert core.rec.of_type("confirmation_resolved") == []
    assert core.sm.state is S.AWAITING_CONFIRMATION
    assert core.gate.submit(action_id, nonce, "no", "button") is True


async def test_double_confirm_is_stale(core: Core) -> None:
    action_id, nonce = await start_confirmation(core)
    assert core.gate.submit(action_id, nonce, "yes", "button") is True
    assert core.gate.submit(action_id, nonce, "yes", "button") is False
    assert core.gate.submit(action_id, nonce, "no", "button") is False
    assert len(core.rec.of_type("confirmation_resolved")) == 1


async def test_timeout_outcome() -> None:
    c = build_core(timings=replace(FAST, confirmation_timeout=5.0))  # 50 мс
    try:
        action_id, nonce = await start_confirmation(c)
        resolved = await c.rec.wait_type("confirmation_resolved")
        assert (resolved.outcome, resolved.via) == ("timeout", None)
        assert c.gate.submit(action_id, nonce, "yes", "button") is False
        await c.rec.wait_type("state", state=S.IDLE, start=c.rec.events.index(resolved))
        entry = [e.entry for e in c.rec.of_type("action") if e.entry.id == action_id][-1]
        assert (entry.status, entry.decision) == ("timeout", "timeout")
        assert S.EXECUTING not in c.rec.states()
    finally:
        await c.ks.shutdown()


async def test_expired_but_timer_not_fired_is_stale() -> None:
    from jarvis.bus import EventBus

    now = [1_000_000]
    gate = ConfirmationGate(EventBus(), clock=lambda: now[0])
    pending = gate.open(action_id="a1", title="t", spoken_text="s", details=[], timeout_ms=15_000)
    gate.start_countdown(pending)
    now[0] += 15_000
    assert gate.submit("a1", pending.request.nonce, "yes", "button") is False
    gate.resolve_current("cancelled")


async def test_answer_during_question_cuts_speech(core: Core) -> None:
    await core.demo.command("confirmation")
    request = (await core.rec.wait_type("confirmation_request")).request
    await core.rec.wait_type("chat_delta")  # вопрос начал произноситься
    assert core.gate.submit(request.action_id, request.nonce, "yes", "button")
    await core.rec.wait_type("state", state=S.EXECUTING)
    assert core.rec.of_type("confirmation_countdown") == []
    question = next(e.message for e in core.rec.of_type("chat_message") if e.message.role == "assistant")
    spoken = "".join(e.delta for e in core.rec.of_type("chat_delta") if e.id == question.id)
    assert spoken != request.spoken_text
    assert core.rec.of_type("chat_done")[0].id == question.id


async def test_new_confirmation_supersedes_previous() -> None:
    from jarvis.bus import EventBus

    gate = ConfirmationGate(EventBus())
    first = gate.open(action_id="a1", title="t", spoken_text="s", details=[])
    second = gate.open(action_id="a2", title="t", spoken_text="s", details=[])
    assert first.result is not None and first.result.outcome == "superseded"
    assert gate.current is second.request
    assert first.request.nonce != second.request.nonce
    assert len(first.request.nonce) >= 16
    gate.resolve_current("cancelled")


async def test_send_text_reply(core: Core) -> None:
    core.demo.handle_user_text("Привет, Джарвис")
    await core.rec.wait_type("state", state=S.THINKING)
    await core.rec.wait_type("state", state=S.IDLE)
    messages = [e.message for e in core.rec.of_type("chat_message")]
    assert (messages[0].role, messages[0].text) == ("user", "Привет, Джарвис")
    reply = "".join(e.delta for e in core.rec.of_type("chat_delta"))
    assert reply == "Это демонстрационный режим: мозг подключим на этапе 2. Вы написали: „Привет, Джарвис“"


async def test_long_text_is_quoted_briefly(core: Core) -> None:
    core.demo.handle_user_text("слово " * 300)
    await core.rec.wait_type("chat_done", within=10)
    reply = "".join(e.delta for e in core.rec.of_type("chat_delta"))
    assert reply.endswith("…“")
    assert len(reply) < 300


async def test_address_form_is_used() -> None:
    c = build_core(address_form="мэм")
    try:
        await c.demo.command("confirmation")
        request = (await c.rec.wait_type("confirmation_request")).request
        assert request.spoken_text.endswith("Вы уверены, мэм?")
    finally:
        await c.ks.shutdown()
    c = build_core(address_form="")
    try:
        await c.demo.command("confirmation")
        request = (await c.rec.wait_type("confirmation_request")).request
        assert request.spoken_text.endswith("Вы уверены?")
    finally:
        await c.ks.shutdown()


async def test_voice_toggle_listens_then_returns_to_idle(core: Core) -> None:
    core.demo.voice_toggle()
    await core.rec.wait_type("state", state=S.LISTENING)
    await core.rec.wait_type("notice", code="demo_voice")
    await core.rec.wait_type("state", state=S.IDLE)
    assert core.rec.states() == ["listening", "thinking", "idle"]
    assert {e.source for e in core.rec.of_type("audio_level")} == {"mic"}


async def test_second_toggle_ends_listening_early() -> None:
    c = build_core(timings=replace(FAST, voice_listening=10_000.0))
    try:
        c.demo.voice_toggle()
        await c.rec.wait_type("audio_level")
        c.demo.voice_toggle()
        await c.rec.wait_type("state", state=S.THINKING, within=1)
    finally:
        await c.ks.shutdown()


async def test_push_to_talk_listens_while_held(core: Core) -> None:
    core.demo.push_to_talk_down()
    await core.rec.wait_type("state", state=S.LISTENING)
    await asyncio.sleep(0.05)
    assert core.sm.state is S.LISTENING
    core.demo.end_capture()
    await core.rec.wait_type("state", state=S.THINKING, within=1)
    await core.rec.wait_type("state", state=S.IDLE)


async def test_mic_while_muted_shows_notice(core: Core) -> None:
    core.session.set_muted(True)
    core.demo.voice_toggle()
    notice = await core.rec.wait_type("notice", code="muted")
    assert notice.level == "warning"
    assert core.sm.state is S.IDLE
    assert core.ks.active is False


async def test_set_state_stops_scenario_and_holds() -> None:
    c = build_core(scenario=True)
    c.demo.start()
    try:
        await c.rec.wait_type("state", state=S.LISTENING)
        await c.demo.command("set_state", S.AWAITING_CONFIRMATION)
        assert c.sm.state is S.AWAITING_CONFIRMATION
        await asyncio.sleep(0.2)  # дольше, чем пауза до продолжения сценария
        assert c.sm.state is S.AWAITING_CONFIRMATION
        await c.demo.command("set_state", S.SPEAKING)
        await c.rec.wait_type("audio_level", source="tts", start=c.rec.mark())
        await c.demo.command("start")
        await c.rec.wait_type("state", state=S.LISTENING, start=c.rec.mark(), within=2)
    finally:
        c.demo.shutdown()
        await c.ks.shutdown()


async def test_demo_stop_goes_idle_and_stays() -> None:
    c = build_core(scenario=True)
    c.demo.start()
    try:
        await c.rec.wait_type("state", state=S.LISTENING)
        await c.demo.command("stop")
        assert c.sm.state is S.IDLE
        await asyncio.sleep(0.2)
        assert c.sm.state is S.IDLE
        assert c.ks.active is False
    finally:
        c.demo.shutdown()
        await c.ks.shutdown()


async def test_error_flash(core: Core) -> None:
    await core.demo.command("error_flash")
    error = await core.rec.wait_type("state", state=S.ERROR)
    assert error.reason
    await core.rec.wait_type("state", state=S.IDLE)


async def test_error_flash_from_stopped_goes_through_idle(core: Core) -> None:
    await core.sm.force(S.STOPPED)
    await core.demo.command("error_flash")
    await core.rec.wait_type("state", state=S.ERROR)
    assert core.rec.states()[-2:] == ["idle", "error"]


async def test_scenario_waits_while_muted() -> None:
    c = build_core(scenario=True)
    c.session.set_muted(True)
    c.demo.start()
    try:
        await asyncio.sleep(0.2)
        assert S.LISTENING not in c.rec.states()
        c.session.set_muted(False)
        await c.rec.wait_type("state", state=S.LISTENING)
    finally:
        c.demo.shutdown()
        await c.ks.shutdown()


@pytest.mark.parametrize("stall", [0.05, 0.12])  # меньше и больше трёх кадров
async def test_audio_levels_never_exceed_frame_rate_even_after_a_stall(stall: float) -> None:
    # Детерминированные часы: реальные таймеры (особенно 15,6 мс на Windows) делают такой тест хрупким.
    now = 0.0
    sleeps = 0

    async def fake_sleep(delay: float) -> None:
        nonlocal now, sleeps
        sleeps += 1
        now += delay + (stall if sleeps == 6 else 0.0)  # шестой сон «проспал», как при занятом цикле
        await asyncio.sleep(0)

    c = build_core(timings=DemoTimings(clock=lambda: now, sleep=fake_sleep))
    stamps: list[float] = []
    enough = asyncio.Event()

    def on_event(event: object) -> None:
        if getattr(event, "type", None) == "audio_level":
            stamps.append(now)
            if len(stamps) >= 25:
                enough.set()

    c.bus.subscribe(on_event)
    try:
        await c.demo.command("set_state", S.SPEAKING)
        async with asyncio.timeout(3):
            await enough.wait()
    finally:
        await c.ks.shutdown()
    period = 1 / FRAME_RATE
    slots = [int(round((t - stamps[0]) / period, 6)) for t in stamps]
    # Не больше одного уровня на слот: после задержки кадры пропущены, а не отправлены пачкой.
    assert len(slots) == len(set(slots))
    # Ровно один разрыв — на месте задержки, и в нём просроченные кадры пропущены, а не догнаны.
    gaps = [b - a for a, b in itertools.pairwise(slots)]
    assert sorted(set(gaps)) == [1, 1 + int(stall / period)]
    assert gaps.count(1 + int(stall / period)) == 1
    assert len(stamps) <= (stamps[-1] - stamps[0]) / period + 2
