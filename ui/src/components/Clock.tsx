// Часы верхней панели: только ЧЧ:ММ, дата — во всплывающей подсказке.
// Перерисовываются сами по себе, не трогая остальной HUD.

import { formatFullDate, formatTimeShort } from '../format'
import { useNow } from '../hooks/useNow'

export function TopClock() {
  const now = useNow()
  const date = new Date(now)
  return (
    <time className="topclock mono" dateTime={date.toISOString()} title={formatFullDate(date)}>
      {formatTimeShort(now)}
    </time>
  )
}
