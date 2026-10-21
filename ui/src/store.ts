// Состояние UI для React. Единственное место, где сообщения ядра превращаются в состояние.
// Уровни звука сюда НЕ попадают — см. live.ts.

import { create } from 'zustand'
import { pushLevel } from './live'
import { noticeLevel, type NoticeLevel } from './notices'
import {
  PROTOCOL_VERSION,
  type ActionEntry,
  type AssistantState,
  type BrainInfo,
  type ChatMessage,
  type ConfirmationRequest,
  type CoreProcessStatus,
  type HelloMessage,
  type MemoryFact,
  type Metrics,
  type ServerMessage,
  type StopSource,
  type UsageTotals,
} from './protocol'

export type ConnectionStatus = 'connecting' | 'connected' | 'disconnected' | 'unauthorized'

export interface Notice {
  id: string
  level: NoticeLevel
  text: string
  code: string | null
  createdAt: number
}

/** Короткая подсказка в ленте диалога («Ссылка скопирована»). */
export interface Flash {
  id: number
  text: string
  tone: 'ok' | 'warn'
}

export interface UsageState {
  session: UsageTotals
  month: UsageTotals
  /** Расход последнего ответа; в hello его нет. */
  lastTurn: UsageTotals | null
  /** 0 — без лимита. */
  monthlyLimitUsd: number
}

export interface NetSample {
  t: number
  up: number
  down: number
}

export interface CoreInfo {
  coreVersion: string
  demo: boolean
  assistantName: string
  wakeWord: string
  addressForm: string
  model: string
  hotkeys: HelloMessage['hotkeys']
}

const MAX_MESSAGES = 200
const MAX_ACTIONS = 300
const MAX_NOTICES = 4
const NET_HISTORY = 60

export interface SwyvornStore {
  connection: ConnectionStatus
  coreProcess: CoreProcessStatus | null
  coreProcessMessage: string | null
  info: CoreInfo | null

  state: AssistantState
  stateReason: string | null
  /** Date.now() последней смены состояния. */
  stateChangedAt: number

  metrics: Metrics | null
  netHistory: NetSample[]

  messages: ChatMessage[]
  /** Растёт, когда лента заменяется целиком (hello, новый диалог): её прокрутка начинается заново. */
  chatEpoch: number
  actions: ActionEntry[]
  confirmation: ConfirmationRequest | null
  muted: boolean
  reducedMotion: boolean
  notices: Notice[]
  flash: Flash | null
  /** Date.now() и источник последнего «Стоп» — для анимации. */
  lastStop: { at: number; source: StopSource } | null

  brain: BrainInfo | null
  usage: UsageState | null
  memory: MemoryFact[]

  applyServerMessage: (msg: ServerMessage) => void
  setConnection: (status: ConnectionStatus) => void
  setCoreProcess: (status: CoreProcessStatus, message: string | null) => void
  setReducedMotion: (value: boolean) => void
  addNotice: (level: NoticeLevel, text: string, code?: string | null) => void
  dismissNotice: (id: string) => void
  showFlash: (text: string, tone?: Flash['tone']) => void
  clearFlash: (id: number) => void
}

let noticeSeq = 0
let flashSeq = 0

function upsertById<T extends { id: string }>(list: T[], item: T, max: number): T[] {
  const idx = list.findIndex((x) => x.id === item.id)
  if (idx >= 0) {
    const next = list.slice()
    next[idx] = item
    return next
  }
  const next = [...list, item]
  return next.length > max ? next.slice(next.length - max) : next
}

export const useSwyvorn = create<SwyvornStore>()((set, get) => ({
  connection: 'connecting',
  coreProcess: null,
  coreProcessMessage: null,
  info: null,

  state: 'idle',
  stateReason: null,
  stateChangedAt: Date.now(),

  metrics: null,
  netHistory: [],

  messages: [],
  chatEpoch: 0,
  actions: [],
  confirmation: null,
  muted: false,
  reducedMotion: false,
  notices: [],
  flash: null,
  lastStop: null,

  brain: null,
  usage: null,
  memory: [],

  setConnection: (connection) => set({ connection }),
  setCoreProcess: (coreProcess, coreProcessMessage) => set({ coreProcess, coreProcessMessage }),
  setReducedMotion: (reducedMotion) => set({ reducedMotion }),

  addNotice: (level, text, code = null) => {
    const shown = noticeLevel(level, code)
    const notices = get().notices
    const last = notices.at(-1)
    if (last && last.level === shown && last.text === text && last.code === code) {
      // Повтор того же уведомления не плодит стопку, а продлевает жизнь уже показанному.
      set({ notices: [...notices.slice(0, -1), { ...last, createdAt: Date.now() }] })
      return
    }
    const notice: Notice = { id: `n${++noticeSeq}`, level: shown, text, code, createdAt: Date.now() }
    set({ notices: [...notices, notice].slice(-MAX_NOTICES) })
  },
  dismissNotice: (id) => set({ notices: get().notices.filter((n) => n.id !== id) }),

  showFlash: (text, tone = 'ok') => set({ flash: { id: ++flashSeq, text, tone } }),
  clearFlash: (id) => {
    if (get().flash?.id === id) set({ flash: null })
  },

  applyServerMessage: (msg) => {
    switch (msg.type) {
      case 'hello':
        set({
          info: {
            coreVersion: msg.core_version,
            demo: msg.demo,
            assistantName: msg.assistant_name,
            wakeWord: msg.wake_word,
            addressForm: msg.address_form,
            model: msg.model,
            hotkeys: msg.hotkeys,
          },
          state: msg.state,
          stateReason: null,
          stateChangedAt: Date.now(),
          messages: msg.history.slice(-MAX_MESSAGES),
          chatEpoch: get().chatEpoch + 1,
          actions: msg.actions.slice(-MAX_ACTIONS),
          confirmation: msg.confirmation,
          muted: msg.muted,
          reducedMotion: msg.ui.reduced_motion || get().reducedMotion,
          // Поля версии 2 читаются бережно: ядро другой версии не должно ронять интерфейс.
          brain: msg.brain ?? null,
          usage: msg.usage
            ? {
                session: msg.usage.session,
                month: msg.usage.month,
                lastTurn: null,
                monthlyLimitUsd: msg.usage.monthly_limit_usd,
              }
            : null,
          memory: msg.memory ?? [],
        })
        if (msg.protocol !== PROTOCOL_VERSION) {
          get().addNotice(
            'error',
            `Версия ядра не совпадает с интерфейсом (протокол ${msg.protocol}, нужен ${PROTOCOL_VERSION}) — переустановите приложение`,
            'protocol_mismatch',
          )
        }
        return
      case 'state':
        if (msg.state !== get().state) {
          set({ state: msg.state, stateReason: msg.reason, stateChangedAt: Date.now() })
        }
        return
      case 'audio_level':
        pushLevel(msg.source, msg.level)
        return
      case 'metrics': {
        const { type: _t, ts, ...metrics } = msg
        const sample: NetSample = { t: ts, up: msg.net_up_bps, down: msg.net_down_bps }
        const netHistory = [...get().netHistory, sample].slice(-NET_HISTORY)
        set({ metrics, netHistory })
        return
      }
      case 'chat_message':
        set({ messages: upsertById(get().messages, msg.message, MAX_MESSAGES) })
        return
      case 'chat_delta': {
        const messages = get().messages
        const idx = messages.findIndex((m) => m.id === msg.id)
        if (idx < 0) return
        const next = messages.slice()
        next[idx] = { ...next[idx], text: next[idx].text + msg.delta }
        set({ messages: next })
        return
      }
      case 'chat_done': {
        const messages = get().messages
        const idx = messages.findIndex((m) => m.id === msg.id)
        if (idx < 0) return
        const next = messages.slice()
        next[idx] = { ...next[idx], streaming: false }
        set({ messages: next })
        return
      }
      case 'action':
        set({ actions: upsertById(get().actions, msg.entry, MAX_ACTIONS) })
        return
      case 'confirmation_request':
        set({ confirmation: msg.request })
        return
      case 'confirmation_countdown': {
        const c = get().confirmation
        if (c && c.action_id === msg.action_id) set({ confirmation: { ...c, expires_at: msg.expires_at } })
        return
      }
      case 'confirmation_resolved': {
        const c = get().confirmation
        if (c && c.action_id === msg.action_id) set({ confirmation: null })
        return
      }
      case 'muted':
        set({ muted: msg.muted })
        return
      case 'brain_status': {
        // Демо-режим и есть статус «мозга» demo (docs/brain.md). Отдельного события о демо нет,
        // поэтому hello.demo обновляем отсюда: от него зависит пульт демо.
        const info = get().info
        set({
          brain: msg.brain,
          info: info ? { ...info, demo: msg.brain.status === 'demo', model: msg.brain.model } : info,
        })
        return
      }
      case 'usage':
        set({
          usage: {
            session: msg.session,
            month: msg.month,
            lastTurn: msg.last_turn,
            monthlyLimitUsd: msg.monthly_limit_usd,
          },
        })
        return
      case 'memory':
        set({ memory: msg.facts })
        return
      case 'session_reset':
        // Журнал действий остаётся: он о том, что делалось на компьютере, а не о разговоре.
        set({ messages: [], chatEpoch: get().chatEpoch + 1 })
        return
      case 'notice':
        get().addNotice(msg.level, msg.text, msg.code)
        return
      case 'stopped':
        set({ lastStop: { at: Date.now(), source: msg.source } })
        return
      case 'error':
        get().addNotice('warning', `Ядро: ${msg.message}`, msg.code)
        return
      case 'pong':
        return
    }
  },
}))
