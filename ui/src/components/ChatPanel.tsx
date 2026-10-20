// Панель «ДИАЛОГ»: лента реплик. Прилипает к низу, пока пользователь не прокрутил вверх;
// тогда о новых репликах сообщает плашка «↓ новые сообщения».

import { memo, useLayoutEffect, useRef, useState, type UIEvent } from 'react'
import { formatTimeShort } from '../format'
import { DEFAULT_ACTIVATE_HOTKEY, DEFAULT_ASSISTANT_NAME, roleLabel } from '../labels'
import type { ChatMessage } from '../protocol'
import { useSwyvorn } from '../store'
import { Icon } from './Icon'
import { Panel } from './Panel'
import './ChatPanel.css'

/** Запас в пикселях: «почти внизу» считается низом, чтобы дробная прокрутка не отлипала. */
const STICK_THRESHOLD_PX = 32

const ChatItem = memo(function ChatItem({ message, assistantName }: { message: ChatMessage; assistantName: string }) {
  return (
    <article className={`msg msg--${message.role}`}>
      <header className="msg__meta">
        <span className="msg__role">{roleLabel(message.role, assistantName)}</span>
        <time className="msg__time mono" dateTime={new Date(message.created_at).toISOString()}>
          {formatTimeShort(message.created_at)}
        </time>
      </header>
      <p className="msg__text">
        {message.text}
        {message.streaming && <span className="msg__caret" aria-hidden="true" />}
      </p>
    </article>
  )
})

function EmptyChat({ assistantName, hotkey }: { assistantName: string; hotkey: string }) {
  return (
    <div className="chat__empty">
      <Icon name="chat" className="chat__empty-icon" />
      <p className="chat__empty-title">Диалог пуст</p>
      <p className="chat__empty-hint">
        Скажите „{assistantName}“, нажмите <kbd className="mono">{hotkey}</kbd> или напишите команду внизу
      </p>
    </div>
  )
}

export function ChatPanel() {
  const messages = useSwyvorn((s) => s.messages)
  const assistantName = useSwyvorn((s) => s.info?.assistantName || DEFAULT_ASSISTANT_NAME)
  const hotkey = useSwyvorn((s) => s.info?.hotkeys.activate || DEFAULT_ACTIVATE_HOTKEY)
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
    <Panel index="01" title="ДИАЛОГ" aside={messages.length > 0 ? String(messages.length).padStart(2, '0') : '—'} className="chat">
      <div className="chat__feed" ref={feedRef} onScroll={onScroll} role="log" aria-live="polite" aria-label="Диалог">
        {messages.length === 0 ? (
          <EmptyChat assistantName={assistantName} hotkey={hotkey} />
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
    </Panel>
  )
}
