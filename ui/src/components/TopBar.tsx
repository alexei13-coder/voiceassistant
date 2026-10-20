// Верхняя панель: знак, текущее состояние, статусы и (в Tauri) кнопки окна.
// Фон панели — область перетаскивания окна (data-tauri-drag-region).

import { CONNECTION_LABELS, STATE_COLOR_VARS } from '../labels'
import { isTauri, windowControls } from '../platform/tauri'
import { STATE_LABELS } from '../protocol'
import { useJarvis } from '../store'
import { TopClock } from './Clock'
import { cssVars } from './cssVars'
import { BrandMark, Icon } from './Icon'
import './TopBar.css'

function StateIndicator() {
  const state = useJarvis((s) => s.state)
  return (
    <div className="topbar__state" data-tauri-drag-region style={cssVars({ '--state-color': STATE_COLOR_VARS[state] })}>
      <span className="state-dot" aria-hidden="true" />
      <span className="topbar__state-label" aria-live="polite">
        {STATE_LABELS[state]}
      </span>
    </div>
  )
}

function CoreIndicator() {
  const connection = useJarvis((s) => s.connection)
  return (
    <span className={`chip chip--link chip--${connection}`} title={`Связь с ядром: ${CONNECTION_LABELS[connection]}`}>
      <span className="chip__dot" aria-hidden="true" />
      <span className="chip__text">{CONNECTION_LABELS[connection]}</span>
      <span className="chip__short" aria-hidden="true">
        ЯДРО
      </span>
    </span>
  )
}

function MicIndicator() {
  const muted = useJarvis((s) => s.muted)
  return (
    <span className={muted ? 'chip chip--mic chip--muted' : 'chip chip--mic'} title={muted ? 'Микрофон выключен' : 'Микрофон включён'}>
      <Icon name={muted ? 'micOff' : 'mic'} />
      <span className="chip__text">{muted ? 'МИК: ВЫКЛ' : 'МИК: ВКЛ'}</span>
    </span>
  )
}

function WindowButtons() {
  return (
    <div className="winbtns">
      <button type="button" className="winbtn" onClick={() => void windowControls.minimize()} aria-label="Свернуть">
        <Icon name="minimize" />
      </button>
      <button type="button" className="winbtn" onClick={() => void windowControls.toggleMaximize()} aria-label="Развернуть">
        <Icon name="maximize" />
      </button>
      <button
        type="button"
        className="winbtn winbtn--close"
        onClick={() => void windowControls.hideToTray()}
        aria-label="Спрятать в трей"
        title="Спрятать в трей — ассистент продолжит работать"
      >
        <Icon name="close" />
      </button>
    </div>
  )
}

export function TopBar() {
  const demo = useJarvis((s) => s.info?.demo ?? false)
  const model = useJarvis((s) => s.info?.model ?? null)
  const inTauri = isTauri()

  return (
    <header className={inTauri ? 'topbar topbar--tauri' : 'topbar'} data-tauri-drag-region>
      <div className="topbar__brand" data-tauri-drag-region>
        <BrandMark className="topbar__mark" />
        <span className="topbar__wordmark">ДЖАРВИС</span>
      </div>

      <StateIndicator />

      <div className="topbar__status" data-tauri-drag-region>
        {demo && <span className="chip chip--demo">ДЕМО</span>}
        {model && (
          <span className="chip chip--model" title={`Модель: ${model}`}>
            {model}
          </span>
        )}
        <CoreIndicator />
        <MicIndicator />
        <TopClock />
        {inTauri && <WindowButtons />}
      </div>
    </header>
  )
}
