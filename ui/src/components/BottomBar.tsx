// Нижняя панель: одно поле команды по центру (микрофон внутри справа, тишина рядом) и «Стоп» справа.
// Сетка колонок совпадает с основной, чтобы поле стояло точно под ядром.

import { useRef, useState, type FormEvent } from 'react'
import { sendCommand } from '../core/connection'
import { DEFAULT_ACTIVATE_HOTKEY } from '../labels'
import type { ClientMessage } from '../protocol'
import { useSwyvorn } from '../store'
import { Icon } from './Icon'
import { StopButton } from './StopButton'
import './BottomBar.css'

/** Предел протокола для send_text (docs/protocol.md §1.6). */
const MAX_TEXT = 4000
const COUNTER_FROM = MAX_TEXT - 400

/** Отправить команду; если связи нет — сказать об этом, а не молчать. */
function send(msg: ClientMessage): boolean {
  if (sendCommand(msg)) return true
  useSwyvorn.getState().addNotice('warning', 'Нет связи с ядром — команда не отправлена', 'not_sent')
  return false
}

function MicButton({ disabled }: { disabled: boolean }) {
  const listening = useSwyvorn((s) => s.state === 'listening')
  const hotkey = useSwyvorn((s) => s.info?.hotkeys.activate || DEFAULT_ACTIVATE_HOTKEY)
  return (
    <button
      type="button"
      className={listening ? 'icon-btn cmd__mic cmd__mic--live' : 'icon-btn cmd__mic'}
      aria-pressed={listening}
      aria-label={listening ? 'Слушаю — нажмите, чтобы закончить' : 'Говорить'}
      disabled={disabled}
      onClick={() => send({ type: 'mic', action: 'toggle' })}
      title={`Говорить (${hotkey}; удерживайте — говорить, пока держите)`}
    >
      <Icon name="mic" />
    </button>
  )
}

function MuteButton({ disabled }: { disabled: boolean }) {
  const muted = useSwyvorn((s) => s.muted)
  const hotkey = useSwyvorn((s) => s.info?.hotkeys.mute)
  const label = muted ? 'Включить микрофон' : 'Выключить микрофон'
  return (
    <button
      type="button"
      className={muted ? 'icon-btn mute mute--on' : 'icon-btn mute'}
      aria-pressed={muted}
      aria-label={label}
      disabled={disabled}
      onClick={() => send({ type: 'mute', muted: !muted })}
      title={`${label}${hotkey ? ` (${hotkey})` : ''}`}
    >
      <Icon name="micOff" />
    </button>
  )
}

function CommandInput({ disabled }: { disabled: boolean }) {
  const [text, setText] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)
  const canSend = !disabled && text.trim().length > 0

  const submit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault()
    const trimmed = text.trim()
    if (!trimmed) return
    if (!send({ type: 'send_text', text: trimmed })) return
    setText('')
    // Кнопка «Отправить» исчезает вместе с текстом — фокус возвращаем в поле, а не теряем.
    inputRef.current?.focus()
  }

  return (
    <form className={disabled ? 'cmd cmd--disabled' : 'cmd'} onSubmit={submit}>
      <input
        ref={inputRef}
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
        <span className={text.length >= MAX_TEXT ? 'cmd__count cmd__count--full mono' : 'cmd__count mono'}>
          {text.length}/{MAX_TEXT}
        </span>
      )}
      {canSend && (
        <button type="submit" className="cmd__send" aria-label="Отправить" title="Отправить (Enter)">
          <Icon name="send" />
        </button>
      )}
      <MicButton disabled={disabled} />
    </form>
  )
}

export function BottomBar() {
  const connected = useSwyvorn((s) => s.connection === 'connected')
  return (
    <footer className="bottombar">
      <div className="bottombar__center">
        {/* Пустой элемент той же ширины, что кнопка тишины, — поле остаётся точно по центру */}
        <span className="bottombar__balance" aria-hidden="true" />
        <CommandInput disabled={!connected} />
        <MuteButton disabled={!connected} />
      </div>
      <div className="bottombar__right">
        <StopButton />
      </div>
    </footer>
  )
}
