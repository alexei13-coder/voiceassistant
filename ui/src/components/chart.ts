// Геометрия маленьких SVG-графиков панели «СИСТЕМА».

/** Дуга шкалы — 270°, разрыв снизу. */
export const GAUGE_SWEEP = 0.75

function clamp01(v: number): number {
  return Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0
}

/** stroke-dasharray для дорожки и значения шкалы радиуса `radius`. */
export function gaugeDash(fraction: number, radius: number): { track: string; value: string } {
  const circumference = 2 * Math.PI * radius
  const sweep = circumference * GAUGE_SWEEP
  const value = sweep * clamp01(fraction)
  return {
    track: `${sweep.toFixed(2)} ${circumference.toFixed(2)}`,
    value: `${value.toFixed(2)} ${circumference.toFixed(2)}`,
  }
}

export type GaugeTone = 'normal' | 'warn' | 'critical'

export function gaugeTone(percent: number): GaugeTone {
  if (percent >= 90) return 'critical'
  if (percent >= 75) return 'warn'
  return 'normal'
}

/** Верх шкалы графика сети с запасом; не меньше `floor`, чтобы шум не выглядел пиком. */
export function chartMax(values: number[], floor: number): number {
  let max = floor
  for (const v of values) if (Number.isFinite(v) && v > max) max = v
  return max * 1.15
}

function points(values: number[], width: number, height: number, max: number): Array<[number, number]> {
  const step = values.length > 1 ? width / (values.length - 1) : 0
  return values.map((v, i) => {
    const y = height - (clamp01(v / max) * height)
    return [i * step, y]
  })
}

function fmt(n: number): string {
  return n.toFixed(1)
}

/** Линия графика. Пусто, если точек меньше двух. */
export function sparklineLine(values: number[], width: number, height: number, max: number): string {
  if (values.length < 2) return ''
  return points(values, width, height, max)
    .map(([x, y], i) => `${i === 0 ? 'M' : 'L'}${fmt(x)} ${fmt(y)}`)
    .join(' ')
}

/** Залитая область под линией (замкнута по нижнему краю). */
export function sparklineArea(values: number[], width: number, height: number, max: number): string {
  const line = sparklineLine(values, width, height, max)
  if (!line) return ''
  return `${line} L${fmt(width)} ${fmt(height)} L0 ${fmt(height)} Z`
}
