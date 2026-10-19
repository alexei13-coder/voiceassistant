// Типы протокола ядро ⇄ UI. Зеркало docs/protocol.md — менять только вместе с ним.

export const PROTOCOL_VERSION = 1

export type AssistantState =
  | 'idle'
  | 'listening'
  | 'thinking'
  | 'speaking'
  | 'awaiting_confirmation'
  | 'executing'
  | 'error'
  | 'stopped'

export const STATE_LABELS: Record<AssistantState, string> = {
  idle: 'ОЖИДАНИЕ',
  listening: 'СЛУШАЮ',
  thinking: 'ДУМАЮ',
  speaking: 'ГОВОРЮ',
  awaiting_confirmation: 'ЖДУ ПОДТВЕРЖДЕНИЯ',
  executing: 'ВЫПОЛНЯЮ',
  error: 'ОШИБКА',
  stopped: 'ОСТАНОВЛЕНО',
}

export type Risk = 'safe' | 'confirm' | 'forbidden'

export interface ChatMessage {
  id: string
  role: 'user' | 'assistant' | 'system'
  text: string
  streaming: boolean
  created_at: number
}

export type ActionStatus =
  | 'pending'
  | 'awaiting_confirmation'
  | 'running'
  | 'ok'
  | 'error'
  | 'denied'
  | 'cancelled'
  | 'timeout'
  | 'forbidden'
  | 'stopped'

export type ActionDecision =
  | 'auto'
  | 'confirmed_voice'
  | 'confirmed_button'
  | 'confirmed_text'
  | 'denied'
  | 'timeout'
  | 'unclear'
  | 'forbidden'
  | 'stopped'

export interface ActionEntry {
  id: string
  created_at: number
  tool: string
  title: string
  risk: Risk
  status: ActionStatus
  decision?: ActionDecision | null
  detail?: string | null
  duration_ms?: number | null
  demo?: boolean
}

export interface ConfirmationRequest {
  action_id: string
  nonce: string
  title: string
  spoken_text: string
  details: string[]
  command: string | null
  command_language: 'powershell' | null
  code_analysis: string[]
  model_explanation: string | null
  risk: 'confirm'
  button_only: boolean
  timeout_ms: number
  expires_at: number | null
  demo: boolean
}

export interface Metrics {
  cpu_percent: number
  ram_percent: number
  ram_used_mb: number
  ram_total_mb: number
  net_up_bps: number
  net_down_bps: number
  uptime_s: number
  time_iso: string
}

export interface Hotkeys {
  activate: string
  stop: string
  stop_fallback: string
  mute: string
  repeat: string
  screen: string
}

export type ConfirmationOutcome =
  | 'confirmed'
  | 'denied'
  | 'timeout'
  | 'cancelled'
  | 'stopped'
  | 'superseded'

export type StopSource = 'button' | 'hotkey' | 'voice' | 'tray' | 'emergency'

// ---------- ядро → UI ----------

interface Base {
  ts: number
}

export interface HelloMessage extends Base {
  type: 'hello'
  protocol: number
  core_version: string
  state: AssistantState
  demo: boolean
  assistant_name: string
  address_form: string
  model: string
  hotkeys: Hotkeys
  ui: { reduced_motion: boolean }
  muted: boolean
  history: ChatMessage[]
  actions: ActionEntry[]
  confirmation: ConfirmationRequest | null
}

export interface StateMessage extends Base {
  type: 'state'
  state: AssistantState
  reason: string | null
}

export interface AudioLevelMessage extends Base {
  type: 'audio_level'
  source: 'mic' | 'tts'
  level: number
}

export interface MetricsMessage extends Base, Metrics {
  type: 'metrics'
}

export interface ChatMessageMessage extends Base {
  type: 'chat_message'
  message: ChatMessage
}

export interface ChatDeltaMessage extends Base {
  type: 'chat_delta'
  id: string
  delta: string
}

export interface ChatDoneMessage extends Base {
  type: 'chat_done'
  id: string
}

export interface ActionMessage extends Base {
  type: 'action'
  entry: ActionEntry
}

export interface ConfirmationRequestMessage extends Base {
  type: 'confirmation_request'
  request: ConfirmationRequest
}

export interface ConfirmationCountdownMessage extends Base {
  type: 'confirmation_countdown'
  action_id: string
  expires_at: number
}

export interface ConfirmationResolvedMessage extends Base {
  type: 'confirmation_resolved'
  action_id: string
  outcome: ConfirmationOutcome
  via: 'voice' | 'button' | 'text' | null
}

export interface MutedMessage extends Base {
  type: 'muted'
  muted: boolean
}

export interface NoticeMessage extends Base {
  type: 'notice'
  level: 'info' | 'warning' | 'error'
  text: string
  code: string | null
}

export interface StoppedMessage extends Base {
  type: 'stopped'
  source: StopSource
}

export interface PongMessage extends Base {
  type: 'pong'
}

export interface ErrorMessage extends Base {
  type: 'error'
  code: string
  message: string
}

export type ServerMessage =
  | HelloMessage
  | StateMessage
  | AudioLevelMessage
  | MetricsMessage
  | ChatMessageMessage
  | ChatDeltaMessage
  | ChatDoneMessage
  | ActionMessage
  | ConfirmationRequestMessage
  | ConfirmationCountdownMessage
  | ConfirmationResolvedMessage
  | MutedMessage
  | NoticeMessage
  | StoppedMessage
  | PongMessage
  | ErrorMessage

// ---------- UI → ядро ----------

export type ClientMessage =
  | { type: 'auth'; token: string }
  | { type: 'send_text'; text: string }
  | { type: 'confirm'; action_id: string; nonce: string; decision: 'yes' | 'no' }
  | { type: 'stop'; source: 'button' }
  | { type: 'mic'; action: 'toggle' | 'ptt_down' | 'ptt_up' }
  | { type: 'mute'; muted: boolean }
  | { type: 'ping' }
  | {
      type: 'demo'
      action: 'start' | 'stop' | 'set_state' | 'confirmation' | 'error_flash'
      state?: AssistantState
    }

// ---------- Tauri ----------

export interface CoreConnectionInfo {
  port: number
  token: string
}

export type CoreProcessStatus = 'starting' | 'ready' | 'crashed' | 'restarting' | 'fatal'

export interface CoreStatusEvent {
  status: CoreProcessStatus
  message: string | null
}
