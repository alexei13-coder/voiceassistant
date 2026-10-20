import { describe, expect, it } from 'vitest'
import {
  decimalRu,
  formatClock,
  formatDuration,
  formatFullDate,
  formatGigabytes,
  formatHotkey,
  formatMemory,
  formatPercent,
  formatRate,
  formatShortDate,
  formatTimeShort,
  formatUptime,
} from './format'

// Локальное время: конструктор Date с компонентами не зависит от часового пояса машины.
const MONDAY = new Date(2026, 9, 19, 7, 5, 9)

describe('время и даты', () => {
  it('часы с ведущими нулями', () => {
    expect(formatClock(MONDAY)).toBe('07:05:09')
    expect(formatTimeShort(MONDAY.getTime())).toBe('07:05')
  })

  it('короткая и полная русская дата', () => {
    expect(formatShortDate(MONDAY)).toBe('пн, 19 окт')
    expect(formatFullDate(MONDAY)).toBe('понедельник, 19 октября 2026')
    expect(formatShortDate(new Date(2026, 4, 3))).toBe('вс, 3 мая')
    expect(formatFullDate(new Date(2026, 4, 3))).toBe('воскресенье, 3 мая 2026')
  })
})

describe('скорость сети', () => {
  it('байты без дробной части', () => {
    expect(formatRate(0)).toBe('0 Б/с')
    expect(formatRate(512.4)).toBe('512 Б/с')
    expect(formatRate(999)).toBe('999 Б/с')
  })

  it('килобайты и мегабайты с запятой', () => {
    expect(formatRate(1000)).toBe('1,0 КБ/с')
    expect(formatRate(12_595)).toBe('12,3 КБ/с')
    expect(formatRate(512 * 1024)).toBe('512 КБ/с')
    expect(formatRate(1.5 * 1024 * 1024)).toBe('1,5 МБ/с')
    expect(formatRate(3 * 1024 ** 3)).toBe('3,0 ГБ/с')
  })

  it('не разрастается до четырёх цифр', () => {
    expect(formatRate(1023 * 1024)).toBe('1,0 МБ/с')
  })

  it('мусор превращается в ноль', () => {
    expect(formatRate(Number.NaN)).toBe('0 Б/с')
    expect(formatRate(-5)).toBe('0 Б/с')
    expect(formatRate(Number.POSITIVE_INFINITY)).toBe('0 Б/с')
  })
})

describe('память, проценты, длительность', () => {
  it('гигабайты', () => {
    expect(formatGigabytes(12_083)).toBe('11,8')
    expect(formatMemory(12_083, 32_678)).toBe('11,8 / 31,9 ГБ')
  })

  it('проценты в пределах 0..100', () => {
    expect(formatPercent(37.6)).toBe('38')
    expect(formatPercent(140)).toBe('100')
    expect(formatPercent(-3)).toBe('0')
  })

  it('длительность действия', () => {
    expect(formatDuration(120)).toBe('120 мс')
    expect(formatDuration(1500)).toBe('1,5 с')
    expect(formatDuration(42_200)).toBe('42 с')
    expect(formatDuration(125_000)).toBe('2 мин 05 с')
  })

  it('время работы ядра', () => {
    expect(formatUptime(0)).toBe('00:00:00')
    expect(formatUptime(754.9)).toBe('00:12:34')
    expect(formatUptime(86_400 + 2 * 3600 + 3 * 60 + 4)).toBe('1 д 02:03:04')
  })

  it('десятичная запятая', () => {
    expect(decimalRu(3.14159, 2)).toBe('3,14')
  })
})

describe('горячие клавиши', () => {
  it('сокращает Escape', () => {
    expect(formatHotkey('Ctrl+Alt+Escape')).toBe('Ctrl+Alt+Esc')
    expect(formatHotkey('Ctrl + Alt + J')).toBe('Ctrl+Alt+J')
  })
})
