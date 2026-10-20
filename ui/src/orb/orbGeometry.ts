// Геометрия ядра в долях R — общая для WebGL- и Canvas-отрисовки, чтобы обе выглядели одинаково.
// Шейдер получает эти числа как константы GLSL (см. glslConstants), второго источника правды нет.

/** Половина стороны квадрата холста в долях R. Всё, что дальше ~0,68R, мягко гасится виньеткой. */
export const HALF_SIDE_IN_R = 0.8

export const CORE_RADIUS = 0.2

export const RING_RADIUS = 0.3
export const RING_TICKS = 72

export const ARC_RADIUS_A = 0.355
export const ARC_RADIUS_B = 0.374

/** Дуга: начало и длина (рад), шаг штриховки (рад, 0 — сплошная). */
export type ArcSpec = readonly [start: number, length: number, dash: number]

/** Толстые сегменты — вращаются в одну сторону… */
export const ARCS_A: readonly ArcSpec[] = [
  [0.15, 1.35, 0],
  [1.95, 0.55, 0],
  [3.05, 2.2, 0.075],
]

/** …тонкие — навстречу. */
export const ARCS_B: readonly ArcSpec[] = [
  [0.9, 0.95, 0],
  [4.0, 1.5, 0],
]

/** Доля шага штриховки, занятая штрихом. */
export const ARC_DASH_DUTY = 0.62

export const BAR_INNER = 0.425
export const BAR_OUTER = 0.5
export const BAR_COUNT = 80
/** Длина столбика от звука и от синтетической «волны» (в долях R). */
export const BAR_AUDIO_SPAN = 0.068
export const BAR_WAVE_SPAN = 0.036

export const COUNTDOWN_RADIUS = 0.53

export const DIAL_RADIUS = 0.58
export const DIAL_TICKS = 120
/** Номера делений лимба, с которых начинаются «глифы» — группы точек-меток. */
export const DIAL_GLYPHS: readonly number[] = [9, 41, 68, 101]
export const DIAL_GLYPH_LENGTH = 6

/** Шаг волн «говорю» (в долях R). */
export const RIPPLE_STEP = 0.11

/** Масштаб конструкции в полном «сжатии» после «Стоп». */
export const COLLAPSED_SCALE = 0.6

/** Зона развёртки и частиц «думаю». */
export const THINK_INNER = 0.215
export const THINK_OUTER = 0.575

export const PARTICLE_COUNT = 24

const TAU = Math.PI * 2

/** Хэш 0..1 без синуса — тот же, что hash11 в шейдере (Dave Hoskins). */
export function hash11(value: number): number {
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

function glslFloat(value: number): string {
  return Number.isInteger(value) ? `${value}.0` : String(value)
}

function glslArcs(name: string, arcs: readonly ArcSpec[]): string {
  const items = arcs.map((a) => `vec3(${a.map(glslFloat).join(', ')})`).join(', ')
  return `const vec3 ${name}[${arcs.length}] = vec3[${arcs.length}](${items});`
}

/** Константы геометрии для вставки в шейдер. */
export function glslConstants(): string {
  const scalars: Record<string, number> = {
    CORE_R: CORE_RADIUS,
    RING_R: RING_RADIUS,
    RING_TICKS,
    ARC_R_A: ARC_RADIUS_A,
    ARC_R_B: ARC_RADIUS_B,
    ARC_DUTY: ARC_DASH_DUTY,
    BAR_IN: BAR_INNER,
    BAR_OUT: BAR_OUTER,
    BAR_N: BAR_COUNT,
    BAR_AUDIO: BAR_AUDIO_SPAN,
    BAR_WAVE: BAR_WAVE_SPAN,
    COUNT_R: COUNTDOWN_RADIUS,
    DIAL_R: DIAL_RADIUS,
    DIAL_N: DIAL_TICKS,
    GLYPH_LEN: DIAL_GLYPH_LENGTH,
    THINK_IN: THINK_INNER,
    THINK_OUT: THINK_OUTER,
    HALF_SIDE: HALF_SIDE_IN_R,
    RIPPLE_STEP,
    COLLAPSED: COLLAPSED_SCALE,
  }
  const lines = Object.entries(scalars).map(([k, v]) => `const float ${k} = ${glslFloat(v)};`)
  lines.push(`#define PARTICLES ${PARTICLE_COUNT}`)
  lines.push(`#define ARCS_A_N ${ARCS_A.length}`)
  lines.push(`#define ARCS_B_N ${ARCS_B.length}`)
  lines.push(`#define GLYPHS_N ${DIAL_GLYPHS.length}`)
  lines.push(glslArcs('ARCS_A', ARCS_A))
  lines.push(glslArcs('ARCS_B', ARCS_B))
  lines.push(
    `const float GLYPHS[${DIAL_GLYPHS.length}] = float[${DIAL_GLYPHS.length}](${DIAL_GLYPHS.map(glslFloat).join(', ')});`,
  )
  return lines.join('\n')
}
