// Лаборатория ядра (только dev, /orb-lab.html): Orb в квадрате ~720 px и пульт для ручной проверки.
// Параметры URL для детерминированных скриншотов:
//   state=<состояние | awaiting>  level=0..1  countdown=0..1 (доля оставшегося времени)
//   static=1 (заморозить время) [t=секунды]  renderer=2d  panel=0|1  reduced=1  log=1 (статистика в консоль)

import '../styles/tokens.css'
import './lab.css'

import { StrictMode, useCallback, useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { pushLevel } from '../live'
import { type AssistantState, type ConfirmationRequest, STATE_LABELS } from '../protocol'
import { useSwyvorn } from '../store'
import { Orb, type OrbStats } from './Orb'

const STATES = Object.keys(STATE_LABELS) as AssistantState[]
const CONFIRM_TIMEOUT_MS = 15_000
/** Ядро само возвращается из «Стоп» в ожидание примерно через 0,8 с (docs/protocol.md §3). */
const STOP_TO_IDLE_MS = 800

function clamp01(x: number): number {
  return Math.min(1, Math.max(0, x))
}

function parseUnit(value: string | null): number | null {
  if (value === null || value.trim() === '') return null
  const n = Number(value)
  return Number.isFinite(n) ? clamp01(n) : null
}

function parseState(value: string | null): AssistantState | null {
  if (value === 'awaiting') return 'awaiting_confirmation'
  return STATES.find((s) => s === value) ?? null
}

const params = new URLSearchParams(window.location.search)
const isStatic = params.get('static') === '1'
const countdownParam = parseUnit(params.get('countdown'))
const CONFIG = {
  state: parseState(params.get('state')) ?? (countdownParam !== null ? 'awaiting_confirmation' : 'idle'),
  level: parseUnit(params.get('level')) ?? 0,
  countdown: countdownParam,
  frozenTime: isStatic ? Number(params.get('t') ?? '') || 6 : undefined,
  renderer: params.get('renderer') === '2d' ? ('canvas2d' as const) : ('webgl2' as const),
  panel: params.has('panel') ? params.get('panel') !== '0' : !isStatic,
  reduced: params.get('reduced') === '1',
  log: params.get('log') === '1',
}

function fakeConfirmation(expiresAt: number | null): ConfirmationRequest {
  return {
    action_id: 'orb-lab',
    nonce: 'orb-lab',
    title: 'Проверка ядра',
    spoken_text: 'Выполнить проверочное действие?',
    details: [],
    command: null,
    command_language: null,
    code_analysis: [],
    model_explanation: null,
    risk: 'confirm',
    button_only: false,
    timeout_ms: CONFIRM_TIMEOUT_MS,
    expires_at: expiresAt,
    demo: true,
  }
}

/** Смена состояния как от ядра; «жду подтверждения» без вопроса не бывает — подкладываем фиктивный. */
function setLabState(state: AssistantState): void {
  const { confirmation } = useSwyvorn.getState()
  useSwyvorn.setState({
    state,
    stateChangedAt: Date.now(),
    confirmation: state === 'awaiting_confirmation' ? (confirmation ?? fakeConfirmation(null)) : null,
  })
}

function startCountdown(): void {
  const s = useSwyvorn.getState()
  useSwyvorn.setState({
    state: 'awaiting_confirmation',
    stateChangedAt: s.state === 'awaiting_confirmation' ? s.stateChangedAt : Date.now(),
    confirmation: fakeConfirmation(Date.now() + CONFIRM_TIMEOUT_MS),
  })
}

let stopTimer = 0

function pressStop(): void {
  const now = Date.now()
  useSwyvorn.setState({
    lastStop: { at: now, source: 'button' },
    state: 'stopped',
    stateChangedAt: now,
    confirmation: null,
  })
  window.clearTimeout(stopTimer)
  stopTimer = window.setTimeout(() => {
    if (useSwyvorn.getState().state === 'stopped') setLabState('idle')
  }, STOP_TO_IDLE_MS)
}

function smoothstep(a: number, b: number, x: number): number {
  const t = clamp01((x - a) / (b - a))
  return t * t * (3 - 2 * t)
}

/** Похожий на речь уровень: слоги ~4 Гц внутри фраз, между фразами — паузы. */
function speechLevel(t: number): number {
  const phrase = 0.5 + 0.5 * Math.sin(t * 1.9 + Math.sin(t * 0.7) * 1.4)
  const voiced = smoothstep(0.25, 0.45, phrase)
  const syllable = Math.max(0, Math.sin(t * Math.PI * 2 * 4.2 + Math.sin(t * 3.1) * 1.8))
  const accent = 0.6 + 0.4 * Math.sin(t * 2.3 + 1)
  return clamp01(voiced * (0.12 + 0.8 * syllable ** 1.5 * accent))
}

// Начальные значения — до первого кадра, чтобы статичный скриншот сразу был в нужном состоянии.
useSwyvorn.setState({
  state: CONFIG.state,
  stateChangedAt: Date.now(),
  confirmation:
    CONFIG.countdown !== null
      ? fakeConfirmation(Date.now() + CONFIG.countdown * CONFIRM_TIMEOUT_MS)
      : CONFIG.state === 'awaiting_confirmation'
        ? fakeConfirmation(null)
        : null,
  reducedMotion: CONFIG.reduced,
})
pushLevel('mic', CONFIG.level)
pushLevel('tts', CONFIG.level)

/** Подача уровней с частотой ядра (~30 Гц): иначе live.ts через 150 мс сочтёт звук пропавшим. */
function useLevelFeed(mic: number, tts: number, auto: boolean): void {
  useEffect(() => {
    const started = performance.now()
    const push = () => {
      const t = (performance.now() - started) / 1000
      pushLevel('mic', auto ? speechLevel(t) : mic)
      pushLevel('tts', auto ? speechLevel(t + 0.37) : tts)
    }
    push()
    const id = window.setInterval(push, 33)
    return () => window.clearInterval(id)
  }, [mic, tts, auto])
}

function Slider({
  label,
  value,
  disabled,
  onChange,
}: {
  label: string
  value: number
  disabled: boolean
  onChange: (v: number) => void
}) {
  return (
    <label className="lab__field">
      <span className="lab__row">
        {label}
        <span className="lab__value">{value.toFixed(2)}</span>
      </span>
      <input
        type="range"
        min={0}
        max={1}
        step={0.01}
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(Number(e.target.value))}
      />
    </label>
  )
}

function StatsLine({ stats }: { stats: OrbStats | null }) {
  if (!stats) return <div className="lab__stats">FPS —</div>
  return (
    <div className="lab__stats">
      <div>
        FPS {stats.fps.toFixed(0)} · кадр {stats.frameMs.toFixed(2)} мс CPU
      </div>
      <div>
        {stats.renderer === 'webgl2' ? 'WebGL2' : 'Canvas 2D'} · {stats.width}×{stats.height}
      </div>
    </div>
  )
}

interface LevelControls {
  mic: number
  tts: number
  auto: boolean
  setMic: (v: number) => void
  setTts: (v: number) => void
  setAuto: (v: boolean) => void
}

function LabPanel({ stats, levels }: { stats: OrbStats | null; levels: LevelControls }) {
  const state = useSwyvorn((s) => s.state)
  const reducedMotion = useSwyvorn((s) => s.reducedMotion)
  const { mic, tts, auto, setMic, setTts, setAuto } = levels

  return (
    <aside className="lab__panel" aria-label="Пульт лаборатории">
      <h1 className="lab__title">ЛАБОРАТОРИЯ ЯДРА</h1>
      <label className="lab__field">
        Состояние
        <select value={state} onChange={(e) => setLabState(e.target.value as AssistantState)}>
          {STATES.map((s) => (
            <option key={s} value={s}>
              {STATE_LABELS[s]}
            </option>
          ))}
        </select>
      </label>
      <Slider label="Микрофон" value={mic} disabled={auto} onChange={setMic} />
      <Slider label="Синтез речи" value={tts} disabled={auto} onChange={setTts} />
      <label className="lab__check">
        <input type="checkbox" checked={auto} onChange={(e) => setAuto(e.target.checked)} />
        Авто-речь
      </label>
      <label className="lab__check">
        <input
          type="checkbox"
          checked={reducedMotion}
          onChange={(e) => useSwyvorn.getState().setReducedMotion(e.target.checked)}
        />
        Меньше движения
      </label>
      <div className="lab__buttons">
        <button type="button" onClick={startCountdown}>
          Отсчёт 15 с
        </button>
        <button type="button" onClick={() => setLabState(useSwyvorn.getState().state)}>
          Повторить вход
        </button>
        <button type="button" className="lab__stop" onClick={pressStop}>
          Стоп
        </button>
      </div>
      <StatsLine stats={stats} />
    </aside>
  )
}

function Lab() {
  const [stats, setStats] = useState<OrbStats | null>(null)
  // Уровни подаются и без пульта (panel=0), иначе статичный скриншот потерял бы звук.
  const [mic, setMic] = useState(CONFIG.level)
  const [tts, setTts] = useState(CONFIG.level)
  const [auto, setAuto] = useState(false)
  useLevelFeed(mic, tts, auto)
  const onStats = useCallback((s: OrbStats) => {
    setStats(s)
    if (CONFIG.log) {
      console.info(
        `[orb-lab] ${s.renderer} ${s.fps.toFixed(1)} fps, ${s.frameMs.toFixed(3)} ms CPU/кадр, ${s.width}x${s.height}`,
      )
    }
  }, [])

  return (
    <main className={CONFIG.panel ? 'lab' : 'lab lab--bare'}>
      <div className="lab__stage">
        <Orb
          className="lab__orb"
          lab={{ frozenTime: CONFIG.frozenTime, renderer: CONFIG.renderer, onStats }}
        />
      </div>
      {CONFIG.panel && <LabPanel stats={stats} levels={{ mic, tts, auto, setMic, setTts, setAuto }} />}
    </main>
  )
}

const root = document.getElementById('root')
if (!root) throw new Error('Нет элемента #root в orb-lab.html')

createRoot(root).render(
  <StrictMode>
    <Lab />
  </StrictMode>,
)
