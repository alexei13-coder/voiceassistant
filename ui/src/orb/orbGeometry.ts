// Геометрия ядра в долях R — общая для WebGL- и Canvas-отрисовки, чтобы обе выглядели одинаково.
// Шейдер получает эти числа как константы GLSL (см. glslConstants), второго источника правды нет.
// Минималистичная композиция: плазма → одно тонкое кольцо (на нём же дуги «думаю», отсчёт и прогресс)
// → редкие радиальные столбики уровня звука.

/** Половина стороны квадрата холста в долях R. Всё, что дальше ~0,6R, мягко гасится к краю. */
export const HALF_SIDE_IN_R = 0.72

export const CORE_RADIUS = 0.2

/** Единственное кольцо вокруг плазмы. */
export const RING_RADIUS = 0.33

/** Длина дуг на кольце (рад): основная и вторая, напротив неё («думаю»). */
export const ARC_LENGTH = 0.95
export const ARC_PAIR_LENGTH = 0.5

export const BAR_INNER = 0.39
export const BAR_OUTER = 0.5
export const BAR_COUNT = 60
/** Длина столбика в покое, от звука и от синтетической «волны» (в долях R). */
export const BAR_BASE = 0.008
export const BAR_AUDIO_SPAN = 0.085
export const BAR_WAVE_SPAN = 0.03

/** Одна волна «говорю» расходится от края плазмы до этого радиуса и гаснет. */
export const RIPPLE_END = 0.58

/** Масштаб конструкции в полном «сжатии» после «Стоп». */
export const COLLAPSED_SCALE = 0.6

const TAU = Math.PI * 2

/** Хэш 0..1 без синуса — тот же, что hash11 в шейдере (Dave Hoskins). */
function hash11(value: number): number {
  let p = fract(value * 0.1031)
  p *= p + 33.33
  p *= p + p
  return fract(p)
}

function fract(x: number): number {
  return x - Math.floor(x)
}

/**
 * Относительная длина столбика i (0..1) для звука и для «волны».
 * Повторяет формулу шейдера: фазы целочисленно кратны, поэтому анимация бесшовна по кругу и во времени.
 */
export function barShape(index: number, phase: readonly number[]): { audio: number; wave: number } {
  const phi = (index / BAR_COUNT) * TAU
  const h = hash11(index * 1.37 + 0.5)
  const wave = (0.5 + 0.5 * Math.sin(3 * phi + phase[0])) * (0.5 + 0.5 * Math.sin(5 * phi - phase[1] + 1.3))
  const jitter = 0.5 + 0.5 * Math.sin((1 + Math.floor(h * 3)) * phase[2] + h * TAU)
  return { audio: 0.15 + 0.85 * (wave * 0.4 + jitter * 0.6) ** 1.4, wave }
}

/**
 * Яркость точки дуги-«кометы» по её длине: t = 0 — кончик хвоста, 1 — голова.
 * Хвост растворяется плавно, поэтому у дуги нет резкого обрыва; голова — полная яркость.
 */
export function cometFade(t: number): number {
  const x = Math.min(1, Math.max(0, t))
  return x * (2 - x)
}

function glslFloat(value: number): string {
  return Number.isInteger(value) ? `${value}.0` : String(value)
}

/** Константы геометрии для вставки в шейдер. */
export function glslConstants(): string {
  const scalars: Record<string, number> = {
    RING_R: RING_RADIUS,
    BAR_IN: BAR_INNER,
    BAR_OUT: BAR_OUTER,
    BAR_N: BAR_COUNT,
    BAR_AUDIO: BAR_AUDIO_SPAN,
    BAR_WAVE: BAR_WAVE_SPAN,
    RIPPLE_END,
    HALF_SIDE: HALF_SIDE_IN_R,
    COLLAPSED: COLLAPSED_SCALE,
  }
  return Object.entries(scalars)
    .map(([k, v]) => `const float ${k} = ${glslFloat(v)};`)
    .join('\n')
}
