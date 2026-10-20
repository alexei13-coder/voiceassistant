// Центр HUD: ядро (orb) во всю доступную площадь, подпись состояния и подсказка.
// Когда нужно подтверждение, диалог встаёт под ядром, а само ядро уменьшается и остаётся видно.

import { Orb } from '../orb/Orb'
import { STATE_COLOR_VARS, offlineHint, stateHint } from '../labels'
import { STATE_LABELS } from '../protocol'
import { useJarvis } from '../store'
import { ConfirmDialog } from './ConfirmDialog'
import { cssVars } from './cssVars'
import { DemoControls } from './DemoControls'
import './CenterStage.css'

function StateCaption() {
  const state = useJarvis((s) => s.state)
  const reason = useJarvis((s) => s.stateReason)
  const activateHotkey = useJarvis((s) => s.info?.hotkeys.activate)
  const assistantName = useJarvis((s) => s.info?.assistantName)
  const buttonOnly = useJarvis((s) => s.confirmation?.button_only ?? false)
  const connection = useJarvis((s) => s.connection)
  const hint = offlineHint(connection) ?? stateHint(state, { reason, activateHotkey, assistantName, buttonOnly })

  return (
    // key: при смене состояния подпись появляется заново с короткой анимацией.
    // Озвучивание смены состояния — через постоянную подпись в верхней панели.
    <div className="stage__caption" key={state}>
      <div className="stage__state">{STATE_LABELS[state]}</div>
      <div className="stage__hint">{hint}</div>
    </div>
  )
}

export function CenterStage() {
  const state = useJarvis((s) => s.state)
  const confirming = useJarvis((s) => s.confirmation !== null)

  return (
    <section
      className={confirming ? 'stage stage--confirming' : 'stage'}
      style={cssVars({ '--state-color': STATE_COLOR_VARS[state] })}
      aria-label="Состояние ассистента"
    >
      <div className="stage__orb">
        <div className="stage__orb-box">
          <Orb className="stage__orb-canvas" />
          <span className="stage__frame" aria-hidden="true" />
        </div>
      </div>
      {confirming ? <ConfirmDialog /> : <StateCaption />}
      <DemoControls />
    </section>
  )
}
