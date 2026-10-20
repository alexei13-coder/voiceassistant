// Диалог подтверждения рискованного действия. Безопасность важнее удобства:
// фокус по умолчанию на «Отмена» (Enter не подтверждает), Esc = отмена,
// «Да» становится активной не сразу — случайный клик по появившемуся окну не пройдёт.

import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react'
import { sendCommand } from '../core/connection'
import type { ConfirmationRequest } from '../protocol'
import { useSwyvorn } from '../store'
import { Icon } from './Icon'
import './ConfirmDialog.css'

/** Через сколько после появления можно нажать «Да». */
const ARM_DELAY_MS = 600
/** Если ядро не закрыло вопрос после ответа (например, устаревший nonce) — снова даём ответить. */
const RESPONSE_RETRY_MS = 2500

const LANGUAGE_LABELS: Record<NonNullable<ConfirmationRequest['command_language']>, string> = {
  powershell: 'PowerShell',
}

/**
 * Обратный отсчёт без перерисовок React: линия и секунды обновляются в requestAnimationFrame.
 * Линия позиционируется абсолютно — по верхнему краю карточки, секунды стоят в подвале.
 */
function Countdown({ expiresAt, timeoutMs }: { expiresAt: number | null; timeoutMs: number }) {
  const barRef = useRef<HTMLDivElement>(null)
  const secondsRef = useRef<HTMLSpanElement>(null)

  useLayoutEffect(() => {
    if (expiresAt === null) return
    let frame = 0
    let shownSeconds = -1
    const update = () => {
      const remaining = Math.max(0, expiresAt - Date.now())
      const fraction = timeoutMs > 0 ? Math.min(1, remaining / timeoutMs) : 0
      if (barRef.current) barRef.current.style.transform = `scaleX(${fraction})`
      const seconds = Math.ceil(remaining / 1000)
      if (seconds !== shownSeconds && secondsRef.current) {
        secondsRef.current.textContent = `${seconds} с`
        shownSeconds = seconds
      }
      if (remaining > 0) frame = requestAnimationFrame(update)
    }
    update()
    return () => cancelAnimationFrame(frame)
  }, [expiresAt, timeoutMs])

  if (expiresAt === null) {
    return (
      <div className="countdown countdown--pending">
        <div className="countdown__line" aria-hidden="true" />
        <span className="countdown__speaking">Озвучиваю вопрос…</span>
      </div>
    )
  }
  return (
    <div className="countdown">
      <div className="countdown__line" aria-hidden="true">
        <div className="countdown__bar" ref={barRef} />
      </div>
      <span className="countdown__label">Осталось</span>
      <span className="countdown__seconds mono" ref={secondsRef} role="timer" aria-label="Осталось времени на ответ" />
    </div>
  )
}

function focusableIn(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>('button:not(:disabled), [tabindex]:not([tabindex="-1"])'))
}

function ConfirmCard({ request }: { request: ConfirmationRequest }) {
  const titleId = useId()
  const dialogRef = useRef<HTMLDivElement>(null)
  const [armed, setArmed] = useState(false)
  const [responded, setResponded] = useState(false)

  useEffect(() => {
    const timer = setTimeout(() => setArmed(true), ARM_DELAY_MS)
    return () => clearTimeout(timer)
  }, [])

  useEffect(() => {
    if (!responded) return
    const timer = setTimeout(() => setResponded(false), RESPONSE_RETRY_MS)
    return () => clearTimeout(timer)
  }, [responded])

  // После закрытия возвращаем фокус туда, где он был (например, в поле ввода).
  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null
    return () => previous?.focus()
  }, [])

  const { action_id: actionId, nonce } = request
  const respond = useCallback(
    (decision: 'yes' | 'no') => {
      if (responded) return
      if (!sendCommand({ type: 'confirm', action_id: actionId, nonce, decision })) {
        useSwyvorn.getState().addNotice('error', 'Нет связи с ядром — ответ не отправлен', 'confirm_not_sent')
        return
      }
      setResponded(true)
    },
    [responded, actionId, nonce],
  )

  // Esc ловим на уровне документа: фокус может оказаться вне диалога (клик по ленте и т. п.).
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key !== 'Escape' || e.ctrlKey || e.altKey || e.metaKey) return
      e.preventDefault()
      respond('no')
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [respond])

  // Tab не выходит за пределы диалога, пока он открыт.
  const trapTab = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'Tab' || !dialogRef.current) return
    const items = focusableIn(dialogRef.current)
    if (items.length === 0) return
    const first = items[0]
    const last = items[items.length - 1]
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault()
      last.focus()
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault()
      first.focus()
    }
  }

  const language = request.command_language ? LANGUAGE_LABELS[request.command_language] : null

  return (
    <div className="confirm" role="alertdialog" aria-modal="true" aria-labelledby={titleId} ref={dialogRef} onKeyDown={trapTab}>
      <header className="confirm__head">
        <span className="confirm__kicker">Требуется подтверждение</span>
        {request.demo && <span className="confirm__demo">демо — ничего не будет выполнено</span>}
      </header>

      <h3 className="confirm__title" id={titleId}>
        {request.title}
      </h3>

      <div className="confirm__body fade-scroll">
        {request.details.length > 0 && (
          <section className="confirm__section">
            <h4 className="confirm__label">
              Объекты <span className="mono">{request.details.length}</span>
            </h4>
            <ul className="confirm__details" tabIndex={0}>
              {request.details.map((d, i) => (
                <li key={i}>{d}</li>
              ))}
            </ul>
          </section>
        )}

        {request.command !== null && (
          <section className="confirm__section">
            <h4 className="confirm__label">
              Команда {language && <span className="confirm__lang">{language}</span>}
            </h4>
            <pre className="confirm__command" tabIndex={0}>
              <code>{request.command}</code>
            </pre>
          </section>
        )}

        {request.code_analysis.length > 0 && (
          <section className="confirm__section">
            <h4 className="confirm__label">Анализ кода</h4>
            <ul className="confirm__analysis">
              {request.code_analysis.map((line, i) => (
                <li key={i}>
                  <Icon name="check" />
                  {line}
                </li>
              ))}
            </ul>
          </section>
        )}

        {request.model_explanation && (
          <section className="confirm__section confirm__model">
            <h4 className="confirm__label">Объяснение модели — может быть неточным</h4>
            <p>{request.model_explanation}</p>
          </section>
        )}
      </div>

      <div className="confirm__footer">
        <div className="confirm__status">
          <Countdown expiresAt={request.expires_at} timeoutMs={request.timeout_ms} />
          {request.button_only && (
            <p className="confirm__button-only">Голосового „да“ недостаточно — подтвердите кнопкой</p>
          )}
        </div>
        <div className="confirm__actions">
          <button type="button" className="btn btn--ghost" autoFocus disabled={responded} onClick={() => respond('no')}>
            Отмена <kbd className="btn__kbd">Esc</kbd>
          </button>
          <button type="button" className="btn btn--amber" disabled={!armed || responded} onClick={() => respond('yes')}>
            Да, выполнить
          </button>
        </div>
      </div>
    </div>
  )
}

export function ConfirmDialog() {
  const confirmation = useSwyvorn((s) => s.confirmation)
  if (!confirmation) return null
  // key: новый вопрос — новый диалог (фокус снова на «Отмена», задержка «Да» заново)
  return <ConfirmCard key={confirmation.action_id} request={confirmation} />
}
