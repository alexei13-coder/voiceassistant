// Часы перерисовываются раз в секунду сами по себе, не трогая остальной HUD.

import { formatClock, formatFullDate, formatShortDate } from '../format'
import { useNow } from '../hooks/useNow'

export function TopClock() {
  const date = new Date(useNow())
  return (
    <span className="topclock">
      <time className="topclock__time" dateTime={date.toISOString()}>
        {formatClock(date)}
      </time>
      <span className="topclock__date">{formatShortDate(date)}</span>
    </span>
  )
}

export function BigClock() {
  const date = new Date(useNow())
  return (
    <div className="bigclock">
      <time className="bigclock__time" dateTime={date.toISOString()}>
        {formatClock(date)}
      </time>
      <div className="bigclock__date">{formatFullDate(date)}</div>
    </div>
  )
}
