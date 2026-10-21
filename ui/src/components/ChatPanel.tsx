// Колонка «ДИАЛОГ»: спокойная лента реплик без пузырей. Ответы ассистента — Markdown,
// реплики пользователя и системы — простой текст. Прилипает к низу, пока пользователь
// не прокрутил вверх; тогда о новых репликах сообщает плашка «новые сообщения».

import { memo, useEffect, useLayoutEffect, useRef, useState, type UIEvent } from 'react'
import { isAwaitingReply, splitStatusSuffix } from '../chat'
import { sendOrNotify } from '../core/commands'
import { formatTimeLong, formatTimeShort } from '../format'
import { API_KEY_FILE, API_KEY_LINE, DEFAULT_ASSISTANT_NAME, DEFAULT_WAKE_WORD, needsApiKey, roleLabel } from '../labels'
import type { ChatMessage } from '../protocol'
import { useSwyvorn } from '../store'
import { CopyText } from './CopyText'
import { Icon } from './Icon'
import { MessageMarkdown } from './markdown/MessageMarkdown'
import { Section } from './Section'
import './ChatPanel.css'

/** Запас в пикселях: «почти внизу» считается низом, чтобы дробная прокрутка не отлипала. */
const STICK_THRESHOLD_PX = 32
/** Сколько висит подсказка «Ссылка скопирована». */
const FLASH_MS = 1800

function TypingDots() {
  return (
    <span className="typing" role="img" aria-label="печатает">
      <i />
      <i />
      <i />
    </span>
  )
}

function AssistantText({ message }: { message: ChatMessage }) {
  // Ответ создан, но ещё пуст — те же точки, что и до него, а не одинокий курсор.
  if (message.streaming && message.text === '') return <TypingDots />
  const { body, suffix } = splitStatusSuffix(message.text)
  return <MessageMarkdown text={body} streaming={message.streaming} suffix={suffix} />
}

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
      {message.role === 'assistant' ? <AssistantText message={message} /> : <p className="msg__text">{message.text}</p>}
    </article>
  )
})

/** Как добавить ключ API — вместо пустой ленты, пока Claude недоступен из-за ключа. */
function ApiKeyHelp({ invalid }: { invalid: boolean }) {
  return (
    <div className="chat__empty chat__key">
      <p>
        {invalid ? 'Ключ API не подошёл — замените его в ' : 'Чтобы говорить с Claude, добавьте ключ API в '}
        <CopyText value={API_KEY_FILE} className="chat__path mono" done="Путь скопирован" failed="Не удалось скопировать путь">
          {API_KEY_FILE}
        </CopyText>{' '}
        (строка <span className="mono">{API_KEY_LINE}</span>).
      </p>
      <p>Перезапуск не нужен — просто напишите сообщение.</p>
    </div>
  )
}

function EmptyState() {
  const brainStatus = useSwyvorn((s) => s.brain?.status)
  const wakeWord = useSwyvorn((s) => s.info?.wakeWord || DEFAULT_WAKE_WORD)
  if (needsApiKey(brainStatus)) return <ApiKeyHelp invalid={brainStatus === 'invalid_key'} />
  return <p className="chat__empty">Пока тихо — скажите „{wakeWord}“ или напишите команду внизу</p>
}

/** «Ссылка скопирована» и т. п.: коротко, в заголовке секции — не заслоняя ленту. */
function ChatFlash() {
  const flash = useSwyvorn((s) => s.flash)
  useEffect(() => {
    if (!flash) return
    const timer = setTimeout(() => useSwyvorn.getState().clearFlash(flash.id), FLASH_MS)
    return () => clearTimeout(timer)
  }, [flash])
  if (!flash) return null
  return (
    <span key={flash.id} className={`chat__flash chat__flash--${flash.tone}`} role="status">
      <Icon name={flash.tone === 'ok' ? 'check' : 'close'} />
      {flash.text}
    </span>
  )
}

/** Лента с прокруткой. Пересоздаётся (key) при замене ленты целиком — прокрутка начинается заново. */
function ChatFeed() {
  const messages = useSwyvorn((s) => s.messages)
  const awaitingReply = useSwyvorn((s) => isAwaitingReply(s.state, s.messages))
  const assistantName = useSwyvorn((s) => s.info?.assistantName || DEFAULT_ASSISTANT_NAME)
  const feedRef = useRef<HTMLDivElement>(null)
  const [pinned, setPinned] = useState(true)
  /** id последней реплики в момент, когда пользователь отлистал вверх. */
  const [lastSeenId, setLastSeenId] = useState<string | null>(null)

  const lastId = messages.length > 0 ? messages[messages.length - 1].id : null
  const showNewPill = !pinned && lastId !== null && lastId !== lastSeenId

  // До отрисовки кадра — иначе при потоковом ответе лента заметно «прыгает».
  useLayoutEffect(() => {
    const feed = feedRef.current
    if (pinned && feed) feed.scrollTop = feed.scrollHeight
  }, [messages, awaitingReply, pinned])

  const onScroll = (e: UIEvent<HTMLDivElement>) => {
    const el = e.currentTarget
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight <= STICK_THRESHOLD_PX
    if (atBottom === pinned) return
    setPinned(atBottom)
    if (!atBottom) setLastSeenId(lastId)
  }

  return (
    <>
      <div className="chat__feed fade-scroll" ref={feedRef} onScroll={onScroll} role="log" aria-live="polite" aria-label="Диалог">
        {messages.length === 0 ? (
          <EmptyState />
        ) : (
          messages.map((m) => <ChatItem key={m.id} message={m} assistantName={assistantName} />)
        )}
        {awaitingReply && (
          <div className="msg msg--assistant msg--pending">
            <TypingDots />
          </div>
        )}
      </div>
      {showNewPill && (
        // Саму прокрутку сделает useLayoutEffect, как только лента снова «прилипнет».
        <button type="button" className="chat__new" onClick={() => setPinned(true)}>
          <Icon name="chevronDown" />
          новые сообщения
        </button>
      )}
    </>
  )
}

function NewSessionButton() {
  return (
    <button
      type="button"
      className="section__tool"
      onClick={() => sendOrNotify({ type: 'new_session' })}
      title="Начать новый диалог: разговор очистится, долговременная память останется"
    >
      <Icon name="plus" />
      новый диалог
    </button>
  )
}

export function ChatPanel() {
  const chatEpoch = useSwyvorn((s) => s.chatEpoch)
  const hasMessages = useSwyvorn((s) => s.messages.length > 0)
  return (
    <Section title="Диалог" className="chat" aside={<ChatFlash />} tools={hasMessages ? <NewSessionButton /> : undefined}>
      <ChatFeed key={chatEpoch} />
    </Section>
  )
}
