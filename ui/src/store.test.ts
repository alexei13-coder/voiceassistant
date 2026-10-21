import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PROTOCOL_VERSION, type HelloMessage, type ServerMessage, type UsageTotals } from './protocol'
import { useSwyvorn } from './store'

const initialStore = useSwyvorn.getState()
const apply = (msg: ServerMessage) => useSwyvorn.getState().applyServerMessage(msg)

const totals = (cost: number): UsageTotals => ({
  input_tokens: 100,
  output_tokens: 20,
  cache_read_tokens: 0,
  cache_write_tokens: 0,
  web_searches: 0,
  cost_usd: cost,
})

function hello(overrides: Partial<HelloMessage> = {}): HelloMessage {
  return {
    type: 'hello',
    ts: 1,
    protocol: PROTOCOL_VERSION,
    core_version: '0.2.0',
    state: 'idle',
    demo: false,
    assistant_name: 'SWYVORN',
    wake_word: 'Свайворн',
    address_form: 'сэр',
    model: 'claude-opus-5-5',
    hotkeys: {
      activate: 'Ctrl+Alt+J',
      stop: 'Ctrl+Alt+Escape',
      stop_fallback: 'Ctrl+Alt+Backspace',
      mute: 'Ctrl+Alt+M',
      repeat: 'Ctrl+Alt+R',
      screen: 'Ctrl+Alt+S',
    },
    ui: { reduced_motion: false },
    muted: false,
    history: [{ id: 'm1', role: 'user', text: 'привет', streaming: false, created_at: 1 }],
    actions: [
      { id: 'a1', created_at: 1, tool: 'remember', title: 'Запомнить: имя', risk: 'safe', status: 'ok' },
    ],
    confirmation: null,
    brain: { status: 'ready', model: 'claude-opus-5-5', web_search: true, message: null },
    usage: { session: totals(0.021), month: totals(0.37), monthly_limit_usd: 5 },
    memory: [{ key: 'address_form', value: 'шеф', updated_at: 1 }],
    ...overrides,
  }
}

describe('store: протокол v2', () => {
  beforeEach(() => {
    useSwyvorn.setState(initialStore, true)
  })

  it('hello приносит «мозг», расходы и память', () => {
    apply(hello())
    const s = useSwyvorn.getState()
    expect(s.brain?.status).toBe('ready')
    expect(s.usage).toEqual({ session: totals(0.021), month: totals(0.37), lastTurn: null, monthlyLimitUsd: 5 })
    expect(s.memory).toEqual([{ key: 'address_form', value: 'шеф', updated_at: 1 }])
    expect(s.notices).toHaveLength(0)
  })

  it('чужая версия протокола — заметная ошибка, но интерфейс работает', () => {
    const old = hello({ protocol: 1 }) as Partial<HelloMessage>
    delete old.brain
    delete old.usage
    delete old.memory
    apply(old as HelloMessage)
    const s = useSwyvorn.getState()
    expect(s.messages).toHaveLength(1)
    expect(s.brain).toBeNull()
    expect(s.usage).toBeNull()
    expect(s.memory).toEqual([])
    expect(s.notices.at(-1)).toMatchObject({ level: 'error', code: 'protocol_mismatch' })
    expect(s.notices.at(-1)?.text).toContain('протокол 1, нужен 2')
  })

  it('brain_status обновляет статус, а с ним демо-режим и модель', () => {
    apply(hello({ demo: true, brain: { status: 'demo', model: 'claude-opus-5-5', web_search: true, message: null } }))
    expect(useSwyvorn.getState().info?.demo).toBe(true)
    apply({
      type: 'brain_status',
      ts: 2,
      brain: { status: 'ready', model: 'claude-sonnet-5-5', web_search: false, message: null },
    })
    const s = useSwyvorn.getState()
    expect(s.brain).toEqual({ status: 'ready', model: 'claude-sonnet-5-5', web_search: false, message: null })
    expect(s.info?.demo).toBe(false)
    expect(s.info?.model).toBe('claude-sonnet-5-5')
  })

  it('usage после ответа: сессия, месяц, последний ход и лимит', () => {
    apply(hello())
    apply({ type: 'usage', ts: 2, session: totals(0.03), month: totals(0.4), last_turn: totals(0.009), monthly_limit_usd: 0 })
    expect(useSwyvorn.getState().usage).toEqual({
      session: totals(0.03),
      month: totals(0.4),
      lastTurn: totals(0.009),
      monthlyLimitUsd: 0,
    })
  })

  it('memory заменяет список целиком', () => {
    apply(hello())
    apply({ type: 'memory', ts: 2, facts: [{ key: 'city', value: 'Казань', updated_at: 2 }] })
    expect(useSwyvorn.getState().memory).toEqual([{ key: 'city', value: 'Казань', updated_at: 2 }])
    apply({ type: 'memory', ts: 3, facts: [] })
    expect(useSwyvorn.getState().memory).toEqual([])
  })

  it('session_reset очищает ленту, журнал действий остаётся', () => {
    apply(hello())
    const epoch = useSwyvorn.getState().chatEpoch
    apply({ type: 'session_reset', ts: 2 })
    const s = useSwyvorn.getState()
    expect(s.messages).toEqual([])
    expect(s.actions).toHaveLength(1)
    expect(s.chatEpoch).toBe(epoch + 1)
    // Поздние дельты сброшенного ответа просто игнорируются.
    apply({ type: 'chat_delta', ts: 3, id: 'm1', delta: 'хвост' })
    expect(useSwyvorn.getState().messages).toEqual([])
  })
})

describe('store: уведомления', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    useSwyvorn.setState(initialStore, true)
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('уровень поднимается по коду «мозга»', () => {
    apply({ type: 'notice', ts: 1, level: 'warning', text: 'На балансе API закончились деньги.', code: 'brain_credit' })
    expect(useSwyvorn.getState().notices.at(-1)?.level).toBe('error')
  })

  it('одинаковые подряд не копятся, а продлевают показ', () => {
    const notice: ServerMessage = { type: 'notice', ts: 1, level: 'warning', text: 'Нет связи с Claude.', code: 'brain_offline' }
    apply(notice)
    const first = useSwyvorn.getState().notices[0]
    vi.advanceTimersByTime(3000)
    apply(notice)
    let notices = useSwyvorn.getState().notices
    expect(notices).toHaveLength(1)
    expect(notices[0].id).toBe(first.id)
    expect(notices[0].createdAt).toBe(first.createdAt + 3000)

    apply({ ...notice, text: 'Другое' })
    apply(notice)
    notices = useSwyvorn.getState().notices
    expect(notices.map((n) => n.text)).toEqual(['Нет связи с Claude.', 'Другое', 'Нет связи с Claude.'])
  })

  it('короткая подсказка в ленте: новая вытесняет старую, снять можно только свою', () => {
    const { showFlash } = useSwyvorn.getState()
    showFlash('Ссылка скопирована')
    const first = useSwyvorn.getState().flash!
    expect(first).toMatchObject({ text: 'Ссылка скопирована', tone: 'ok' })
    showFlash('Не удалось скопировать ссылку', 'warn')
    const second = useSwyvorn.getState().flash!
    useSwyvorn.getState().clearFlash(first.id)
    expect(useSwyvorn.getState().flash).toBe(second)
    useSwyvorn.getState().clearFlash(second.id)
    expect(useSwyvorn.getState().flash).toBeNull()
  })
})
