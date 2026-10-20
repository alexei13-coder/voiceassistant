// «Характер» ядра в каждом состоянии: цели, к которым модель плавно подводит параметры кадра.
// Скорости — рад/с, остальное — безразмерные множители 0..1 (энергия может быть чуть выше 1).

import type { AssistantState } from '../protocol'

export interface StateLook {
  /** Подмешать к цвету состояния цвет другого состояния (доля 0..1). */
  tint: readonly [AssistantState, number] | null
  energy: number
  ringSpeed: number
  arcSpeed: number
  /** Насколько уровень звука вытягивает столбики и раздувает плазму. */
  barGain: number
  /** Синтетическая бегущая волна по столбикам — «внутренняя работа» без звука. */
  barWave: number
  /** Чей уровень слушать: микрофон (слушаю) или синтез речи (говорю). */
  mic: number
  tts: number
  sweep: number
  particles: number
  chase: number
  /** Волны от ядра — «говорю». */
  ripple: number
  countdown: number
  collapse: number
  turbulence: number
  breath: number
}

const BASE: StateLook = {
  tint: null,
  energy: 1,
  ringSpeed: 0.1,
  arcSpeed: 0.3,
  barGain: 0,
  barWave: 0.03,
  mic: 0,
  tts: 0,
  sweep: 0,
  particles: 0,
  chase: 0,
  ripple: 0,
  countdown: 0,
  collapse: 0,
  turbulence: 0.5,
  breath: 0.4,
}

export const STATE_LOOKS: Record<AssistantState, StateLook> = {
  idle: { ...BASE, energy: 0.9, ringSpeed: 0.06, arcSpeed: 0.12, barWave: 0.04, turbulence: 0.35, breath: 1 },
  listening: { ...BASE, ringSpeed: 0.12, arcSpeed: 0.35, barGain: 1, mic: 1, turbulence: 0.6 },
  thinking: {
    ...BASE,
    ringSpeed: 0.24,
    arcSpeed: 1.5,
    barWave: 0.6,
    sweep: 1,
    particles: 1,
    turbulence: 1,
    breath: 0.25,
  },
  speaking: {
    ...BASE,
    energy: 1.05,
    ringSpeed: 0.12,
    arcSpeed: 0.4,
    barGain: 1,
    tts: 1,
    ripple: 1,
    turbulence: 0.7,
    breath: 0.3,
  },
  awaiting_confirmation: {
    ...BASE,
    energy: 0.92,
    ringSpeed: 0.04,
    arcSpeed: 0.1,
    barWave: 0.05,
    countdown: 1,
    turbulence: 0.4,
    breath: 0.8,
  },
  executing: {
    ...BASE,
    tint: ['listening', 0.22],
    energy: 1.2,
    ringSpeed: 0.3,
    arcSpeed: 0.9,
    barWave: 0.3,
    chase: 1,
    turbulence: 0.8,
    breath: 0.3,
  },
  error: { ...BASE, ringSpeed: 0.03, arcSpeed: 0.08, barWave: 0.03, turbulence: 0.9, breath: 0.5 },
  stopped: {
    ...BASE,
    energy: 0.6,
    ringSpeed: 0,
    arcSpeed: 0,
    barWave: 0,
    collapse: 1,
    turbulence: 0.15,
    breath: 0,
  },
}
