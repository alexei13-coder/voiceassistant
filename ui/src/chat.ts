// Правила отображения ленты диалога, не зависящие от React.

import type { AssistantState, ChatMessage } from './protocol'

/** Ассистент ещё не начал отвечать: ядро думает, а последняя реплика — пользователя. */
export function isAwaitingReply(state: AssistantState, messages: readonly ChatMessage[]): boolean {
  return state === 'thinking' && messages.at(-1)?.role === 'user'
}

/**
 * Служебные пометки, которые ядро дописывает в конец ответа (docs/brain.md): «(остановлено)»
 * после «Стопа» и «(ответ обрезан)» после max_tokens. Они показываются приглушённо.
 */
const STATUS_SUFFIX = /\s*(\((?:остановлено|ответ обрезан)\))\s*$/

export function splitStatusSuffix(text: string): { body: string; suffix: string | null } {
  const match = STATUS_SUFFIX.exec(text)
  if (!match) return { body: text, suffix: null }
  return { body: text.slice(0, match.index), suffix: match[1] }
}
