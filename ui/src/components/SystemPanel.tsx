// Секция «СИСТЕМА»: компактные показатели — ЦП и ОЗУ с тонкой полосой, сеть, время работы ядра, модель
// и расход на API.
// Пока метрик нет (null) — тихие прочерки вместо чисел.

import { formatMemory, formatPercent, formatRate, formatUptime } from '../format'
import { useSwyvorn } from '../store'
import { Section } from './Section'
import { UsageRow } from './UsageRow'
import './SystemPanel.css'

const DASH = '—'

function Meter({ label, value, sub }: { label: string; value: number | null; sub?: string }) {
  const fraction = value === null ? 0 : Math.min(1, Math.max(0, value / 100))
  const text = value === null ? DASH : `${formatPercent(value)} %`
  return (
    <div
      className="meter"
      role="meter"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={value === null ? undefined : Math.round(fraction * 100)}
      aria-valuetext={value === null ? 'нет данных' : sub ? `${text}, ${sub}` : text}
    >
      <div className="kv">
        <span className="kv__key">{label}</span>
        {sub && <span className="kv__sub mono">{sub}</span>}
        <span className="kv__val mono">{text}</span>
      </div>
      <div className="meter__track" aria-hidden="true">
        <div className="meter__fill" style={{ transform: `scaleX(${fraction})` }} />
      </div>
    </div>
  )
}

export function SystemPanel() {
  const metrics = useSwyvorn((s) => s.metrics)
  const model = useSwyvorn((s) => s.info?.model ?? null)

  return (
    <Section title="Система" className="sys">
      <div className="sys__body">
        <Meter label="ЦП" value={metrics?.cpu_percent ?? null} />
        <Meter
          label="ОЗУ"
          value={metrics?.ram_percent ?? null}
          sub={metrics ? formatMemory(metrics.ram_used_mb, metrics.ram_total_mb) : undefined}
        />

        <div className="kv">
          <span className="kv__key">Сеть</span>
          {metrics ? (
            <span className="kv__val kv__net mono">
              <span className="kv__rate" title="Отдача">
                <span className="kv__arrow" aria-hidden="true">
                  ↑
                </span>
                <span className="visually-hidden">отдача</span>
                {formatRate(metrics.net_up_bps)}
              </span>
              <span className="kv__rate" title="Приём">
                <span className="kv__arrow" aria-hidden="true">
                  ↓
                </span>
                <span className="visually-hidden">приём</span>
                {formatRate(metrics.net_down_bps)}
              </span>
            </span>
          ) : (
            <span className="kv__val mono">{DASH}</span>
          )}
        </div>

        <div className="kv">
          <span className="kv__key">Ядро работает</span>
          <span className="kv__val mono">{metrics ? formatUptime(metrics.uptime_s) : DASH}</span>
        </div>

        {model && (
          <div className="kv">
            <span className="kv__key">Модель</span>
            <span className="kv__val kv__model mono" title={model}>
              {model}
            </span>
          </div>
        )}

        <UsageRow />
      </div>
    </Section>
  )
}
