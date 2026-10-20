// Всплывающие уведомления справа сверху. info/warning живут 6 с, error — 10 с.

import { memo, useEffect } from 'react'
import { useJarvis, type Notice } from '../store'
import { Icon, type IconName } from './Icon'
import './Notices.css'

const LIFETIME_MS: Record<Notice['level'], number> = { info: 6000, warning: 6000, error: 10_000 }
const ICONS: Record<Notice['level'], IconName> = { info: 'info', warning: 'warning', error: 'error' }

const Toast = memo(function Toast({ notice }: { notice: Notice }) {
  const { id, level } = notice
  useEffect(() => {
    // Отсчёт от момента создания: перерисовка списка не продлевает жизнь уведомлению.
    const left = Math.max(0, notice.createdAt + LIFETIME_MS[level] - Date.now())
    const timer = setTimeout(() => useJarvis.getState().dismissNotice(id), left)
    return () => clearTimeout(timer)
  }, [id, level, notice.createdAt])

  return (
    <li className={`toast toast--${level}`} role={level === 'error' ? 'alert' : 'status'}>
      <Icon name={ICONS[level]} className="toast__icon" />
      <p className="toast__text">{notice.text}</p>
      <button type="button" className="toast__close" onClick={() => useJarvis.getState().dismissNotice(id)} aria-label="Закрыть уведомление">
        <Icon name="close" />
      </button>
    </li>
  )
})

export function Notices() {
  const notices = useJarvis((s) => s.notices)
  if (notices.length === 0) return null
  return (
    <ol className="toasts" aria-label="Уведомления">
      {notices.map((n) => (
        <Toast key={n.id} notice={n} />
      ))}
    </ol>
  )
}
