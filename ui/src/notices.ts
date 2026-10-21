// Уровни уведомлений по кодам. Текст по-русски присылает ядро; UI решает только, насколько
// заметно его показать (docs/brain.md, «Ошибки API»).

import type { BrainNoticeCode } from './protocol'

export type NoticeLevel = 'info' | 'warning' | 'error'

const SEVERITY: Record<NoticeLevel, number> = { info: 0, warning: 1, error: 2 }

/**
 * Минимальный уровень для кодов «мозга». Ошибки, которые без действий пользователя не пройдут
 * (ключ, баланс, доступ к модели), — красные; временные (сеть, перегрузка, частота) — жёлтые.
 */
const MIN_LEVEL_BY_CODE: Record<BrainNoticeCode, NoticeLevel> = {
  brain_no_key: 'warning',
  brain_invalid_key: 'error',
  brain_offline: 'warning',
  brain_limit: 'warning',
  brain_credit: 'error',
  brain_overloaded: 'warning',
  brain_rate_limited: 'warning',
  brain_model_access: 'error',
  brain_refusal: 'info',
  brain_error: 'error',
}

/** Уровень показа: не ниже, чем считает ядро, и не ниже минимума для кода. */
export function noticeLevel(level: NoticeLevel, code: string | null): NoticeLevel {
  const floor = code !== null && Object.hasOwn(MIN_LEVEL_BY_CODE, code) ? MIN_LEVEL_BY_CODE[code as BrainNoticeCode] : 'info'
  return SEVERITY[floor] > SEVERITY[level] ? floor : level
}
