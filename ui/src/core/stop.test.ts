import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DOUBLE_PRESS_WINDOW_MS, STOP_ACK_TIMEOUT_MS, createStopController, type EmergencyReason } from './stop'

function setup(opts: { connected?: boolean } = {}) {
  let ackAt: number | null = null
  const emergencies: EmergencyReason[] = []
  const send = vi.fn(() => opts.connected ?? true)
  const controller = createStopController({
    send,
    acknowledgedSince: (since) => ackAt !== null && ackAt >= since,
    emergency: (r) => emergencies.push(r),
  })
  return { controller, send, emergencies, ack: () => (ackAt = Date.now()) }
}

describe('кнопка «Стоп»', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('ядро подтвердило стоп — аварийный не нужен', () => {
    const t = setup()
    expect(t.controller.press()).toBe('sent')
    expect(t.send).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(200)
    t.ack()
    vi.advanceTimersByTime(STOP_ACK_TIMEOUT_MS)
    expect(t.emergencies).toEqual([])
  })

  it('нет ответа за 1 с — аварийный стоп', () => {
    const t = setup()
    t.controller.press()
    vi.advanceTimersByTime(STOP_ACK_TIMEOUT_MS - 1)
    expect(t.emergencies).toEqual([])
    vi.advanceTimersByTime(1)
    expect(t.emergencies).toEqual(['no_ack'])
  })

  it('нет связи — аварийный стоп сразу', () => {
    const t = setup({ connected: false })
    expect(t.controller.press()).toBe('emergency')
    expect(t.emergencies).toEqual(['not_connected'])
  })

  it('два нажатия за 2 с — аварийный стоп ровно один раз', () => {
    const t = setup()
    t.controller.press()
    t.ack()
    vi.advanceTimersByTime(DOUBLE_PRESS_WINDOW_MS - 500)
    expect(t.controller.press()).toBe('emergency')
    vi.advanceTimersByTime(STOP_ACK_TIMEOUT_MS * 3)
    expect(t.emergencies).toEqual(['double_press'])
    expect(t.send).toHaveBeenCalledTimes(1)
  })

  it('нажатия с интервалом больше 2 с — обычные', () => {
    const t = setup()
    t.controller.press()
    t.ack()
    vi.advanceTimersByTime(DOUBLE_PRESS_WINDOW_MS + 1)
    expect(t.controller.press()).toBe('sent')
    t.ack()
    vi.advanceTimersByTime(STOP_ACK_TIMEOUT_MS)
    expect(t.emergencies).toEqual([])
  })
})
