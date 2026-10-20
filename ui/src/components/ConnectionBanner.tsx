// Полоса под верхней панелью: нет связи, неверный токен, падение или перезапуск ядра.

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
  // Пока идёт переподключение — крутящаяся иконка, при ошибке доступа или фатале — знак ошибки.
  const retrying = connection === 'disconnected' || coreProcess === 'restarting' || coreProcess === 'crashed'
  return (
    <div className={`banner banner--${banner.level}`} role="alert">
      <Icon name={retrying ? 'spinner' : 'error'} className={retrying ? 'spin' : undefined} />
      {banner.text}
    </div>
  )
}
