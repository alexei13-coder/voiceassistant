// Пульт демо-режима: маленькая текстовая кнопка «демо ▾» и минимальное меню над ней —
// ручное переключение состояний и сценария (для проверки и скриншотов).

import { useState } from 'react'
import { sendCommand } from '../core/connection'
import { STATE_WORDS } from '../labels'
import type { AssistantState, ClientMessage } from '../protocol'
import { useSwyvorn } from '../store'
import { Icon } from './Icon'
import './DemoControls.css'

const STATES = Object.keys(STATE_WORDS) as AssistantState[]

type DemoMessage = Extract<ClientMessage, { type: 'demo' }>

const SCENARIO_BUTTONS: Array<{ label: string; msg: DemoMessage }> = [
  { label: 'подтверждение', msg: { type: 'demo', action: 'confirmation' } },
  { label: 'ошибка', msg: { type: 'demo', action: 'error_flash' } },
  { label: 'сценарий', msg: { type: 'demo', action: 'start' } },
  { label: 'пауза', msg: { type: 'demo', action: 'stop' } },
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
        <div className="demo__menu" id="demo-menu">
          <div className="demo__group">
            <span className="demo__label">Состояние</span>
            <div className="demo__grid">
              {STATES.map((s) => (
                <button
                  key={s}
                  type="button"
                  className="demo__item"
                  aria-pressed={s === current}
                  onClick={() => send({ type: 'demo', action: 'set_state', state: s })}
                >
                  {STATE_WORDS[s]}
                </button>
              ))}
            </div>
          </div>
          <div className="demo__group">
            <span className="demo__label">Сценарий</span>
            <div className="demo__grid">
              {SCENARIO_BUTTONS.map((b) => (
                <button key={b.label} type="button" className="demo__item" onClick={() => send(b.msg)}>
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
        aria-controls="demo-menu"
        aria-label="Пульт демо-режима"
        onClick={() => setOpen((v) => !v)}
      >
        демо
        <Icon name="chevronDown" className="demo__chevron" />
      </button>
    </div>
  )
}
