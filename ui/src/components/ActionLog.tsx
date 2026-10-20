// Панель «ЖУРНАЛ ДЕЙСТВИЙ»: новые записи сверху, цветная полоса — уровень риска.

import { memo, useMemo } from 'react'
import { formatDuration, formatTimeLong } from '../format'
import { ACTION_DECISION_LABELS, ACTION_STATUS_LABELS, RISK_LABELS } from '../labels'
import type { ActionEntry, ActionStatus } from '../protocol'
import { useSwyvorn } from '../store'
import { Icon, type IconName } from './Icon'
import { Panel } from './Panel'
import './ActionLog.css'

const STATUS_ICONS: Record<ActionStatus, IconName> = {
  pending: 'pending',
  awaiting_confirmation: 'hourglass',
  running: 'spinner',
  ok: 'check',
  error: 'error',
  denied: 'ban',
  cancelled: 'minusCircle',
  timeout: 'clock',
  forbidden: 'shield',
  stopped: 'square',
}

const ActionItem = memo(function ActionItem({ entry }: { entry: ActionEntry }) {
  const decision = entry.decision ? ACTION_DECISION_LABELS[entry.decision] : null
  // «Отклонено» и «запрещено» дублируют статус — второй раз не пишем.
  const showDecision = decision !== null && decision !== ACTION_STATUS_LABELS[entry.status]
  return (
    <li className={`act act--${entry.risk}`}>
      <span className="act__bar" role="img" title={RISK_LABELS[entry.risk]} aria-label={RISK_LABELS[entry.risk]} />
      <div className="act__body">
        <div className="act__kicker">
          <code className="act__tool" title="Инструмент">
            {entry.tool}
          </code>
          {entry.demo && <span className="tag-demo">ДЕМО</span>}
          <time className="act__time mono" dateTime={new Date(entry.created_at).toISOString()}>
            {formatTimeLong(entry.created_at)}
          </time>
        </div>
        <div className="act__title">{entry.title}</div>
        <div className="act__meta">
          <span className={`act__status act__status--${entry.status}`}>
            <Icon name={STATUS_ICONS[entry.status]} className={entry.status === 'running' ? 'spin' : undefined} />
            {ACTION_STATUS_LABELS[entry.status]}
          </span>
          {showDecision && <span className="act__decision">{decision}</span>}
          {entry.duration_ms != null && <span className="act__duration mono">{formatDuration(entry.duration_ms)}</span>}
        </div>
        {entry.detail && <p className="act__detail">{entry.detail}</p>}
      </div>
    </li>
  )
})

export function ActionLog() {
  const actions = useSwyvorn((s) => s.actions)
  const newestFirst = useMemo(() => actions.slice().reverse(), [actions])

  return (
    <Panel index="02" title="ЖУРНАЛ ДЕЙСТВИЙ" aside={actions.length > 0 ? String(actions.length).padStart(2, '0') : '—'} className="actlog">
      {newestFirst.length === 0 ? (
        <div className="actlog__empty">
          <Icon name="list" className="actlog__empty-icon" />
          Действий пока не было
        </div>
      ) : (
        <ol className="actlog__list" aria-label="Журнал действий">
          {newestFirst.map((entry) => (
            <ActionItem key={entry.id} entry={entry} />
          ))}
        </ol>
      )}
    </Panel>
  )
}
