import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { isAwaitingReply } from '../chat'
import type { ServerMessage } from '../protocol'
import { useSwyvorn } from '../store'
import { MockCore, OPENING_DELAY_MS, OPENING_THINK_MS, parseMockOptions, speechLevel, type MockOptions } from './mockCore'
import { OPENING_QUESTION, rememberRequest } from './mockSeed'

const initialStore = useSwyvorn.getState()

function startCore(options: Partial<MockOptions> = {}) {
  const sent: ServerMessage[] = []
  const core = new MockCore(
    (msg) => {
      sent.push(msg)
      useSwyvorn.getState().applyServerMessage(msg)
    },
    { freezeState: 'idle', confirm: false, brain: 'ready', ...options },
  )
  core.start()
  return { core, sent }
}

describe('parseMockOptions', () => {
  it('разбирает state, confirm и brain', () => {
    expect(parseMockOptions('?mock=1')).toEqual({ freezeState: null, confirm: false, brain: 'ready' })
    expect(parseMockOptions('?mock=1&state=listening')).toEqual({ freezeState: 'listening', confirm: false, brain: 'ready' })
    expect(parseMockOptions('?mock=1&state=bogus')).toEqual({ freezeState: null, confirm: false, brain: 'ready' })
    expect(parseMockOptions('?mock=1&state=toString')).toEqual({ freezeState: null, confirm: false, brain: 'ready' })
    expect(parseMockOptions('?mock=1&confirm=1')).toEqual({ freezeState: 'awaiting_confirmation', confirm: true, brain: 'ready' })
    expect(parseMockOptions('?mock=1&brain=no_key').brain).toBe('no_key')
    expect(parseMockOptions('?mock=1&brain=invalid_key').brain).toBe('invalid_key')
    expect(parseMockOptions('?mock=1&brain=demo').brain).toBe('demo')
    expect(parseMockOptions('?mock=1&brain=nonsense').brain).toBe('ready')
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

describe('rememberRequest', () => {
  it('выделяет, что запомнить', () => {
    expect(rememberRequest('Запомни, что я пью чай без сахара')).toBe('я пью чай без сахара')
    expect(rememberRequest('запомни: дверь кода 1234')).toBe('дверь кода 1234')
    expect(rememberRequest('что ты помнишь?')).toBeNull()
  })
})

describe('MockCore: сессия этапа 2', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    useSwyvorn.setState(initialStore, true)
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('hello протокола 2: Claude готов, память, расходы, Markdown-ответ и запись remember', () => {
    const { core, sent } = startCore()
    expect(sent[0]).toMatchObject({ type: 'hello', protocol: 2 })
    const s = useSwyvorn.getState()
    expect(s.info?.demo).toBe(false)
    expect(s.brain).toMatchObject({ status: 'ready', model: 'claude-opus-5-5', message: null })
    expect(s.memory.map((f) => [f.key, f.value])).toEqual([
      ['address_form', 'шеф'],
      ['user_name', 'Алексей'],
    ])
    expect(s.usage?.session.cost_usd).toBe(0.021)
    expect(s.usage?.month.cost_usd).toBe(0.37)
    expect(s.usage?.monthlyLimitUsd).toBe(5)
    const markdown = s.messages.find((m) => m.role === 'assistant' && m.text.includes('```powershell'))
    expect(markdown?.text).toMatch(/^- \*\*/m)
    expect(markdown?.text).toContain('](https://')
    expect(s.actions.some((a) => a.tool === 'remember' && a.status === 'ok')).toBe(true)
    core.dispose()
  })

  it('живой ход при запуске: вопрос → точки «печатает» → потоковый ответ → расход', async () => {
    const { core } = startCore({ freezeState: null })
    await vi.advanceTimersByTimeAsync(OPENING_DELAY_MS)
    let s = useSwyvorn.getState()
    expect(s.messages.at(-1)).toMatchObject({ role: 'user', text: OPENING_QUESTION })
    expect(isAwaitingReply(s.state, s.messages)).toBe(true)

    await vi.advanceTimersByTimeAsync(OPENING_THINK_MS)
    s = useSwyvorn.getState()
    expect(s.state).toBe('speaking')
    expect(s.messages.at(-1)).toMatchObject({ role: 'assistant', streaming: true })
    expect(isAwaitingReply(s.state, s.messages)).toBe(false)

    await vi.advanceTimersByTimeAsync(5000)
    s = useSwyvorn.getState()
    expect(s.state).toBe('idle')
    expect(s.messages.at(-1)?.streaming).toBe(false)
    expect(s.messages.at(-1)?.text).toContain('Get-Process -Id')
    expect(s.usage?.lastTurn?.cost_usd).toBeGreaterThan(0)
    expect(s.usage?.session.cost_usd).toBeGreaterThan(0.021)
    core.dispose()
  })

  it('«запомни …»: запись в журнале, факт в памяти, короткий ответ', async () => {
    const { core } = startCore()
    core.handle({ type: 'send_text', text: '  Запомни, что я пью чай без сахара ' })
    expect(useSwyvorn.getState().messages.at(-1)).toMatchObject({ role: 'user', text: 'Запомни, что я пью чай без сахара' })
    await vi.advanceTimersByTimeAsync(1400)
    expect(useSwyvorn.getState().state).toBe('executing')
    await vi.advanceTimersByTimeAsync(3000)
    const s = useSwyvorn.getState()
    expect(s.memory.at(-1)).toMatchObject({ key: 'note', value: 'я пью чай без сахара' })
    expect(s.actions.at(-1)).toMatchObject({ tool: 'remember', status: 'ok' })
    expect(s.messages.at(-1)).toMatchObject({ role: 'assistant', text: 'Запомнил, шеф.', streaming: false })
    core.dispose()
  })

  it('«Стоп» во время ответа оставляет пометку «(остановлено)»', async () => {
    const { core } = startCore()
    core.handle({ type: 'send_text', text: 'расскажи что-нибудь' })
    await vi.advanceTimersByTimeAsync(1400 + 500)
    expect(useSwyvorn.getState().messages.at(-1)?.streaming).toBe(true)
    core.handle({ type: 'stop', source: 'button' })
    await vi.advanceTimersByTimeAsync(0)
    const reply = useSwyvorn.getState().messages.at(-1)!
    expect(reply.streaming).toBe(false)
    expect(reply.text).toMatch(/ \(остановлено\)$/)
    core.dispose()
  })

  it('новый диалог очищает ленту, журнал и память остаются', () => {
    const { core } = startCore()
    const actions = useSwyvorn.getState().actions.length
    core.handle({ type: 'new_session' })
    const s = useSwyvorn.getState()
    expect(s.messages).toEqual([])
    expect(s.actions).toHaveLength(actions)
    expect(s.memory).toHaveLength(2)
    core.dispose()
  })

  it('память: удалить факт и очистить всё', () => {
    const { core } = startCore()
    core.handle({ type: 'memory_delete', key: 'address_form' })
    expect(useSwyvorn.getState().memory.map((f) => f.key)).toEqual(['user_name'])
    core.handle({ type: 'memory_clear' })
    expect(useSwyvorn.getState().memory).toEqual([])
    core.dispose()
  })

  it('демо-команды вне демо-режима отклоняются', () => {
    const { core } = startCore()
    core.handle({ type: 'demo', action: 'set_state', state: 'thinking' })
    expect(useSwyvorn.getState().state).toBe('idle')
    expect(useSwyvorn.getState().notices.at(-1)?.code).toBe('not_allowed')
    core.dispose()
  })
})

describe('MockCore: без ключа и с неверным ключом', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    useSwyvorn.setState(initialStore, true)
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('brain=no_key: пустая лента и память, реплика получает объяснение в ленте', () => {
    const { core } = startCore({ freezeState: null, brain: 'no_key' })
    let s = useSwyvorn.getState()
    expect(s.brain?.status).toBe('no_key')
    expect(s.brain?.message).toContain('ANTHROPIC_API_KEY')
    expect(s.messages).toEqual([])
    expect(s.memory).toEqual([])
    expect(s.usage?.monthlyLimitUsd).toBe(0)

    core.handle({ type: 'send_text', text: 'привет' })
    s = useSwyvorn.getState()
    expect(s.messages.map((m) => m.role)).toEqual(['user', 'system'])
    expect(s.messages[1].text).toContain('%APPDATA%\\Swyvorn\\.env')
    expect(s.state).toBe('idle')
    core.dispose()
  })

  it('brain=invalid_key: в ленте прошлый отказ, новая реплика — ошибка с кодом', () => {
    const { core } = startCore({ brain: 'invalid_key' })
    expect(useSwyvorn.getState().messages.at(-1)?.role).toBe('system')
    core.handle({ type: 'send_text', text: 'ещё раз' })
    const s = useSwyvorn.getState()
    expect(s.messages.at(-1)?.text).toContain('Ключ API не подошёл')
    expect(s.notices.at(-1)).toMatchObject({ level: 'error', code: 'brain_invalid_key' })
    core.dispose()
  })
})

describe('MockCore: демо этапа 1 (brain=demo)', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    useSwyvorn.setState(initialStore, true)
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('начинает с hello в демо-режиме, история сети заполнена, метрики раз в секунду', () => {
    const { core, sent } = startCore({ brain: 'demo' })
    expect(sent[0].type).toBe('hello')
    const s = useSwyvorn.getState()
    expect(s.info?.demo).toBe(true)
    expect(s.brain?.status).toBe('demo')
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
    const { core, sent } = startCore({ freezeState: 'listening', brain: 'demo' })
    const before = sent.length
    vi.advanceTimersByTime(1000)
    const levels = sent.slice(before).filter((m) => m.type === 'audio_level')
    expect(levels.length).toBeGreaterThanOrEqual(29)
    expect(levels.every((m) => m.type === 'audio_level' && m.source === 'mic')).toBe(true)
    expect(useSwyvorn.getState().state).toBe('listening')
    core.dispose()
  })

  it('подтверждение: вопрос → отсчёт → неверный nonce отвергается → «да» выполняет демо', async () => {
    const { core } = startCore({ freezeState: 'awaiting_confirmation', confirm: true, brain: 'demo' })
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
    const { core } = startCore({ freezeState: 'awaiting_confirmation', confirm: true, brain: 'demo' })
    const id = useSwyvorn.getState().confirmation!.action_id
    await vi.advanceTimersByTimeAsync(1500 + 15_000)
    expect(useSwyvorn.getState().confirmation).toBeNull()
    expect(useSwyvorn.getState().actions.find((a) => a.id === id)?.status).toBe('timeout')
    core.dispose()
  })

  it('«Стоп» закрывает вопрос, помечает действие и возвращается в ожидание', async () => {
    const { core } = startCore({ freezeState: 'awaiting_confirmation', confirm: true, brain: 'demo' })
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
    const { core } = startCore({ brain: 'demo' })
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
    const { core } = startCore({ brain: 'demo' })
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
    const { core } = startCore({ freezeState: null, brain: 'demo' })
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
