// Центр HUD: ядро (orb) как главный элемент, под ним слово состояния и одна строка подсказки.
// Когда нужно подтверждение, диалог встаёт под ядром, а само ядро уменьшается и остаётся видно.

import { Orb } from '../orb/Orb'
import { STATE_COLOR_VARS, STATE_WORDS, offlineHint, stateHint } from '../labels'
import { useSwyvorn } from '../store'
import { ConfirmDialog } from './ConfirmDialog'
import { cssVars } from './cssVars'
import { DemoControls } from './DemoControls'
import './CenterStage.css'

function StateCaption() {
  const state = useSwyvorn((s) => s.state)
  const reason = useSwyvorn((s) => s.stateReason)
  const activateHotkey = useSwyvorn((s) => s.info?.hotkeys.activate)
  const assistantName = useSwyvorn((s) => s.info?.assistantName)
  const buttonOnly = useSwyvorn((s) => s.confirmation?.button_only ?? false)
  const connection = useSwyvorn((s) => s.connection)
  const hint = offlineHint(connection) ?? stateHint(state, { reason, activateHotkey, assistantName, buttonOnly })

  return (
    // key: при смене состояния подпись мягко появляется заново.
    // Для экранного диктора смена состояния озвучивается постоянной областью в CenterStage.
    <div className={`stage__caption stage__caption--${state}`} key={state}>
      <div className="stage__state" aria-hidden="true">
        {STATE_WORDS[state]}
      </div>
      <div className="stage__hint">{hint}</div>
    </div>
  )
}

/** Постоянная live-область: элемент с key пересоздаётся, и диктор его не озвучил бы. */
function StateAnnouncer() {
  const state = useSwyvorn((s) => s.state)
  return (
    <span className="visually-hidden" aria-live="polite">
      Состояние: {STATE_WORDS[state]}
    </span>
  )
}

export function CenterStage() {
  const state = useSwyvorn((s) => s.state)
  const confirming = useSwyvorn((s) => s.confirmation !== null)

  return (
    <section
      className={confirming ? 'stage stage--confirming' : 'stage'}
      style={cssVars({ '--state-color': STATE_COLOR_VARS[state] })}
      aria-label="Состояние ассистента"
    >
      <StateAnnouncer />
      <div className="stage__orb">
        <div className="stage__orb-box">
          <Orb className="stage__orb-canvas" />
        </div>
      </div>
      {confirming ? <ConfirmDialog /> : <StateCaption />}
      <DemoControls />
    </section>
  )
}
