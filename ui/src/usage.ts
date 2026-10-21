// Расход на API для секции «СИСТЕМА»: подсказка с токенами и цвет полосы месячного лимита.

import { formatCount, formatUsd, formatUsdLimit } from './format'
import type { UsageTotals } from './protocol'
import type { UsageState } from './store'

/** Тон полосы лимита: спокойный, жёлтый после 80 %, красный — лимит исчерпан. */
export type LimitTone = 'ok' | 'warn' | 'over'

const WARN_FROM = 0.8

/** Доля месячного лимита 0..1; null — лимита нет. */
export function limitFraction(usage: UsageState): number | null {
  if (!(usage.monthlyLimitUsd > 0)) return null
  const fraction = usage.month.cost_usd / usage.monthlyLimitUsd
  return Number.isFinite(fraction) ? Math.min(1, Math.max(0, fraction)) : 0
}

export function limitTone(fraction: number): LimitTone {
  if (fraction >= 1) return 'over'
  return fraction > WARN_FROM ? 'warn' : 'ok'
}

function totalsLines(t: UsageTotals): string[] {
  return [
    `токены: входные ${formatCount(t.input_tokens)} · выходные ${formatCount(t.output_tokens)}`,
    `кэш: чтение ${formatCount(t.cache_read_tokens)} · запись ${formatCount(t.cache_write_tokens)}`,
    `поиск в интернете: ${formatCount(t.web_searches)}`,
  ]
}

/** Многострочная подсказка: сессия и месяц по видам токенов. */
export function usageTooltip(usage: UsageState): string {
  const limit = usage.monthlyLimitUsd > 0 ? ` из ${formatUsdLimit(usage.monthlyLimitUsd)}` : ''
  return [
    `Сессия — ${formatUsd(usage.session.cost_usd)}`,
    ...totalsLines(usage.session),
    '',
    `Месяц — ${formatUsd(usage.month.cost_usd)}${limit}`,
    ...totalsLines(usage.month),
    '',
    'Оценка по прейскуранту; точные суммы — в console.anthropic.com',
  ].join('\n')
}
