// График сети за последнюю минуту: приём — залитая область, отдача — линия.

import { useId, useMemo } from 'react'
import type { NetSample } from '../store'
import { chartMax, sparklineArea, sparklineLine } from './chart'

const W = 120
const H = 36
/** Ниже 8 КБ/с масштаб не опускается — иначе фоновый шум выглядит как пик. */
const MIN_SCALE_BPS = 8 * 1024

export function Sparkline({ history }: { history: NetSample[] }) {
  const gradientId = useId()
  const paths = useMemo(() => {
    const down = history.map((s) => s.down)
    const up = history.map((s) => s.up)
    const max = chartMax([...down, ...up], MIN_SCALE_BPS)
    return {
      area: sparklineArea(down, W, H, max),
      down: sparklineLine(down, W, H, max),
      up: sparklineLine(up, W, H, max),
    }
  }, [history])

  return (
    <svg className="spark" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" aria-hidden="true">
      <defs>
        <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" style={{ stopColor: 'var(--cyan)', stopOpacity: 0.32 }} />
          <stop offset="1" style={{ stopColor: 'var(--cyan)', stopOpacity: 0 }} />
        </linearGradient>
      </defs>
      <line className="spark__grid" x1="0" y1={H / 2} x2={W} y2={H / 2} />
      {paths.down ? (
        <>
          <path d={paths.area} fill={`url(#${gradientId})`} />
          <path className="spark__down" d={paths.down} />
          <path className="spark__up" d={paths.up} />
        </>
      ) : (
        <line className="spark__empty" x1="0" y1={H - 1} x2={W} y2={H - 1} />
      )}
    </svg>
  )
}
