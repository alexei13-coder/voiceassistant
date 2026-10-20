// Русские подписи для значений протокола и подсказки под ядром.

import type { ActionDecision, ActionStatus, AssistantState, ChatMessage, CoreProcessStatus, Risk } from './protocol'
import type { ConnectionStatus } from './store'

export const DEFAULT_ASSISTANT_NAME = 'SWYVORN'
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

export const CONNECTION_LABELS: Record<ConnectionStatus, string> = {
  connecting: 'ЯДРО: ПОДКЛЮЧЕНИЕ',
  connected: 'ЯДРО: В СЕТИ',
  disconnected: 'НЕТ СВЯЗИ',
  unauthorized: 'ОШИБКА ДОСТУПА',
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

export function roleLabel(role: ChatMessage['role'], assistantName: string | undefined): string {
  if (role === 'user') return 'ВЫ'
  if (role === 'system') return 'СИСТЕМА'
  return (assistantName || DEFAULT_ASSISTANT_NAME).toUpperCase()
}

export interface HintContext {
  reason: string | null
  activateHotkey: string | undefined
  assistantName: string | undefined
  /** Текущий вопрос принимает только кнопку — звать к голосовому «да» нельзя. */
  buttonOnly?: boolean
}

/** Строка-подсказка под подписью состояния. */
export function stateHint(state: AssistantState, ctx: HintContext): string {
  switch (state) {
    case 'idle':
      return `Скажите „${ctx.assistantName || DEFAULT_ASSISTANT_NAME}“ или нажмите ${ctx.activateHotkey || DEFAULT_ACTIVATE_HOTKEY}`
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
