import { describe, expect, it } from 'vitest'
import { noticeLevel } from './notices'

describe('noticeLevel', () => {
  it('ошибки «мозга», которые не пройдут сами, всегда красные', () => {
    expect(noticeLevel('warning', 'brain_credit')).toBe('error')
    expect(noticeLevel('info', 'brain_invalid_key')).toBe('error')
    expect(noticeLevel('info', 'brain_model_access')).toBe('error')
  })

  it('временные — не ниже жёлтого, отказ — как прислало ядро', () => {
    expect(noticeLevel('info', 'brain_offline')).toBe('warning')
    expect(noticeLevel('info', 'brain_overloaded')).toBe('warning')
    expect(noticeLevel('info', 'brain_refusal')).toBe('info')
  })

  it('уровень ядра не понижается, прочие коды не трогаются', () => {
    expect(noticeLevel('error', 'brain_offline')).toBe('error')
    expect(noticeLevel('warning', 'muted')).toBe('warning')
    expect(noticeLevel('info', null)).toBe('info')
    expect(noticeLevel('info', 'toString')).toBe('info')
  })
})
