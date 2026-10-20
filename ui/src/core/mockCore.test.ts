import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ServerMessage } from '../protocol'
import { useSwyvorn } from '../store'
import { MockCore, parseMockOptions, speechLevel, type MockOptions } from './mockCore'

const initialStore = useSwyvorn.getState()

function startCore(options: MockOptions) {
  const sent: ServerMessage[] = []
  const core = new MockCore((msg) => {
    sent.push(msg)
    useSwyvorn.getState().applyServerMessage(msg)
  }, options)
  core.start()
  return { core, sent }
}

describe('parseMockOptions', () => {
  it('разбирает state и confirm', () => {
    expect(parseMockOptions('?mock=1')).toEqual({ freezeState: null, confirm: false })
    expect(parseMockOptions('?mock=1&state=listening')).toEqual({ freezeState: 'listening', confirm: false })
    expect(parseMockOptions('?mock=1&state=bogus')).toEqual({ freezeState: null, confirm: false })
    expect(parseMockOptions('?mock=1&state=toString')).toEqual({ freezeState: null, confirm: false })
    expect(parseMockOptions('?mock=1&confirm=1')).toEqual({ freezeState: 'awaiting_confirmation', confirm: true })
  })
})

describe('speechLevel', () => {
  it('всегда в пределах 0..1', () => {
    for (let t = 0; t < 10; t += 0.033) {
      for (const n of [0, 0.5, 1]) {
        const v = speechLevel(t, n)
        expect(v).toBeGreaterThanOrEqual(0)
        expect(v).toBeLessThanOrEqual(1)
      }
    }
  })
})

describe('MockCore', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    useSwyvorn.setState(initialStore, true)
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('начинает с hello в демо-режиме, история сети заполнена, метрики раз в секунду', () => {
    const { core, sent } = startCore({ freezeState: 'idle', confirm: false })
    expect(sent[0].type).toBe('hello')
    const s = useSwyvorn.getState()
    expect(s.info?.demo).toBe(true)
    expect(s.messages.length).toBeGreaterThan(0)
    expect(s.actions.length).toBeGreaterThan(0)
    expect(s.netHistory).toHaveLength(59)

    vi.advanceTimersByTime(3000)
    const m = useSwyvorn.getState().metrics
    expect(m).not.toBeNull()
    expect(m!.cpu_percent).toBeGreaterThanOrEqual(0)
    expect(m!.cpu_percent).toBeLessThanOrEqual(100)
    expect(m!.ram_used_mb).toBeLessThan(m!.ram_total_mb)
    expect(useSwyvorn.getState().netHistory).toHaveLength(60)
    core.dispose()
  })

  it('в замороженном «слушаю» шлёт уровень микрофона ~30 раз в секунду', () => {
    const { core, sent } = startCore({ freezeState: 'listening', confirm: false })
    const before = sent.length
    vi.advanceTimersByTime(1000)
    const levels = sent.slice(before).filter((m) => m.type === 'audio_level')
    expect(levels.length).toBeGreaterThanOrEqual(29)
    expect(levels.every((m) => m.type === 'audio_level' && m.source === 'mic')).toBe(true)
    expect(useSwyvorn.getState().state).toBe('listening')
    core.dispose()
  })

  it('подтверждение: вопрос → отсчёт → неверный nonce отвергается → «да» выполняет демо', async () => {
    const { core } = startCore({ freezeState: 'awaiting_confirmation', confirm: true })
    let c = useSwyvorn.getState().confirmation
    expect(c).not.toBeNull()
    expect(c!.expires_at).toBeNull()
    expect(c!.demo).toBe(true)

    await vi.advanceTimersByTimeAsync(1500)
    c = useSwyvorn.getState().confirmation
    expect(c!.expires_at).toBeGreaterThan(Date.now())

    core.handle({ type: 'confirm', action_id: c!.action_id, nonce: 'wrong', decision: 'yes' })
    expect(useSwyvorn.getState().confirmation).not.toBeNull()
    expect(useSwyvorn.getState().notices.at(-1)?.code).toBe('stale_confirmation')

    core.handle({ type: 'confirm', action_id: c!.action_id, nonce: c!.nonce, decision: 'yes' })
    expect(useSwyvorn.getState().confirmation).toBeNull()
    await vi.advanceTimersByTimeAsync(0)
    expect(useSwyvorn.getState().state).toBe('executing')

    await vi.advanceTimersByTimeAsync(1500)
    const entry = useSwyvorn.getState().actions.find((a) => a.id === c!.action_id)
    expect(entry?.status).toBe('ok')
    expect(entry?.decision).toBe('confirmed_button')
    expect(entry?.detail).toBe('Демо: ничего не удалялось')
    core.dispose()
  })

  it('без ответа подтверждение истекает', async () => {
    const { core } = startCore({ freezeState: 'awaiting_confirmation', confirm: true })
    const id = useSwyvorn.getState().confirmation!.action_id
    await vi.advanceTimersByTimeAsync(1500 + 15_000)
    expect(useSwyvorn.getState().confirmation).toBeNull()
    expect(useSwyvorn.getState().actions.find((a) => a.id === id)?.status).toBe('timeout')
    core.dispose()
  })

  it('«Стоп» закрывает вопрос, помечает действие и возвращается в ожидание', async () => {
    const { core } = startCore({ freezeState: 'awaiting_confirmation', confirm: true })
    const id = useSwyvorn.getState().confirmation!.action_id
    core.handle({ type: 'stop', source: 'button' })
    const s = useSwyvorn.getState()
    expect(s.state).toBe('stopped')
    expect(s.lastStop?.source).toBe('button')
    expect(s.confirmation).toBeNull()
    expect(s.actions.find((a) => a.id === id)?.status).toBe('stopped')
    await vi.advanceTimersByTimeAsync(800)
    expect(useSwyvorn.getState().state).toBe('idle')
    core.dispose()
  })

  it('send_text: реплика → думаю → потоковый ответ с текстом пользователя', async () => {
    const { core } = startCore({ freezeState: 'idle', confirm: false })
    core.handle({ type: 'send_text', text: '  проверка  ' })
    let s = useSwyvorn.getState()
    expect(s.messages.at(-1)).toMatchObject({ role: 'user', text: 'проверка' })
    expect(s.state).toBe('thinking')

    await vi.advanceTimersByTimeAsync(1200)
    s = useSwyvorn.getState()
    expect(s.state).toBe('speaking')
    expect(s.messages.at(-1)).toMatchObject({ role: 'assistant', streaming: true })

    await vi.advanceTimersByTimeAsync(4000)
    s = useSwyvorn.getState()
    expect(s.state).toBe('idle')
    const reply = s.messages.at(-1)!
    expect(reply.streaming).toBe(false)
    expect(reply.text).toContain('„проверка“')
    core.dispose()
  })

  it('демо-команды и выключение микрофона', () => {
    const { core } = startCore({ freezeState: 'idle', confirm: false })
    core.handle({ type: 'demo', action: 'set_state', state: 'thinking' })
    expect(useSwyvorn.getState().state).toBe('thinking')
    core.handle({ type: 'mute', muted: true })
    expect(useSwyvorn.getState().muted).toBe(true)
    core.handle({ type: 'demo', action: 'confirmation' })
    expect(useSwyvorn.getState().confirmation).not.toBeNull()
    core.handle({ type: 'demo', action: 'stop' })
    expect(useSwyvorn.getState().confirmation).toBeNull()
    expect(useSwyvorn.getState().state).toBe('idle')
    core.dispose()
  })

  it('сценарий идёт по шагам демо', async () => {
    const { core } = startCore({ freezeState: null, confirm: false })
    expect(useSwyvorn.getState().state).toBe('idle')
    await vi.advanceTimersByTimeAsync(4000)
    expect(useSwyvorn.getState().state).toBe('listening')
    await vi.advanceTimersByTimeAsync(3000)
    expect(useSwyvorn.getState().messages.at(-1)?.text).toBe('Свайворн, какая сегодня погода?')
    expect(useSwyvorn.getState().state).toBe('thinking')
    await vi.advanceTimersByTimeAsync(2500)
    expect(useSwyvorn.getState().state).toBe('speaking')
    await vi.advanceTimersByTimeAsync(6000)
    const weather = useSwyvorn.getState().actions.find((a) => a.tool === 'weather')
    expect(weather?.status).toBe('ok')
    expect(weather?.demo).toBe(true)
    core.dispose()
  })
})
