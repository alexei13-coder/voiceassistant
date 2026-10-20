// Цвета ядра из дизайн-токенов (tokens.css). Читаются один раз: переменные темы не меняются на лету,
// а getComputedStyle в каждом кадре стоил бы пересчёта стилей.

import type { AssistantState } from '../protocol'

/** Цвет sRGB, компоненты 0..1. */
export type Rgb = readonly [number, number, number]

export interface OrbTheme {
  states: Record<AssistantState, Rgb>
}

// Запасные значения совпадают с tokens.css: ядро выглядит так же, даже если переменные не прочитались.
const STATE_VARS: Record<AssistantState, readonly [cssVar: string, fallback: string]> = {
  idle: ['--state-idle', '#5fd4e6'],
  listening: ['--state-listening', '#3ee0f0'],
  thinking: ['--state-thinking', '#7aa7ff'],
  speaking: ['--state-speaking', '#a8f0f7'],
  awaiting_confirmation: ['--state-awaiting', '#f5b14c'],
  executing: ['--state-executing', '#4fe3a1'],
  error: ['--state-error', '#ff5a67'],
  stopped: ['--state-stopped', '#6b7682'],
}

/** Разбирает #rgb, #rrggbb и rgb()/rgba() (через запятые или пробелы). Остальное — null. */
export function parseCssColor(value: string): Rgb | null {
  const v = value.trim().toLowerCase()
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/.exec(v)
  if (hex) {
    const h = hex[1]
    const full = h.length === 3 ? [...h].map((c) => c + c).join('') : h
    const [r, g, b] = [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16) / 255)
    return [r, g, b]
  }
  const fn = /^rgba?\(([^)]*)\)$/.exec(v)
  if (fn) {
    const parts = fn[1].split(/[\s,/]+/).filter(Boolean).slice(0, 3)
    if (parts.length < 3) return null
    const rgb = parts.map((p) => (p.endsWith('%') ? (parseFloat(p) / 100) * 255 : parseFloat(p)))
    if (rgb.some((c) => !Number.isFinite(c))) return null
    const [r, g, b] = rgb.map((c) => Math.min(1, Math.max(0, c / 255)))
    return [r, g, b]
  }
  return null
}

function readTheme(): OrbTheme {
  const style = typeof document === 'undefined' ? null : getComputedStyle(document.documentElement)
  const states = {} as Record<AssistantState, Rgb>
  for (const state of Object.keys(STATE_VARS) as AssistantState[]) {
    const [cssVar, fallback] = STATE_VARS[state]
    states[state] = parseCssColor(style?.getPropertyValue(cssVar) ?? '') ?? (parseCssColor(fallback) as Rgb)
  }
  return { states }
}

let cached: OrbTheme | null = null

export function getOrbTheme(): OrbTheme {
  cached ??= readTheme()
  return cached
}
