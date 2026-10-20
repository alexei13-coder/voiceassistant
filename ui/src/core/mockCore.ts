// Имитация ядра для разработки интерфейса без Python (?mock=1). Подключается только
// динамическим импортом под import.meta.env.DEV, поэтому в продакшен-сборку не попадает.
// Повторяет демо-сценарий docs/protocol.md §5 и отвечает на команды UI локально.

import {
  PROTOCOL_VERSION,
  STATE_LABELS,
  type ActionEntry,
  type AssistantState,
  type ChatMessage,
  type ClientMessage,
  type ConfirmationOutcome,
  type ConfirmationRequest,
  type Hotkeys,
  type ServerMessage,
} from '../protocol'
import { useJarvis } from '../store'
import { attachLocalCore } from './connection'

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never
type Outgoing = DistributiveOmit<ServerMessage, 'ts'>
type Emit = (msg: ServerMessage) => void

export interface MockOptions {
  /** Заморозить состояние (для скриншотов): сценарий не запускается. */
  freezeState: AssistantState | null
  /** Сразу показать диалог подтверждения. */
  confirm: boolean
}

const HOTKEYS: Hotkeys = {
  activate: 'Ctrl+Alt+J',
  stop: 'Ctrl+Alt+Escape',
  stop_fallback: 'Ctrl+Alt+Backspace',
  mute: 'Ctrl+Alt+M',
  repeat: 'Ctrl+Alt+R',
  screen: 'Ctrl+Alt+S',
}

const AUDIO_HZ = 30
const RAM_TOTAL_MB = 32_607
const START_UPTIME_S = 8_142
const STOPPED_HOLD_MS = 800
const COUNTDOWN_DELAY_MS = 1500

function isAssistantState(value: string | null): value is AssistantState {
  return value !== null && Object.hasOwn(STATE_LABELS, value)
}

export function parseMockOptions(search: string): MockOptions {
  const params = new URLSearchParams(search)
  const state = params.get('state')
  const confirm = params.get('confirm') === '1'
  const freezeState = isAssistantState(state) ? state : confirm ? 'awaiting_confirmation' : null
  return { freezeState, confirm }
}

function isoWithOffset(ms: number): string {
  const d = new Date(ms)
  const p = (n: number) => String(Math.abs(n)).padStart(2, '0')
  const offset = -d.getTimezoneOffset()
  const sign = offset >= 0 ? '+' : '-'
  return (
    `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:` +
    `${p(d.getSeconds())}${sign}${p(Math.trunc(offset / 60))}:${p(offset % 60)}`
  )
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v))
}

/** Прерываемая пауза: при отмене хода отклоняется, и сценарий выходит из цикла. */
function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason)
      return
    }
    const onAbort = () => {
      clearTimeout(timer)
      reject(signal.reason)
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

/** Уровень, похожий на речь: слоги ~4 Гц, фразы с короткими паузами. */
export function speechLevel(tSeconds: number, noise: number): number {
  const phrase = (tSeconds % 2.6) / 2.6
  if (phrase > 0.86) return clamp(noise * 0.05, 0, 1)
  const syllable = Math.abs(Math.sin(tSeconds * Math.PI * 4.2))
  const contour = 0.65 + 0.35 * Math.sin(tSeconds * Math.PI * 0.9)
  return clamp(0.08 + 0.72 * syllable * contour + 0.12 * (noise - 0.5), 0, 1)
}

function confirmationRequest(id: string, buttonOnly: boolean): ConfirmationRequest {
  return {
    action_id: id,
    nonce: `nonce-${id}-${Math.random().toString(36).slice(2, 10)}`,
    title: 'Переместить в корзину 3 файла',
    spoken_text: 'Нашёл 3 старых скриншота в «Загрузках». Переместить их в корзину?',
    details: [
      'C:\\Users\\Пользователь\\Downloads\\Снимок экрана 2026-08-02 101512.png — 1,2 МБ',
      'C:\\Users\\Пользователь\\Downloads\\Снимок экрана 2026-08-14 184033.png — 860 КБ',
      'C:\\Users\\Пользователь\\Downloads\\Снимок экрана 2026-09-01 090207.png — 2,4 МБ',
    ],
    command:
      "Get-ChildItem -LiteralPath \"$env:USERPROFILE\\Downloads\" -Filter 'Снимок экрана*.png' | " +
      'Where-Object { $_.LastWriteTime -lt (Get-Date).AddDays(-30) } | ' +
      "ForEach-Object { [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteFile($_.FullName, 'OnlyErrorDialogs', 'SendToRecycleBin') }",
    command_language: 'powershell',
    code_analysis: [
      'Затрагивает только 3 файла в папке «Загрузки»',
      'Файлы попадают в корзину — их можно восстановить',
      'Нет сетевых обращений и повышения прав',
    ],
    model_explanation: 'Команда находит скриншоты старше 30 дней и отправляет их в корзину.',
    risk: 'confirm',
    button_only: buttonOnly,
    timeout_ms: 15_000,
    expires_at: null,
    demo: true,
  }
}

interface PendingConfirmation {
  request: ConfirmationRequest
  resolve: (outcome: ConfirmationOutcome) => void
  timers: ReturnType<typeof setTimeout>[]
}

export class MockCore {
  private state: AssistantState
  private muted = false
  private seq = 0
  private disposed = false
  private scenarioEnabled: boolean
  private turn: AbortController | null = null
  private pending: PendingConfirmation | null = null
  private readonly runningActions = new Map<string, ActionEntry>()
  private readonly timers = new Set<ReturnType<typeof setTimeout>>()
  private readonly intervals: ReturnType<typeof setInterval>[] = []
  private readonly startedAt = Date.now()
  private cpu = 14
  private ramUsed = 13_900
  private readonly options: MockOptions
  private readonly emit: Emit

  constructor(emit: Emit, options: MockOptions) {
    this.emit = emit
    this.options = options
    this.state = options.freezeState ?? 'idle'
    this.scenarioEnabled = options.freezeState === null
  }

  start(): void {
    const now = Date.now()
    this.out({
      type: 'hello',
      protocol: PROTOCOL_VERSION,
      core_version: '0.1.0-mock',
      state: this.state,
      demo: true,
      assistant_name: 'Джарвис',
      address_form: 'сэр',
      model: 'claude-opus-5-5',
      hotkeys: HOTKEYS,
      ui: { reduced_motion: false },
      muted: false,
      history: this.seedHistory(now),
      actions: this.seedActions(now),
      confirmation: null,
    })
    // Минута истории сети, чтобы график не был пустым сразу после запуска.
    for (let i = 59; i >= 1; i -= 1) this.emitMetrics(now - i * 1000)
    this.intervals.push(setInterval(() => this.emitMetrics(Date.now()), 1000))
    this.intervals.push(setInterval(() => this.emitAudio(), 1000 / AUDIO_HZ))
    this.out({ type: 'notice', level: 'info', text: 'Имитация ядра в браузере: режим mock', code: 'mock' })

    if (this.options.confirm) this.runTurn((signal) => this.confirmationTurn(signal, true), false)
    else if (this.scenarioEnabled) this.startScenario()
  }

  dispose(): void {
    this.finishConfirmation('cancelled', null)
    this.abortTurn()
    this.disposed = true
    for (const t of this.timers) clearTimeout(t)
    this.timers.clear()
    for (const i of this.intervals) clearInterval(i)
  }

  /** Локальная обработка команды UI. Всегда «доставлено». */
  handle(msg: ClientMessage): boolean {
    if (this.disposed) return false
    switch (msg.type) {
      case 'auth':
        return true
      case 'ping':
        this.out({ type: 'pong' })
        return true
      case 'send_text':
        this.runTurn((signal) => this.textTurn(msg.text, signal), true)
        return true
      case 'confirm':
        this.handleConfirm(msg.action_id, msg.nonce, msg.decision)
        return true
      case 'stop':
        this.stopAll()
        return true
      case 'mute':
        this.muted = msg.muted
        this.out({ type: 'muted', muted: msg.muted })
        return true
      case 'mic':
        if (msg.action === 'ptt_up' || (msg.action === 'toggle' && this.state === 'listening')) {
          this.abortTurn()
          this.setState('idle')
        } else {
          this.runTurn((signal) => this.listenTurn(signal), true)
        }
        return true
      case 'demo':
        this.handleDemo(msg.action, msg.state)
        return true
    }
  }

  // ---------- команды ----------

  private handleDemo(action: Extract<ClientMessage, { type: 'demo' }>['action'], state?: AssistantState): void {
    switch (action) {
      case 'start':
        this.scenarioEnabled = true
        this.finishConfirmation('cancelled', null)
        this.startScenario()
        return
      case 'stop':
        this.scenarioEnabled = false
        this.finishConfirmation('cancelled', null)
        this.abortTurn()
        this.setState('idle')
        return
      case 'set_state':
        if (!state) return
        this.scenarioEnabled = false
        this.finishConfirmation('cancelled', null)
        this.abortTurn()
        this.setState(state)
        return
      case 'confirmation':
        this.scenarioEnabled = false
        this.runTurn((signal) => this.confirmationTurn(signal, false), false)
        return
      case 'error_flash':
        this.runTurn(async (signal) => {
          this.setState('error', 'Демо: так выглядит ошибка')
          this.out({ type: 'notice', level: 'error', text: 'Демо: имитация ошибки, ничего не сломалось', code: 'demo' })
          await sleep(1500, signal)
          this.setState('idle')
        }, true)
        return
    }
  }

  private handleConfirm(actionId: string, nonce: string, decision: 'yes' | 'no'): void {
    const p = this.pending
    if (!p || p.request.action_id !== actionId || p.request.nonce !== nonce) {
      this.out({ type: 'error', code: 'stale_confirmation', message: 'Подтверждение устарело' })
      return
    }
    this.finishConfirmation(decision === 'yes' ? 'confirmed' : 'denied', 'button')
  }

  private stopAll(): void {
    this.finishConfirmation('stopped', null)
    this.abortTurn()
    for (const entry of this.runningActions.values()) {
      this.upsertAction({ ...entry, status: 'stopped', decision: 'stopped', detail: 'Остановлено кнопкой «Стоп»' })
    }
    this.setState('stopped')
    this.out({ type: 'stopped', source: 'button' })
    this.later(STOPPED_HOLD_MS, () => {
      this.setState('idle')
      if (this.scenarioEnabled) this.startScenario()
    })
  }

  // ---------- ходы ----------

  /** Текущий ход отменяется новым; по завершении (если разрешено) сценарий продолжается. */
  private runTurn(body: (signal: AbortSignal) => Promise<void>, resumeScenario: boolean): void {
    // Новый ход (текст, микрофон, демо) закрывает висящий вопрос, как это сделает ядро.
    this.finishConfirmation('superseded', null)
    this.abortTurn()
    const ctl = new AbortController()
    this.turn = ctl
    body(ctl.signal)
      .catch((err: unknown) => {
        if (!ctl.signal.aborted) console.error('Ошибка имитации ядра', err)
      })
      .finally(() => {
        if (this.turn !== ctl) return
        this.turn = null
        if (resumeScenario && this.scenarioEnabled && !this.disposed) this.startScenario()
      })
  }

  private abortTurn(): void {
    const ctl = this.turn
    this.turn = null
    ctl?.abort()
  }

  private startScenario(): void {
    this.runTurn((signal) => this.scenario(signal), false)
  }

  private async scenario(signal: AbortSignal): Promise<void> {
    for (;;) {
      this.setState('idle')
      await sleep(4000, signal)
      this.setState('listening')
      await sleep(3000, signal)
      this.chat('user', 'Джарвис, какая сегодня погода?')
      this.setState('thinking')
      await sleep(2500, signal)
      this.setState('speaking')
      const weather = this.upsertAction({
        id: this.nextId('a'),
        created_at: Date.now(),
        tool: 'weather',
        title: 'Прогноз погоды: Москва',
        risk: 'safe',
        status: 'running',
        decision: 'auto',
        detail: null,
        duration_ms: null,
        demo: true,
      })
      await this.streamAssistant(
        'Сейчас в Москве +7 °C, облачно, ветер северо-западный 4 м/с. К вечеру обещают небольшой дождь — зонт пригодится, сэр.',
        5000,
        signal,
      )
      this.upsertAction({ ...weather, status: 'ok', detail: '+7 °C, облачно, к вечеру дождь', duration_ms: 640 })
      this.setState('idle')
      await sleep(4000, signal)
      this.setState('listening')
      await sleep(2500, signal)
      this.chat('user', 'Удали старые скриншоты из „Загрузок“')
      this.setState('thinking')
      await sleep(2000, signal)
      this.setState('speaking')
      await this.streamAssistant('Нашёл 3 файла старше 30 дней. Переместить их в корзину? Вы уверены, сэр?', 3500, signal)
      await this.confirmationTurn(signal, false)
      await sleep(3000, signal)
    }
  }

  private async confirmationTurn(signal: AbortSignal, buttonOnly: boolean): Promise<void> {
    const id = this.nextId('a')
    const request = confirmationRequest(id, buttonOnly)
    const entry = this.upsertAction({
      id,
      created_at: Date.now(),
      tool: 'files.trash',
      title: request.title,
      risk: 'confirm',
      status: 'awaiting_confirmation',
      decision: null,
      detail: null,
      duration_ms: null,
      demo: true,
    })
    const outcome = await this.askConfirmation(request)
    signal.throwIfAborted()
    if (outcome === 'confirmed') {
      this.upsertAction({ ...entry, status: 'running', decision: 'confirmed_button' })
      this.setState('executing')
      await sleep(1500, signal)
      this.upsertAction({
        ...entry,
        status: 'ok',
        decision: 'confirmed_button',
        detail: 'Демо: ничего не удалялось',
        duration_ms: 1500,
      })
      this.setState('speaking')
      await this.streamAssistant('Готово. Это была демонстрация — файлы на месте.', 2200, signal)
    } else {
      const status = outcome === 'denied' ? 'denied' : outcome === 'timeout' ? 'timeout' : 'cancelled'
      const decision = outcome === 'denied' ? 'denied' : outcome === 'timeout' ? 'timeout' : null
      const detail = outcome === 'timeout' ? 'Нет ответа за 15 с' : 'Отменено пользователем'
      this.upsertAction({ ...entry, status, decision, detail })
      this.setState('speaking')
      await this.streamAssistant('Отменено. Ничего не трогаю.', 1600, signal)
    }
    this.setState('idle')
  }

  private async textTurn(text: string, signal: AbortSignal): Promise<void> {
    this.chat('user', text.trim())
    this.setState('thinking')
    await sleep(1200, signal)
    this.setState('speaking')
    await this.streamAssistant(
      `Это демонстрационный режим: мозг подключим на этапе 2. Вы написали: „${text.trim()}“`,
      3000,
      signal,
    )
    this.setState('idle')
  }

  private async listenTurn(signal: AbortSignal): Promise<void> {
    this.setState('listening')
    await sleep(3000, signal)
    this.setState('idle')
  }

  private askConfirmation(request: ConfirmationRequest): Promise<ConfirmationOutcome> {
    this.setState('awaiting_confirmation')
    this.out({ type: 'confirmation_request', request })
    return new Promise((resolve) => {
      const pending: PendingConfirmation = { request, resolve, timers: [] }
      this.pending = pending
      // Отсчёт начинается, когда вопрос «договорён» — до этого expires_at = null.
      pending.timers.push(
        setTimeout(() => {
          const expiresAt = Date.now() + request.timeout_ms
          pending.request = { ...request, expires_at: expiresAt }
          this.out({ type: 'confirmation_countdown', action_id: request.action_id, expires_at: expiresAt })
          pending.timers.push(setTimeout(() => this.finishConfirmation('timeout', null), request.timeout_ms))
        }, COUNTDOWN_DELAY_MS),
      )
    })
  }

  private finishConfirmation(outcome: ConfirmationOutcome, via: 'button' | null): void {
    const p = this.pending
    if (!p) return
    this.pending = null
    for (const t of p.timers) clearTimeout(t)
    this.out({ type: 'confirmation_resolved', action_id: p.request.action_id, outcome, via })
    p.resolve(outcome)
  }

  // ---------- вывод ----------

  private out(msg: Outgoing): void {
    if (this.disposed) return
    this.emit({ ...msg, ts: Date.now() } as ServerMessage)
  }

  private setState(state: AssistantState, reason: string | null = null): void {
    if (state === this.state) return
    this.state = state
    this.out({ type: 'state', state, reason })
  }

  private nextId(prefix: string): string {
    this.seq += 1
    return `${prefix}-mock-${this.seq}`
  }

  private chat(role: ChatMessage['role'], text: string): void {
    this.out({
      type: 'chat_message',
      message: { id: this.nextId('m'), role, text, streaming: false, created_at: Date.now() },
    })
  }

  /** Потоковый ответ: слова идут равномерно за `durationMs`, сообщение всегда завершается. */
  private async streamAssistant(text: string, durationMs: number, signal: AbortSignal): Promise<void> {
    const id = this.nextId('m')
    const words = text.match(/\S+\s*/g) ?? [text]
    const step = clamp(durationMs / words.length, 40, 260)
    this.out({
      type: 'chat_message',
      message: { id, role: 'assistant', text: '', streaming: true, created_at: Date.now() },
    })
    try {
      for (const word of words) {
        this.out({ type: 'chat_delta', id, delta: word })
        await sleep(step, signal)
      }
    } finally {
      this.out({ type: 'chat_done', id })
    }
  }

  private upsertAction(entry: ActionEntry): ActionEntry {
    if (entry.status === 'running' || entry.status === 'awaiting_confirmation') this.runningActions.set(entry.id, entry)
    else this.runningActions.delete(entry.id)
    this.out({ type: 'action', entry })
    return entry
  }

  private emitMetrics(at: number): void {
    if (this.disposed) return
    const busy = this.state === 'thinking' || this.state === 'executing'
    this.cpu = clamp(this.cpu + (Math.random() - 0.5) * 9 + (busy ? 4 : -1), 4, busy ? 78 : 46)
    this.ramUsed = clamp(this.ramUsed + (Math.random() - 0.5) * 140, 12_800, 15_600)
    const burst = Math.random() < 0.12
    const down = (burst ? 900_000 + Math.random() * 1_800_000 : 20_000 + Math.random() * 90_000) * (busy ? 1.6 : 1)
    const up = burst ? 60_000 + Math.random() * 240_000 : 3_000 + Math.random() * 18_000
    this.emit({
      type: 'metrics',
      ts: at,
      cpu_percent: Math.round(this.cpu * 10) / 10,
      ram_percent: Math.round((this.ramUsed / RAM_TOTAL_MB) * 1000) / 10,
      ram_used_mb: Math.round(this.ramUsed),
      ram_total_mb: RAM_TOTAL_MB,
      net_up_bps: Math.round(up),
      net_down_bps: Math.round(down),
      uptime_s: START_UPTIME_S + Math.max(0, Math.round((at - this.startedAt) / 1000)),
      time_iso: isoWithOffset(at),
    })
  }

  private emitAudio(): void {
    const t = (Date.now() - this.startedAt) / 1000
    if (this.state === 'listening' && !this.muted) {
      this.out({ type: 'audio_level', source: 'mic', level: speechLevel(t, Math.random()) })
    } else if (this.state === 'speaking') {
      this.out({ type: 'audio_level', source: 'tts', level: speechLevel(t * 1.1 + 0.4, Math.random()) })
    }
  }

  private later(ms: number, fn: () => void): void {
    const timer = setTimeout(() => {
      this.timers.delete(timer)
      if (!this.disposed) fn()
    }, ms)
    this.timers.add(timer)
  }

  // ---------- стартовые данные ----------

  private seedHistory(now: number): ChatMessage[] {
    const min = 60_000
    const msg = (role: ChatMessage['role'], text: string, ago: number): ChatMessage => ({
      id: this.nextId('m'),
      role,
      text,
      streaming: false,
      created_at: now - ago,
    })
    return [
      msg('system', 'Демо-режим: голос и «мозг» подключим на следующих этапах. Реальные действия не выполняются.', 9 * min),
      msg('user', 'Какая сейчас загрузка процессора?', 8 * min),
      msg('assistant', 'Процессор загружен на 18 %, память — на 43 %. Всё в норме, сэр.', 8 * min - 4000),
      msg('user', 'Открой папку «Загрузки»', 5 * min),
      msg('assistant', 'Открываю «Загрузки».', 5 * min - 2500),
    ]
  }

  private seedActions(now: number): ActionEntry[] {
    const min = 60_000
    const entry = (e: Omit<ActionEntry, 'id' | 'demo'>): ActionEntry => ({ ...e, id: this.nextId('a'), demo: true })
    return [
      entry({
        created_at: now - 8 * min,
        tool: 'system.metrics',
        title: 'Показатели системы',
        risk: 'safe',
        status: 'ok',
        decision: 'auto',
        detail: 'ЦП 18 %, ОЗУ 43 %',
        duration_ms: 12,
      }),
      entry({
        created_at: now - 5 * min,
        tool: 'files.open',
        title: 'Открыть папку «Загрузки»',
        risk: 'safe',
        status: 'ok',
        decision: 'auto',
        detail: null,
        duration_ms: 230,
      }),
      entry({
        created_at: now - 3 * min,
        tool: 'shell.run',
        title: 'Очистить кэш DNS',
        risk: 'confirm',
        status: 'denied',
        decision: 'denied',
        detail: 'Отклонено пользователем',
        duration_ms: null,
      }),
      entry({
        created_at: now - 2 * min,
        tool: 'registry.write',
        title: 'Изменить автозапуск в реестре',
        risk: 'forbidden',
        status: 'forbidden',
        decision: 'forbidden',
        detail: 'Запись в реестр запрещена политикой безопасности',
        duration_ms: null,
      }),
    ]
  }
}

/** Точка входа для main.tsx: имитация пишет в store, команды UI идут в неё же. */
export function startMockCore(search: string): MockCore {
  const core = new MockCore((msg) => useJarvis.getState().applyServerMessage(msg), parseMockOptions(search))
  attachLocalCore((msg) => core.handle(msg))
  useJarvis.getState().setConnection('connected')
  core.start()
  return core
}
