// Дуговая шкала 270° с делениями. value = null — показатель ещё не пришёл.

import { formatPercent } from '../format'
import { gaugeDash, gaugeTone } from './chart'

const RADIUS = 40
const TICKS = Array.from({ length: 11 }, (_, i) => {
  // Деления от 135° до 405° (по часовой, 0° — направо).
  const angle = ((135 + i * 27) * Math.PI) / 180
  const r1 = RADIUS + 5
  const r2 = RADIUS + (i % 5 === 0 ? 9 : 7)
  return {
    x1: 50 + r1 * Math.cos(angle),
    y1: 50 + r1 * Math.sin(angle),
    x2: 50 + r2 * Math.cos(angle),
    y2: 50 + r2 * Math.sin(angle),
    major: i % 5 === 0,
  }
})

interface GaugeProps {
  label: string
  /** 0..100 или null */
  value: number | null
  caption: string
}

export function Gauge({ label, value, caption }: GaugeProps) {
  const dash = gaugeDash((value ?? 0) / 100, RADIUS)
  const tone = value === null ? 'empty' : gaugeTone(value)
  return (
    <figure className={`gauge gauge--${tone}`} aria-label={`${label}: ${value === null ? 'нет данных' : `${formatPercent(value)} %`}`}>
      <svg className="gauge__svg" viewBox="0 0 100 100" aria-hidden="true">
        {TICKS.map((t, i) => (
          <line key={i} className={t.major ? 'gauge__tick gauge__tick--major' : 'gauge__tick'} x1={t.x1} y1={t.y1} x2={t.x2} y2={t.y2} />
        ))}
        <circle className="gauge__track" cx="50" cy="50" r={RADIUS} strokeDasharray={dash.track} transform="rotate(135 50 50)" />
        {value !== null && (
          <circle className="gauge__value" cx="50" cy="50" r={RADIUS} strokeDasharray={dash.value} transform="rotate(135 50 50)" />
        )}
      </svg>
      <div className="gauge__readout">
        <span className="gauge__figure">
          <span className="gauge__number mono">{value === null ? '—' : formatPercent(value)}</span>
          {value !== null && <span className="gauge__unit">%</span>}
        </span>
      </div>
      <figcaption className="gauge__label">
        <span className="gauge__name">{label}</span>
        <span className="gauge__caption mono">{caption}</span>
      </figcaption>
    </figure>
  )
}
