// Быстро меняющиеся значения, которые НЕ должны проходить через React-состояние.
// Пишет: core/connection.ts (по сообщениям audio_level).
// Читает: orb/ в requestAnimationFrame.

export interface LiveLevels {
  /** Последний уровень микрофона 0..1. */
  mic: number
  /** Последний уровень синтезированной речи 0..1. */
  tts: number
  /** performance.now() последнего обновления mic. */
  micAt: number
  /** performance.now() последнего обновления tts. */
  ttsAt: number
}

export const liveLevels: LiveLevels = { mic: 0, tts: 0, micAt: 0, ttsAt: 0 }

export function pushLevel(source: 'mic' | 'tts', level: number): void {
  const v = Number.isFinite(level) ? Math.min(1, Math.max(0, level)) : 0
  const now = performance.now()
  if (source === 'mic') {
    liveLevels.mic = v
    liveLevels.micAt = now
  } else {
    liveLevels.tts = v
    liveLevels.ttsAt = now
  }
}

/** Уровень с затуханием: если обновлений не было > 150 мс, плавно уходит в 0. */
export function currentLevel(source: 'mic' | 'tts', now = performance.now()): number {
  const v = source === 'mic' ? liveLevels.mic : liveLevels.tts
  const at = source === 'mic' ? liveLevels.micAt : liveLevels.ttsAt
  const age = now - at
  if (age <= 150) return v
  return v * Math.max(0, 1 - (age - 150) / 250)
}
