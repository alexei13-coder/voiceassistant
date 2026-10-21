import { describe, expect, it } from 'vitest'
import type { UsageTotals } from './protocol'
import type { UsageState } from './store'
import { limitFraction, limitTone, usageTooltip } from './usage'

const totals = (cost: number, extra: Partial<UsageTotals> = {}): UsageTotals => ({
  input_tokens: 0,
  output_tokens: 0,
  cache_read_tokens: 0,
  cache_write_tokens: 0,
  web_searches: 0,
  cost_usd: cost,
  ...extra,
})

const usage = (month: number, limit: number): UsageState => ({
  session: totals(0.021),
  month: totals(month),
  lastTurn: null,
  monthlyLimitUsd: limit,
})

describe('месячный лимит', () => {
  it('без лимита полосы нет', () => {
    expect(limitFraction(usage(3, 0))).toBeNull()
    expect(limitFraction(usage(3, -1))).toBeNull()
  })

  it('доля в пределах 0..1', () => {
    expect(limitFraction(usage(0.37, 5))).toBeCloseTo(0.074)
    expect(limitFraction(usage(9, 5))).toBe(1)
  })

  it('тон: спокойно, после 80 % жёлтый, на 100 % красный', () => {
    expect(limitTone(0.5)).toBe('ok')
    expect(limitTone(0.8)).toBe('ok')
    expect(limitTone(0.81)).toBe('warn')
    expect(limitTone(1)).toBe('over')
  })
})

describe('usageTooltip', () => {
  it('перечисляет токены сессии и месяца и помечает оценку', () => {
    const text = usageTooltip({
      session: totals(0.021, { input_tokens: 4210, output_tokens: 512, cache_read_tokens: 18_600, web_searches: 1 }),
      month: totals(0.37, { cache_write_tokens: 48_200 }),
      lastTurn: null,
      monthlyLimitUsd: 5,
    })
    const lines = text.split('\n')
    expect(lines[0]).toBe('Сессия — $0.021')
    expect(lines[1]).toBe('токены: входные 4 210 · выходные 512')
    expect(lines[2]).toBe('кэш: чтение 18 600 · запись 0')
    expect(lines[3]).toBe('поиск в интернете: 1')
    expect(text).toContain('Месяц — $0.37 из $5')
    expect(text).toContain('запись 48 200')
    expect(lines.at(-1)).toContain('Оценка по прейскуранту')
  })

  it('без лимита — без «из $…»', () => {
    expect(usageTooltip(usage(0.37, 0))).toContain('Месяц — $0.37\n')
  })
})
