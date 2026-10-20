// «Характер» ядра в каждом состоянии: цели, к которым модель плавно подводит параметры кадра.
// Скорости — рад/с, остальное — безразмерные множители 0..1 (энергия может быть чуть выше 1).
// Минимализм: в покое видны только мягкая плазма и тонкое кольцо, остальное проявляется по делу.

import type { AssistantState } from '../protocol'

export interface StateLook {
  /** Подмешать к цвету состояния цвет другого состояния (доля 0..1). */
  tint: readonly [AssistantState, number] | null
  energy: number
  /** Яркость самого кольца; под активной дугой (отсчёт, прогресс, «думаю») его стоит приглушить. */
  ring: number
  /** Дуги на кольце: основная и вторая напротив неё, скорость их вращения. */
  arc: number
  arcPair: number
  arcSpeed: number
  /** Насколько уровень звука вытягивает столбики и раздувает плазму. */
  barGain: number
  /** Синтетическая бегущая волна по столбикам — «внутренняя работа» без звука. */
  barWave: number
  /** Видимость столбиков: в покое почти невидимы, ясно видны, когда есть звук. */
  bars: number
  /** Чей уровень слушать: микрофон (слушаю) или синтез речи (говорю). */
  mic: number
  tts: number
  /** «Догоняющая» дуга выполнения. */
  chase: number
  /** Волна от плазмы — «говорю». */
  ripple: number
  countdown: number
  collapse: number
  turbulence: number
  breath: number
}

const BASE: StateLook = {
  tint: null,
  energy: 1,
  ring: 0.55,
  arc: 0,
  arcPair: 0,
  arcSpeed: 0.3,
  barGain: 0,
  barWave: 0.03,
  bars: 0.18,
  mic: 0,
  tts: 0,
  chase: 0,
  ripple: 0,
  countdown: 0,
  collapse: 0,
  turbulence: 0.4,
  breath: 0.4,
}

export const STATE_LOOKS: Record<AssistantState, StateLook> = {
  idle: { ...BASE, energy: 0.85, arc: 0.35, arcSpeed: 0.14, barWave: 0, bars: 0.12, turbulence: 0.3, breath: 1 },
  listening: { ...BASE, ring: 0.7, arcSpeed: 0.3, barGain: 1, bars: 1, mic: 1, turbulence: 0.5 },
  thinking: {
    ...BASE,
    ring: 0.3,
    arc: 1,
    arcPair: 0.7,
    arcSpeed: 1.7,
    barWave: 0.5,
    bars: 0.15,
    turbulence: 0.8,
    breath: 1,
  },
  speaking: {
    ...BASE,
    energy: 1.05,
    ring: 0.65,
    arcSpeed: 0.3,
    barGain: 1,
    bars: 1,
    tts: 1,
    ripple: 1,
    turbulence: 0.6,
    breath: 0.3,
  },
  awaiting_confirmation: {
    ...BASE,
    energy: 0.9,
    ring: 0.22,
    arcSpeed: 0.1,
    barWave: 0,
    bars: 0.1,
    countdown: 1,
    turbulence: 0.3,
    breath: 0.8,
  },
  executing: {
    ...BASE,
    tint: ['listening', 0.15],
    energy: 1.1,
    ring: 0.25,
    arcSpeed: 0.6,
    barWave: 0.3,
    bars: 0.15,
    chase: 1,
    turbulence: 0.7,
    breath: 0.3,
  },
  error: { ...BASE, ring: 0.5, arcSpeed: 0.08, barWave: 0, bars: 0.12, turbulence: 0.7, breath: 0.5 },
  stopped: {
    ...BASE,
    energy: 0.6,
    ring: 0.45,
    arcSpeed: 0,
    barWave: 0,
    bars: 0.08,
    collapse: 1,
    turbulence: 0.12,
    breath: 0,
  },
}
