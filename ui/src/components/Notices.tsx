// Небольшие уведомления справа сверху, под панелью. info/warning живут 6 с, error — 10 с.
// Уровень передаёт тонкая цветная линия слева и роль (status/alert) для диктора.

import { memo, useEffect } from 'react'
import { useSwyvorn, type Notice } from '../store'
import { Icon } from './Icon'
import './Notices.css'

const LIFETIME_MS: Record<Notice['level'], number> = { info: 6000, warning: 6000, error: 10_000 }

const Toast = memo(function Toast({ notice }: { notice: Notice }) {
  const { id, level } = notice
  useEffect(() => {
    // Отсчёт от момента создания: перерисовка списка не продлевает жизнь уведомлению.
    const left = Math.max(0, notice.createdAt + LIFETIME_MS[level] - Date.now())
    const timer = setTimeout(() => useSwyvorn.getState().dismissNotice(id), left)
    return () => clearTimeout(timer)
  }, [id, level, notice.createdAt])

  return (
    <li className={`toast toast--${level}`} role={level === 'error' ? 'alert' : 'status'}>
      <p className="toast__text">{notice.text}</p>
      <button type="button" className="toast__close" onClick={() => useSwyvorn.getState().dismissNotice(id)} aria-label="Закрыть уведомление">
        <Icon name="close" />
      </button>
    </li>
  )
})

export function Notices() {
  const notices = useSwyvorn((s) => s.notices)
  if (notices.length === 0) return null
  return (
    <ol className="toasts" aria-label="Уведомления">
      {notices.map((n) => (
        <Toast key={n.id} notice={n} />
      ))}
    </ol>
  )
}
