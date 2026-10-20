// Нижняя панель: микрофон и тишина слева, поле команды по центру, «СТОП» справа.
// Сетка колонок совпадает с основной, чтобы элементы стояли под своими панелями.

import { useState, type FormEvent } from 'react'
import { sendCommand } from '../core/connection'
import { DEFAULT_ACTIVATE_HOTKEY } from '../labels'
import type { ClientMessage } from '../protocol'
import { useJarvis } from '../store'
import { Icon } from './Icon'
import { StopButton } from './StopButton'
import './BottomBar.css'

/** Предел протокола для send_text (docs/protocol.md §1.6). */
const MAX_TEXT = 4000
const COUNTER_FROM = MAX_TEXT - 400

/** Отправить команду; если связи нет — сказать об этом, а не молчать. */
function send(msg: ClientMessage): boolean {
  if (sendCommand(msg)) return true
  useJarvis.getState().addNotice('warning', 'Нет связи с ядром — команда не отправлена', 'not_sent')
  return false
}

function MicButton({ disabled }: { disabled: boolean }) {
  const listening = useJarvis((s) => s.state === 'listening')
  const hotkey = useJarvis((s) => s.info?.hotkeys.activate || DEFAULT_ACTIVATE_HOTKEY)
  return (
    <button
      type="button"
      className={listening ? 'ctl ctl--live' : 'ctl'}
      aria-pressed={listening}
      disabled={disabled}
      onClick={() => send({ type: 'mic', action: 'toggle' })}
      title={`Говорить (${hotkey}; удерживайте — говорить, пока держите)`}
    >
      <Icon name="mic" />
      <span className="ctl__label">{listening ? 'Слушаю' : 'Говорить'}</span>
    </button>
  )
}

function MuteButton({ disabled }: { disabled: boolean }) {
  const muted = useJarvis((s) => s.muted)
  const hotkey = useJarvis((s) => s.info?.hotkeys.mute)
  return (
    <button
      type="button"
      className={muted ? 'ctl ctl--muted' : 'ctl'}
      aria-pressed={muted}
      disabled={disabled}
      onClick={() => send({ type: 'mute', muted: !muted })}
      title={`${muted ? 'Включить микрофон' : 'Выключить микрофон'}${hotkey ? ` (${hotkey})` : ''}`}
    >
      <Icon name="micOff" />
      <span className="ctl__label">{muted ? 'Вкл. микрофон' : 'Выкл. микрофон'}</span>
    </button>
  )
}

function CommandInput({ disabled }: { disabled: boolean }) {
  const [text, setText] = useState('')
  const canSend = !disabled && text.trim().length > 0

  const submit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault()
    const trimmed = text.trim()
    if (!trimmed) return
    if (send({ type: 'send_text', text: trimmed })) setText('')
  }

  return (
    <form className={disabled ? 'cmd cmd--disabled' : 'cmd'} onSubmit={submit}>
      <span className="cmd__prompt" aria-hidden="true">
        ›
      </span>
      <input
        className="cmd__input"
        value={text}
        onChange={(e) => setText(e.target.value)}
        maxLength={MAX_TEXT}
        disabled={disabled}
        placeholder={disabled ? 'Нет связи с ядром — ввод недоступен' : 'Напишите команду…'}
        aria-label="Команда для ассистента"
        autoComplete="off"
        spellCheck={false}
      />
      {text.length >= COUNTER_FROM && (
        <span className="cmd__count mono">
          {text.length}/{MAX_TEXT}
        </span>
      )}
      <button type="submit" className="cmd__send" disabled={!canSend} aria-label="Отправить" title="Отправить (Enter)">
        <Icon name="send" />
      </button>
    </form>
  )
}

export function BottomBar() {
  const connected = useJarvis((s) => s.connection === 'connected')
  return (
    <footer className="bottombar">
      <div className="bottombar__controls">
        <MicButton disabled={!connected} />
        <MuteButton disabled={!connected} />
      </div>
      <CommandInput disabled={!connected} />
      <StopButton />
    </footer>
  )
}
