import { describe, expect, it } from 'vitest'
import type { AssistantState } from './protocol'
import { STATE_WORDS, connectionBanner, offlineHint, roleLabel, stateHint } from './labels'

const ctx = { reason: null, activateHotkey: 'Ctrl+Shift+Space', wakeWord: 'Пятница' }

describe('stateHint', () => {
  it('в ожидании подставляет имя и сочетание из настроек', () => {
    expect(stateHint('idle', ctx)).toBe('Скажите „Пятница“ или нажмите Ctrl+Shift+Space')
  })

  it('без hello — значения по умолчанию', () => {
    expect(stateHint('idle', { reason: null, activateHotkey: undefined, wakeWord: undefined })).toBe(
      'Скажите „Свайворн“ или нажмите Ctrl+Alt+J',
    )
  })

  it('ошибка показывает причину, пустая причина — общий текст', () => {
    expect(stateHint('error', { ...ctx, reason: 'Нет сети' })).toBe('Нет сети')
    expect(stateHint('error', { ...ctx, reason: '   ' })).toBe('Что-то пошло не так')
  })

  it('у каждого состояния есть подсказка', () => {
    const states: AssistantState[] = [
      'idle',
      'listening',
      'thinking',
      'speaking',
      'awaiting_confirmation',
      'executing',
      'error',
      'stopped',
    ]
    for (const s of states) expect(stateHint(s, ctx).length).toBeGreaterThan(0)
    expect(stateHint('speaking', ctx)).toBe('Говорю — можно перебить')
    expect(stateHint('stopped', ctx)).toBe('Всё остановлено')
  })

  it('вопрос «только кнопкой» не зовёт к голосовому «да»', () => {
    expect(stateHint('awaiting_confirmation', ctx)).toBe('Скажите „да“ или нажмите кнопку')
    expect(stateHint('awaiting_confirmation', { ...ctx, buttonOnly: true })).toBe('Подтвердите кнопкой на экране')
  })
})

describe('roleLabel', () => {
  it('подписи ролей', () => {
    expect(roleLabel('user', 'SWYVORN')).toBe('вы')
    expect(roleLabel('system', 'SWYVORN')).toBe('система')
    expect(roleLabel('assistant', 'Пятница')).toBe('Пятница')
    expect(roleLabel('assistant', '')).toBe('SWYVORN')
  })
})

describe('STATE_WORDS', () => {
  it('слова состояний строчными, у каждого состояния своё', () => {
    const words = Object.values(STATE_WORDS)
    for (const w of words) expect(w).toBe(w.toLowerCase())
    expect(new Set(words).size).toBe(words.length)
    expect(STATE_WORDS.awaiting_confirmation).toBe('жду подтверждения')
  })
})

describe('offlineHint', () => {
  it('на связи — обычная подсказка, иначе — объяснение', () => {
    expect(offlineHint('connected')).toBeNull()
    expect(offlineHint('connecting')).toBe('Подключаюсь к ядру…')
    expect(offlineHint('disconnected')).toContain('Ядро недоступно')
    expect(offlineHint('unauthorized')).toContain('отклонило')
  })
})

describe('connectionBanner', () => {
  it('на связи — без полосы, даже со старым статусом процесса', () => {
    expect(connectionBanner('connected', 'crashed', 'boom')).toBeNull()
    expect(connectionBanner('connecting', null, null)).toBeNull()
  })

  it('статус процесса важнее статуса сокета', () => {
    expect(connectionBanner('disconnected', 'fatal', 'порт занят')).toEqual({
      level: 'error',
      text: 'Ядро не запускается: порт занят',
    })
    expect(connectionBanner('disconnected', 'restarting', null)).toEqual({ level: 'warning', text: 'Перезапуск ядра…' })
    expect(connectionBanner('disconnected', 'crashed', ' ')?.text).toBe('Ядро аварийно завершилось — перезапускаю…')
  })

  it('обрыв и неверный токен', () => {
    expect(connectionBanner('disconnected', 'ready', null)?.text).toBe('Нет связи с ядром — переподключаюсь…')
    expect(connectionBanner('unauthorized', null, null)).toEqual({ level: 'error', text: 'Ошибка доступа к ядру (токен)' })
  })
})
