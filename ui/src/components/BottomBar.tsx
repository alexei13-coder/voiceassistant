// Нижняя панель: одно поле команды по центру (микрофон внутри справа, тишина рядом) и «Стоп» справа.
// Сетка колонок совпадает с основной, чтобы поле стояло точно под ядром. Пока у Claude нет ключа,
// над полем — тонкая строка, куда его вписать.

import { useRef, useState, type FormEvent } from 'react'
import { sendOrNotify } from '../core/commands'
import { API_KEY_FILE, API_KEY_LINE, DEFAULT_ACTIVATE_HOTKEY, needsApiKey } from '../labels'
import { useSwyvorn } from '../store'
import { Icon } from './Icon'
import { StopButton } from './StopButton'
import './BottomBar.css'

/** Предел протокола для send_text (docs/protocol.md §1.6). */
const MAX_TEXT = 4000
const COUNTER_FROM = MAX_TEXT - 400

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
      onClick={() => sendOrNotify({ type: 'mic', action: 'toggle' })}
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
      onClick={() => sendOrNotify({ type: 'mute', muted: !muted })}
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
    if (!sendOrNotify({ type: 'send_text', text: trimmed })) return
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

function ApiKeyHint() {
  const status = useSwyvorn((s) => (s.connection === 'connected' ? s.brain?.status : undefined))
  if (!needsApiKey(status)) return null
  const invalid = status === 'invalid_key'
  return (
    <p
      className="cmd-hint"
      title={`${invalid ? 'Ключ API не подошёл' : 'Ключ API не задан'}: ${API_KEY_LINE} в ${API_KEY_FILE}. Перезапуск не нужен — просто напишите сообщение.`}
    >
      <span className={invalid ? 'cmd-hint__dot cmd-hint__dot--invalid' : 'cmd-hint__dot'} aria-hidden="true" />
      {/* Короткая версия, чтобы путь помещался и в узком окне; строка с ключом — в подсказке и в ленте */}
      {invalid ? 'Ключ не подошёл — замените его в ' : 'Нет ключа API — добавьте его в '}
      <span className="mono">{API_KEY_FILE}</span>
    </p>
  )
}

export function BottomBar() {
  const connected = useSwyvorn((s) => s.connection === 'connected')
  return (
    <footer className="bottombar">
      <div className="bottombar__center">
        <ApiKeyHint />
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
