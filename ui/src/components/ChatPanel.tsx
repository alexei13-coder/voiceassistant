// Колонка «ДИАЛОГ»: спокойная лента реплик без пузырей. Прилипает к низу, пока пользователь
// не прокрутил вверх; тогда о новых репликах сообщает плашка «новые сообщения».

import { memo, useLayoutEffect, useRef, useState, type UIEvent } from 'react'
import { formatTimeLong, formatTimeShort } from '../format'
import { DEFAULT_ASSISTANT_NAME, roleLabel } from '../labels'
import type { ChatMessage } from '../protocol'
import { useSwyvorn } from '../store'
import { Icon } from './Icon'
import { Section } from './Section'
import './ChatPanel.css'

/** Запас в пикселях: «почти внизу» считается низом, чтобы дробная прокрутка не отлипала. */
const STICK_THRESHOLD_PX = 32

const ChatItem = memo(function ChatItem({ message, assistantName }: { message: ChatMessage; assistantName: string }) {
  const time = formatTimeShort(message.created_at)
  const isUser = message.role === 'user'
  // Подпись «вы» и время — только у реплик пользователя: они открывают каждый обмен.
  // Имя ассистента не повторяем у каждой реплики (его голос — основной цвет текста), для диктора оно остаётся.
  return (
    <article className={`msg msg--${message.role}`} title={isUser ? undefined : formatTimeLong(message.created_at)}>
      {isUser ? (
        <header className="msg__meta">
          <span className="msg__role">{roleLabel(message.role, assistantName)}</span>
          <time className="msg__time mono" dateTime={new Date(message.created_at).toISOString()}>
            {time}
          </time>
        </header>
      ) : (
        <span className="visually-hidden">
          {roleLabel(message.role, assistantName)}, {time}:
        </span>
      )}
      <p className="msg__text">
        {message.text}
        {message.streaming && <span className="msg__caret" aria-hidden="true" />}
      </p>
    </article>
  )
})

export function ChatPanel() {
  const messages = useSwyvorn((s) => s.messages)
  const assistantName = useSwyvorn((s) => s.info?.assistantName || DEFAULT_ASSISTANT_NAME)
  const feedRef = useRef<HTMLDivElement>(null)
  const [pinned, setPinned] = useState(true)
  /** id последней реплики в момент, когда пользователь отлистал вверх. */
  const [lastSeenId, setLastSeenId] = useState<string | null>(null)

  const lastId = messages.length > 0 ? messages[messages.length - 1].id : null
  const showNewPill = !pinned && lastId !== lastSeenId

  // До отрисовки кадра — иначе при потоковом ответе лента заметно «прыгает».
  useLayoutEffect(() => {
    const feed = feedRef.current
    if (pinned && feed) feed.scrollTop = feed.scrollHeight
  }, [messages, pinned])

  const onScroll = (e: UIEvent<HTMLDivElement>) => {
    const el = e.currentTarget
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight <= STICK_THRESHOLD_PX
    if (atBottom === pinned) return
    setPinned(atBottom)
    if (!atBottom) setLastSeenId(lastId)
  }

  // Саму прокрутку сделает useLayoutEffect, как только лента снова «прилипнет».
  const jumpToBottom = () => setPinned(true)

  return (
    <Section title="Диалог" className="chat">
      <div className="chat__feed fade-scroll" ref={feedRef} onScroll={onScroll} role="log" aria-live="polite" aria-label="Диалог">
        {messages.length === 0 ? (
          <p className="chat__empty">Пока тихо — скажите „{assistantName}“ или напишите команду внизу</p>
        ) : (
          messages.map((m) => <ChatItem key={m.id} message={m} assistantName={assistantName} />)
        )}
      </div>
      {showNewPill && (
        <button type="button" className="chat__new" onClick={jumpToBottom}>
          <Icon name="chevronDown" />
          новые сообщения
        </button>
      )}
    </Section>
  )
}
