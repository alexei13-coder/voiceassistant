// Секция «ПАМЯТЬ»: что ассистент помнит о пользователе между запусками (docs/brain.md).
// Факт — строка «ключ — значение» с крестиком; «забыть всё» срабатывает только со второго
// нажатия, пока горит «точно забыть?». Пустая память по умолчанию свёрнута.

import { memo, useEffect, useState } from 'react'
import { sendOrNotify } from '../core/commands'
import { formatFullDate, formatTimeShort } from '../format'
import { memoryKeyLabel } from '../labels'
import type { MemoryFact } from '../protocol'
import { useSwyvorn } from '../store'
import { Icon } from './Icon'
import { Section } from './Section'
import './MemoryPanel.css'

/** Сколько ждать второго нажатия «забыть всё». */
const CLEAR_CONFIRM_MS = 4000

const FactItem = memo(function FactItem({ fact }: { fact: MemoryFact }) {
  const label = memoryKeyLabel(fact.key)
  const updated = new Date(fact.updated_at)
  return (
    <li className="fact" title={`${fact.key} · запомнено ${formatFullDate(updated)}, ${formatTimeShort(fact.updated_at)}`}>
      <p className="fact__text">
        <span className="fact__key">{label}</span>
        <span className="fact__sep"> — </span>
        {fact.value}
      </p>
      <button
        type="button"
        className="fact__delete"
        aria-label={`Забыть: ${label}`}
        title="Забыть"
        onClick={() => sendOrNotify({ type: 'memory_delete', key: fact.key })}
      >
        <Icon name="close" />
      </button>
    </li>
  )
})

function ForgetAllButton() {
  const [armed, setArmed] = useState(false)

  useEffect(() => {
    if (!armed) return
    const timer = setTimeout(() => setArmed(false), CLEAR_CONFIRM_MS)
    return () => clearTimeout(timer)
  }, [armed])

  const onClick = () => {
    if (!armed) {
      setArmed(true)
      return
    }
    setArmed(false)
    sendOrNotify({ type: 'memory_clear' })
  }

  return (
    <button
      type="button"
      className={armed ? 'section__tool mem__clear mem__clear--armed' : 'section__tool mem__clear'}
      onClick={onClick}
      title={armed ? 'Нажмите ещё раз, чтобы стереть всю память' : 'Стереть всю долговременную память'}
    >
      {armed ? 'точно забыть?' : 'забыть всё'}
    </button>
  )
}

export function MemoryPanel() {
  const facts = useSwyvorn((s) => s.memory)
  /** null — пользователь секцию не трогал: раскрыта, когда есть что показать. */
  const [userOpen, setUserOpen] = useState<boolean | null>(null)
  const open = userOpen ?? facts.length > 0

  return (
    <Section
      title="Память"
      className="mem"
      aside={facts.length > 0 ? facts.length : undefined}
      tools={open && facts.length > 0 ? <ForgetAllButton /> : undefined}
      collapse={{ open, onToggle: () => setUserOpen(!open) }}
    >
      {facts.length === 0 ? (
        <p className="mem__empty">Пока ничего не запомнил</p>
      ) : (
        <ul className="mem__list fade-scroll" aria-label="Факты памяти">
          {facts.map((fact) => (
            <FactItem key={fact.key} fact={fact} />
          ))}
        </ul>
      )}
    </Section>
  )
}
