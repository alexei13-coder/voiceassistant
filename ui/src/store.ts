// Состояние UI для React. Единственное место, где сообщения ядра превращаются в состояние.
// Уровни звука сюда НЕ попадают — см. live.ts.

import { create } from 'zustand'
import { pushLevel } from './live'
import type {
  ActionEntry,
  AssistantState,
  ChatMessage,
  ConfirmationRequest,
  CoreProcessStatus,
  HelloMessage,
  Metrics,
  ServerMessage,
  StopSource,
} from './protocol'

export type ConnectionStatus = 'connecting' | 'connected' | 'disconnected' | 'unauthorized'

export interface Notice {
  id: string
  level: 'info' | 'warning' | 'error'
  text: string
  code: string | null
  createdAt: number
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
  addressForm: string
  model: string
  hotkeys: HelloMessage['hotkeys']
}

const MAX_MESSAGES = 200
const MAX_ACTIONS = 300
const MAX_NOTICES = 4
const NET_HISTORY = 60

export interface JarvisStore {
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
  actions: ActionEntry[]
  confirmation: ConfirmationRequest | null
  muted: boolean
  reducedMotion: boolean
  notices: Notice[]
  /** Date.now() и источник последнего «Стоп» — для анимации. */
  lastStop: { at: number; source: StopSource } | null

  applyServerMessage: (msg: ServerMessage) => void
  setConnection: (status: ConnectionStatus) => void
  setCoreProcess: (status: CoreProcessStatus, message: string | null) => void
  setReducedMotion: (value: boolean) => void
  addNotice: (level: Notice['level'], text: string, code?: string | null) => void
  dismissNotice: (id: string) => void
}

let noticeSeq = 0

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

export const useJarvis = create<JarvisStore>()((set, get) => ({
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
  actions: [],
  confirmation: null,
  muted: false,
  reducedMotion: false,
  notices: [],
  lastStop: null,

  setConnection: (connection) => set({ connection }),
  setCoreProcess: (coreProcess, coreProcessMessage) => set({ coreProcess, coreProcessMessage }),
  setReducedMotion: (reducedMotion) => set({ reducedMotion }),

  addNotice: (level, text, code = null) => {
    const notice: Notice = { id: `n${++noticeSeq}`, level, text, code, createdAt: Date.now() }
    set({ notices: [...get().notices, notice].slice(-MAX_NOTICES) })
  },
  dismissNotice: (id) => set({ notices: get().notices.filter((n) => n.id !== id) }),

  applyServerMessage: (msg) => {
    switch (msg.type) {
      case 'hello':
        set({
          info: {
            coreVersion: msg.core_version,
            demo: msg.demo,
            assistantName: msg.assistant_name,
            addressForm: msg.address_form,
            model: msg.model,
            hotkeys: msg.hotkeys,
          },
          state: msg.state,
          stateReason: null,
          stateChangedAt: Date.now(),
          messages: msg.history.slice(-MAX_MESSAGES),
          actions: msg.actions.slice(-MAX_ACTIONS),
          confirmation: msg.confirmation,
          muted: msg.muted,
          reducedMotion: msg.ui.reduced_motion || get().reducedMotion,
        })
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
