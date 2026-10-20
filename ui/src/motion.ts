// Системная настройка «уменьшить движение» Windows → store.reducedMotion, чтобы её
// учитывали и CSS-анимации HUD, и orb. Флаг «липкий», как и ui.reduced_motion из hello:
// выключить его можно только перезапуском, и это сознательно — анимации не вспыхнут посреди работы.

import { useJarvis } from './store'

const QUERY = '(prefers-reduced-motion: reduce)'

export function syncReducedMotionPreference(): void {
  if (typeof window.matchMedia !== 'function') return
  const mq = window.matchMedia(QUERY)
  const apply = () => {
    if (mq.matches) useJarvis.getState().setReducedMotion(true)
  }
  apply()
  mq.addEventListener('change', apply)
}
