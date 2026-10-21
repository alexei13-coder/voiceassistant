// Верхняя панель: слева — знак SWYVORN, справа — тихий кластер статусов (Claude, связь с ядром,
// микрофон, часы) и (в Tauri) кнопки окна.
// Фон панели — область перетаскивания окна (data-tauri-drag-region).

import { BRAIN_LABELS, CONNECTION_LABELS, STATE_COLOR_VARS, STATE_WORDS, brainTooltip } from '../labels'
import { isTauri, windowControls } from '../platform/tauri'
import { useSwyvorn } from '../store'
import { TopClock } from './Clock'
import { cssVars } from './cssVars'
import { Icon } from './Icon'
import './TopBar.css'

function Brand() {
  const state = useSwyvorn((s) => s.state)
  return (
    <div className="topbar__brand" data-tauri-drag-region>
      <span
        className="state-dot"
        style={cssVars({ '--state-color': STATE_COLOR_VARS[state] })}
        title={`Состояние: ${STATE_WORDS[state]}`}
        aria-hidden="true"
      />
      <span className="topbar__wordmark" data-tauri-drag-region>
        SWYVORN
      </span>
    </div>
  )
}

/** Claude: готов, нет ключа, нет связи, лимит или демо. Без связи с ядром статус устарел — точка серая. */
function BrainIndicator() {
  const brain = useSwyvorn((s) => s.brain)
  const connected = useSwyvorn((s) => s.connection === 'connected')
  if (!brain) return null
  const tone = connected ? brain.status : 'stale'
  return (
    <span className={`topbar__item topbar__brain topbar__brain--${tone}`} title={brainTooltip(brain)}>
      <span className="topbar__dot" aria-hidden="true" />
      <span className="visually-hidden">Claude:</span>
      {BRAIN_LABELS[brain.status]}
    </span>
  )
}

function CoreIndicator() {
  const connection = useSwyvorn((s) => s.connection)
  const version = useSwyvorn((s) => s.info?.coreVersion ?? null)
  const label = CONNECTION_LABELS[connection]
  return (
    <span
      className={`topbar__item topbar__link topbar__link--${connection}`}
      title={`Связь с ядром: ${label}${version ? ` · версия ${version}` : ''}`}
    >
      <span className="topbar__dot" aria-hidden="true" />
      <span className="visually-hidden">Ядро:</span>
      {label}
    </span>
  )
}

function MicIndicator() {
  const muted = useSwyvorn((s) => s.muted)
  const listening = useSwyvorn((s) => s.state === 'listening')
  const label = muted ? 'Микрофон выключен' : listening ? 'Микрофон слушает' : 'Микрофон включён'
  const mod = muted ? ' topbar__mic--muted' : listening ? ' topbar__mic--live' : ''
  return (
    <span className={`topbar__item topbar__mic${mod}`} title={label} role="img" aria-label={label}>
      <Icon name={muted ? 'micOff' : 'mic'} />
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
  const inTauri = isTauri()

  return (
    <header className={inTauri ? 'topbar topbar--tauri' : 'topbar'} data-tauri-drag-region>
      <Brand />

      <div className="topbar__status" data-tauri-drag-region>
        <BrainIndicator />
        <CoreIndicator />
        <MicIndicator />
        <TopClock />
        {inTauri && <WindowButtons />}
      </div>
    </header>
  )
}
