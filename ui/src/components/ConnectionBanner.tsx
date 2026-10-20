// Тонкая строка под верхней панелью: нет связи, неверный токен, падение или перезапуск ядра.

import { connectionBanner } from '../labels'
import { useSwyvorn } from '../store'
import { Icon } from './Icon'
import './Notices.css'

export function ConnectionBanner() {
  const connection = useSwyvorn((s) => s.connection)
  const coreProcess = useSwyvorn((s) => s.coreProcess)
  const coreMessage = useSwyvorn((s) => s.coreProcessMessage)
  const banner = connectionBanner(connection, coreProcess, coreMessage)
  if (!banner) return null
  // Пока идёт переподключение — маленький индикатор вращения, при ошибке доступа или фатале — только текст.
  const retrying = connection === 'disconnected' || coreProcess === 'restarting' || coreProcess === 'crashed'
  return (
    <div className={`banner banner--${banner.level}`} role="alert">
      {retrying && <Icon name="spinner" className="spin" />}
      <span className="banner__text">{banner.text}</span>
    </div>
  )
}
