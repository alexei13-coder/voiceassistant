import { describe, expect, it } from 'vitest'
import { isAwaitingReply, splitStatusSuffix } from './chat'
import type { ChatMessage } from './protocol'

const msg = (role: ChatMessage['role'], text = 'x'): ChatMessage => ({
  id: `${role}-${text}`,
  role,
  text,
  streaming: false,
  created_at: 0,
})

describe('isAwaitingReply', () => {
  it('точки — пока ядро думает над репликой пользователя', () => {
    expect(isAwaitingReply('thinking', [msg('assistant'), msg('user')])).toBe(true)
    expect(isAwaitingReply('thinking', [msg('user'), msg('assistant')])).toBe(false)
    expect(isAwaitingReply('idle', [msg('user')])).toBe(false)
    expect(isAwaitingReply('thinking', [])).toBe(false)
  })
})

describe('splitStatusSuffix', () => {
  it('отделяет служебную пометку в конце ответа', () => {
    expect(splitStatusSuffix('Сейчас посмотрю (остановлено)')).toEqual({ body: 'Сейчас посмотрю', suffix: '(остановлено)' })
    expect(splitStatusSuffix('Длинный текст…(ответ обрезан)\n')).toEqual({
      body: 'Длинный текст…',
      suffix: '(ответ обрезан)',
    })
    expect(splitStatusSuffix('(остановлено)')).toEqual({ body: '', suffix: '(остановлено)' })
  })

  it('пометка в середине текста — это просто текст', () => {
    expect(splitStatusSuffix('Статус (остановлено) — это нормально')).toEqual({
      body: 'Статус (остановлено) — это нормально',
      suffix: null,
    })
  })
})
