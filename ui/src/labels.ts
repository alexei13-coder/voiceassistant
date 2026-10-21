// Русские подписи для значений протокола и подсказки под ядром.

import type {
  ActionDecision,
  ActionStatus,
  AssistantState,
  BrainInfo,
  BrainStatus,
  ChatMessage,
  CoreProcessStatus,
  Risk,
} from './protocol'
import type { ConnectionStatus } from './store'

export const DEFAULT_ASSISTANT_NAME = 'SWYVORN'
/** Как имя звучит вслух — его и надо произнести, чтобы позвать ассистента. */
export const DEFAULT_WAKE_WORD = 'Свайворн'
export const DEFAULT_ACTIVATE_HOTKEY = 'Ctrl+Alt+J'
export const DEFAULT_STOP_HOTKEY = 'Ctrl+Alt+Escape'

export const ACTION_STATUS_LABELS: Record<ActionStatus, string> = {
  pending: 'в очереди',
  awaiting_confirmation: 'ждёт подтверждения',
  running: 'выполняется',
  ok: 'выполнено',
  error: 'ошибка',
  denied: 'отклонено',
  cancelled: 'отменено',
  timeout: 'время вышло',
  forbidden: 'запрещено',
  stopped: 'остановлено',
}

export const ACTION_DECISION_LABELS: Record<ActionDecision, string> = {
  auto: 'автоматически',
  confirmed_voice: 'подтверждено голосом',
  confirmed_button: 'подтверждено кнопкой',
  confirmed_text: 'подтверждено текстом',
  denied: 'отклонено',
  timeout: 'тайм-аут',
  unclear: 'нечёткий ответ',
  forbidden: 'запрещено политикой',
  stopped: 'остановлено',
}

export const RISK_LABELS: Record<Risk, string> = {
  safe: 'безопасное действие',
  confirm: 'требует подтверждения',
  forbidden: 'запрещённое действие',
}

/** Короткое слово о связи с ядром для верхней панели. */
export const CONNECTION_LABELS: Record<ConnectionStatus, string> = {
  connecting: 'подключение',
  connected: 'в сети',
  disconnected: 'нет связи',
  unauthorized: 'нет доступа',
}

/** Короткое слово о Claude для верхней панели. */
export const BRAIN_LABELS: Record<BrainStatus, string> = {
  ready: 'claude',
  no_key: 'нет ключа',
  invalid_key: 'ключ не подошёл',
  offline: 'нет связи',
  limit: 'лимит',
  demo: 'демо',
}

/** Пояснение, если ядро не прислало своё (для ready и demo оно всегда null). */
const BRAIN_FALLBACK_MESSAGES: Record<Exclude<BrainStatus, 'ready'>, string> = {
  no_key: 'Ключ API не задан',
  invalid_key: 'Ключ API не подошёл',
  offline: 'Нет связи с Claude',
  limit: 'Достигнут месячный лимит расходов',
  demo: 'Демо-режим: Claude не подключён, реальные действия не выполняются',
}

/** Подсказка к индикатору Claude: что с ним и какая модель. */
export function brainTooltip(brain: BrainInfo): string {
  const model = `модель ${brain.model}${brain.web_search ? ' · поиск в интернете' : ''}`
  if (brain.status === 'ready') return `Claude на связи · ${model}`
  return `${brain.message?.trim() || BRAIN_FALLBACK_MESSAGES[brain.status]}\n${model}`
}

/** Нужен ли пользователю совет, как добавить ключ API. */
export function needsApiKey(status: BrainStatus | undefined): boolean {
  return status === 'no_key' || status === 'invalid_key'
}

/** Где лежит ключ (docs/configuration.md) и какую строку туда вписать. */
export const API_KEY_FILE = '%APPDATA%\\Swyvorn\\.env'
export const API_KEY_LINE = 'ANTHROPIC_API_KEY=…'

/** Понятные подписи особых ключей долговременной памяти (docs/brain.md). */
const MEMORY_KEY_LABELS: Record<string, string> = {
  address_form: 'обращение',
  user_name: 'имя',
  city: 'город',
}

/** Подпись факта памяти: особые ключи — по-русски, остальные — без подчёркиваний. */
export function memoryKeyLabel(key: string): string {
  return Object.hasOwn(MEMORY_KEY_LABELS, key) ? MEMORY_KEY_LABELS[key] : key.replaceAll('_', ' ')
}

/** Слово состояния под ядром — строчными, спокойно. */
export const STATE_WORDS: Record<AssistantState, string> = {
  idle: 'ожидание',
  listening: 'слушаю',
  thinking: 'думаю',
  speaking: 'говорю',
  awaiting_confirmation: 'жду подтверждения',
  executing: 'выполняю',
  error: 'ошибка',
  stopped: 'остановлено',
}

/** CSS-переменная цвета состояния из tokens.css. */
export const STATE_COLOR_VARS: Record<AssistantState, string> = {
  idle: 'var(--state-idle)',
  listening: 'var(--state-listening)',
  thinking: 'var(--state-thinking)',
  speaking: 'var(--state-speaking)',
  awaiting_confirmation: 'var(--state-awaiting)',
  executing: 'var(--state-executing)',
  error: 'var(--state-error)',
  stopped: 'var(--state-stopped)',
}

/** Подпись автора реплики в диалоге. */
export function roleLabel(role: ChatMessage['role'], assistantName: string | undefined): string {
  if (role === 'user') return 'вы'
  if (role === 'system') return 'система'
  return assistantName || DEFAULT_ASSISTANT_NAME
}

export interface HintContext {
  reason: string | null
  activateHotkey: string | undefined
  wakeWord: string | undefined
  /** Текущий вопрос принимает только кнопку — звать к голосовому «да» нельзя. */
  buttonOnly?: boolean
}

/** Строка-подсказка под подписью состояния. */
export function stateHint(state: AssistantState, ctx: HintContext): string {
  switch (state) {
    case 'idle':
      return `Скажите „${ctx.wakeWord || DEFAULT_WAKE_WORD}“ или нажмите ${ctx.activateHotkey || DEFAULT_ACTIVATE_HOTKEY}`
    case 'listening':
      return 'Слушаю…'
    case 'thinking':
      return 'Обрабатываю запрос…'
    case 'speaking':
      return 'Говорю — можно перебить'
    case 'awaiting_confirmation':
      return ctx.buttonOnly ? 'Подтвердите кнопкой на экране' : 'Скажите „да“ или нажмите кнопку'
    case 'executing':
      return 'Выполняю…'
    case 'error':
      return ctx.reason?.trim() || 'Что-то пошло не так'
    case 'stopped':
      return 'Всё остановлено'
  }
}

/** Подсказка вместо обычной, пока ядра нет: звать к голосу или горячей клавише бессмысленно. */
export function offlineHint(connection: ConnectionStatus): string | null {
  switch (connection) {
    case 'connected':
      return null
    case 'connecting':
      return 'Подключаюсь к ядру…'
    case 'disconnected':
      return 'Ядро недоступно — команды пока не принимаются'
    case 'unauthorized':
      return 'Ядро отклонило подключение — перезапустите приложение'
  }
}

export interface Banner {
  level: 'warning' | 'error'
  text: string
}

/**
 * Полоса о проблеме со связью или процессом ядра. Пока связь есть, старые статусы
 * процесса (crashed/restarting) уже неактуальны и не показываются.
 */
export function connectionBanner(
  connection: ConnectionStatus,
  coreProcess: CoreProcessStatus | null,
  coreMessage: string | null,
): Banner | null {
  if (connection === 'connected') return null
  const suffix = coreMessage?.trim() ? `: ${coreMessage.trim()}` : ''
  switch (coreProcess) {
    case 'fatal':
      return { level: 'error', text: `Ядро не запускается${suffix}` }
    case 'crashed':
      return { level: 'error', text: `Ядро аварийно завершилось${suffix} — перезапускаю…` }
    case 'restarting':
      return { level: 'warning', text: `Перезапуск ядра${suffix}…` }
    default:
      break
  }
  if (connection === 'unauthorized') return { level: 'error', text: 'Ошибка доступа к ядру (токен)' }
  if (connection === 'disconnected') return { level: 'warning', text: 'Нет связи с ядром — переподключаюсь…' }
  return null
}
