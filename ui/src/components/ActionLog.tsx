// Секция «ДЕЙСТВИЯ»: новые записи сверху. Компактная строка: точка статуса, название,
// одна строка подробностей и (если есть) пояснение.

import { memo, useMemo } from 'react'
import { formatDuration, formatTimeLong } from '../format'
import { ACTION_DECISION_LABELS, ACTION_STATUS_LABELS, RISK_LABELS } from '../labels'
import type { ActionEntry, ActionStatus } from '../protocol'
import { useSwyvorn } from '../store'
import { Section } from './Section'
import './ActionLog.css'

type Tone = 'ok' | 'progress' | 'fail' | 'neutral'

/** Цвет точки: зелёный — выполнено, янтарный — ждёт или идёт, красный — отказ, серый — прервано. */
const STATUS_TONES: Record<ActionStatus, Tone> = {
  pending: 'progress',
  awaiting_confirmation: 'progress',
  running: 'progress',
  ok: 'ok',
  error: 'fail',
  denied: 'fail',
  forbidden: 'fail',
  cancelled: 'neutral',
  timeout: 'neutral',
  stopped: 'neutral',
}

const ActionItem = memo(function ActionItem({ entry }: { entry: ActionEntry }) {
  const status = ACTION_STATUS_LABELS[entry.status]
  const decision = entry.decision ? ACTION_DECISION_LABELS[entry.decision] : null
  // «Отклонено» и «запрещено» дублируют статус — второй раз не пишем.
  const meta = [status]
  if (decision !== null && decision !== status) meta.push(decision)
  if (entry.duration_ms != null) meta.push(formatDuration(entry.duration_ms))
  if (entry.demo) meta.push('демо')

  return (
    <li
      className={`act act--${STATUS_TONES[entry.status]}`}
      title={`${entry.tool} · ${RISK_LABELS[entry.risk]} · ${formatTimeLong(entry.created_at)}`}
    >
      <span className="act__dot" aria-hidden="true" />
      <div className="act__body">
        <div className="act__title">{entry.title}</div>
        <div className="act__meta">{meta.join(' · ')}</div>
        {entry.detail && <p className="act__detail">{entry.detail}</p>}
      </div>
    </li>
  )
})

export function ActionLog() {
  const actions = useSwyvorn((s) => s.actions)
  const newestFirst = useMemo(() => actions.slice().reverse(), [actions])

  return (
    <Section title="Действия" className="actlog">
      {newestFirst.length === 0 ? (
        <p className="actlog__empty">Действий пока не было</p>
      ) : (
        <ol className="actlog__list fade-scroll" aria-label="Журнал действий">
          {newestFirst.map((entry) => (
            <ActionItem key={entry.id} entry={entry} />
          ))}
        </ol>
      )}
    </Section>
  )
}
