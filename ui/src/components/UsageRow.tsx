// «Расход» в секции «СИСТЕМА»: стоимость сессии и месяца, токены — во всплывающей подсказке.
// При месячном лимите под строкой — полоса 2 px: жёлтая после 80 %, красная на 100 %.

import { formatUsd, formatUsdLimit } from '../format'
import { useSwyvorn } from '../store'
import { limitFraction, limitTone, usageTooltip } from '../usage'

export function UsageRow() {
  const usage = useSwyvorn((s) => s.usage)
  if (!usage) return null
  const fraction = limitFraction(usage)
  const month = formatUsd(usage.month.cost_usd)

  return (
    <div className="usage" title={usageTooltip(usage)}>
      <div className="kv">
        <span className="kv__key">Расход</span>
        <span className="kv__val mono">
          {formatUsd(usage.session.cost_usd)}
          <span className="usage__month"> · месяц {month}</span>
        </span>
      </div>
      {fraction !== null && (
        <div
          className={`meter__track usage__track usage__track--${limitTone(fraction)}`}
          role="meter"
          aria-label="Месячный лимит расходов"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(fraction * 100)}
          aria-valuetext={`${month} из ${formatUsdLimit(usage.monthlyLimitUsd)}`}
        >
          <div className="meter__fill" style={{ transform: `scaleX(${fraction})` }} />
        </div>
      )}
    </div>
  )
}
