import { describe, expect, it } from 'vitest'
import { chartMax, gaugeDash, gaugeTone, sparklineArea, sparklineLine } from './chart'

describe('шкала', () => {
  it('длина дуги пропорциональна значению и ограничена', () => {
    const r = 40
    const c = 2 * Math.PI * r
    const sweep = c * 0.75
    expect(gaugeDash(0, r).value).toBe(`0.00 ${c.toFixed(2)}`)
    expect(gaugeDash(0.5, r).value).toBe(`${(sweep / 2).toFixed(2)} ${c.toFixed(2)}`)
    expect(gaugeDash(2, r).value).toBe(gaugeDash(1, r).track)
    expect(gaugeDash(Number.NaN, r).value).toBe(`0.00 ${c.toFixed(2)}`)
  })

  it('тон по порогам', () => {
    expect(gaugeTone(40)).toBe('normal')
    expect(gaugeTone(75)).toBe('warn')
    expect(gaugeTone(95)).toBe('critical')
  })
})

describe('график сети', () => {
  it('верх шкалы с запасом и не ниже порога', () => {
    expect(chartMax([], 1000)).toBeCloseTo(1150)
    expect(chartMax([10, 5000, Number.NaN], 1000)).toBeCloseTo(5750)
  })

  it('линия растягивается на всю ширину, ноль — у нижнего края', () => {
    expect(sparklineLine([0, 50, 100], 100, 40, 100)).toBe('M0.0 40.0 L50.0 20.0 L100.0 0.0')
    expect(sparklineLine([5], 100, 40, 100)).toBe('')
  })

  it('область замкнута по нижнему краю', () => {
    expect(sparklineArea([0, 100], 10, 10, 100)).toBe('M0.0 10.0 L10.0 0.0 L10.0 10.0 L0 10.0 Z')
    expect(sparklineArea([], 10, 10, 100)).toBe('')
  })
})
