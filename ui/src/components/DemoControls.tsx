// Небольшой пульт демо-режима: ручное переключение состояний и сценария (для проверки и скриншотов).

import { useState } from 'react'
import { sendCommand } from '../core/connection'
import { STATE_LABELS, type AssistantState, type ClientMessage } from '../protocol'
import { useSwyvorn } from '../store'
import { Icon } from './Icon'
import './DemoControls.css'

const STATES = Object.keys(STATE_LABELS) as AssistantState[]

type DemoMessage = Extract<ClientMessage, { type: 'demo' }>

const SCENARIO_BUTTONS: Array<{ label: string; msg: DemoMessage }> = [
  { label: 'Подтверждение', msg: { type: 'demo', action: 'confirmation' } },
  { label: 'Ошибка', msg: { type: 'demo', action: 'error_flash' } },
  { label: 'Сценарий', msg: { type: 'demo', action: 'start' } },
  { label: 'Пауза', msg: { type: 'demo', action: 'stop' } },
]

function send(msg: DemoMessage): void {
  if (!sendCommand(msg)) useSwyvorn.getState().addNotice('warning', 'Нет связи с ядром', 'demo_not_sent')
}

export function DemoControls() {
  const demo = useSwyvorn((s) => s.info?.demo ?? false)
  const confirming = useSwyvorn((s) => s.confirmation !== null)
  const current = useSwyvorn((s) => s.state)
  const [open, setOpen] = useState(false)

  if (!demo || confirming) return null

  return (
    <div className={open ? 'demo demo--open' : 'demo'}>
      {open && (
        <div className="demo__panel" id="demo-panel">
          <div className="demo__group">
            <span className="demo__label">Состояние</span>
            <div className="demo__grid">
              {STATES.map((s) => (
                <button
                  key={s}
                  type="button"
                  className={s === current ? 'demo__btn demo__btn--active' : 'demo__btn'}
                  onClick={() => send({ type: 'demo', action: 'set_state', state: s })}
                >
                  {STATE_LABELS[s]}
                </button>
              ))}
            </div>
          </div>
          <div className="demo__group">
            <span className="demo__label">Сценарий</span>
            <div className="demo__grid demo__grid--wide">
              {SCENARIO_BUTTONS.map((b) => (
                <button key={b.label} type="button" className="demo__btn" onClick={() => send(b.msg)}>
                  {b.label}
                </button>
              ))}
            </div>
          </div>
        </div>
      )}
      <button
        type="button"
        className="demo__toggle"
        aria-expanded={open}
        aria-controls="demo-panel"
        onClick={() => setOpen((v) => !v)}
      >
        <Icon name="chevronRight" className="demo__chevron" />
        ДЕМО
      </button>
    </div>
  )
}
