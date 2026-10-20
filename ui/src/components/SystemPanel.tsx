// Панель «СИСТЕМА»: ЦП и ОЗУ, сеть с графиком, время работы ядра и крупные часы.

import { formatMemory, formatRate, formatUptime } from '../format'
import { useSwyvorn } from '../store'
import { BigClock } from './Clock'
import { Gauge } from './Gauge'
import { Panel } from './Panel'
import { Sparkline } from './Sparkline'
import './SystemPanel.css'

function NetRow({ arrow, label, bps, kind }: { arrow: string; label: string; bps: number | null; kind: 'up' | 'down' }) {
  return (
    <div className={`net__row net__row--${kind}`}>
      <span className="net__arrow" aria-hidden="true">
        {arrow}
      </span>
      <span className="net__label">{label}</span>
      <span className="net__value mono">{bps === null ? '—' : formatRate(bps)}</span>
    </div>
  )
}

export function SystemPanel() {
  const metrics = useSwyvorn((s) => s.metrics)
  const netHistory = useSwyvorn((s) => s.netHistory)
  const live = metrics !== null

  return (
    <Panel
      index="03"
      title="СИСТЕМА"
      className="sys"
      aside={
        <span className={live ? 'sys__live sys__live--on' : 'sys__live'}>
          <span className="sys__live-dot" aria-hidden="true" />
          {live ? '1 Гц' : 'НЕТ ДАННЫХ'}
        </span>
      }
    >
      <div className="sys__body">
        <div className="sys__gauges">
          <Gauge
            label="ЦП"
            value={metrics?.cpu_percent ?? null}
            caption={live ? 'загрузка' : '—'}
          />
          <Gauge
            label="ОЗУ"
            value={metrics?.ram_percent ?? null}
            caption={metrics ? formatMemory(metrics.ram_used_mb, metrics.ram_total_mb) : '—'}
          />
        </div>

        <div className="net">
          <div className="net__rates">
            <NetRow arrow="↑" label="Отдача" bps={metrics?.net_up_bps ?? null} kind="up" />
            <NetRow arrow="↓" label="Приём" bps={metrics?.net_down_bps ?? null} kind="down" />
          </div>
          <Sparkline history={netHistory} />
        </div>

        <div className="sys__row">
          <span className="sys__key">Ядро работает</span>
          <span className="sys__val mono">{metrics ? formatUptime(metrics.uptime_s) : '—'}</span>
        </div>

        <BigClock />
      </div>
    </Panel>
  )
}
