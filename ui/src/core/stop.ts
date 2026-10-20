// Кнопка «Стоп» (docs/protocol.md §3). Обычный стоп идёт ядру по WebSocket; если ядро
// недоступно или молчит, либо «Стоп» нажат дважды за 2 с — аварийный стоп через оболочку.

import { emergencyStop } from '../platform/tauri'
import { useJarvis } from '../store'
import { sendCommand } from './connection'

export const STOP_ACK_TIMEOUT_MS = 1000
export const DOUBLE_PRESS_WINDOW_MS = 2000

export type EmergencyReason = 'not_connected' | 'no_ack' | 'double_press'

export interface StopDeps {
  /** Отправить ядру `stop`; false — связи нет. */
  send: () => boolean
  /** Пришло ли от ядра `stopped` или смена состояния начиная с момента `since` (Date.now()). */
  acknowledgedSince: (since: number) => boolean
  emergency: (reason: EmergencyReason) => void
  now?: () => number
}

export interface StopController {
  press: () => 'sent' | 'emergency'
  dispose: () => void
}

export function createStopController(deps: StopDeps): StopController {
  const now = deps.now ?? Date.now
  let lastPressAt = Number.NEGATIVE_INFINITY
  let watchdog: ReturnType<typeof setTimeout> | null = null

  const clearWatchdog = () => {
    if (watchdog !== null) clearTimeout(watchdog)
    watchdog = null
  }

  return {
    press() {
      const pressedAt = now()
      const isDouble = pressedAt - lastPressAt <= DOUBLE_PRESS_WINDOW_MS
      clearWatchdog()
      if (isDouble) {
        // Третье нажатие подряд снова считается первым, а не новым двойным.
        lastPressAt = Number.NEGATIVE_INFINITY
        deps.emergency('double_press')
        return 'emergency'
      }
      lastPressAt = pressedAt
      if (!deps.send()) {
        deps.emergency('not_connected')
        return 'emergency'
      }
      watchdog = setTimeout(() => {
        watchdog = null
        if (!deps.acknowledgedSince(pressedAt)) deps.emergency('no_ack')
      }, STOP_ACK_TIMEOUT_MS)
      return 'sent'
    },
    dispose: clearWatchdog,
  }
}

// ---------- подключение к приложению ----------

const EMERGENCY_NOTICES: Record<EmergencyReason, string> = {
  not_connected: 'Нет связи с ядром — аварийный стоп',
  no_ack: 'Ядро не ответило на «Стоп» — аварийный стоп',
  double_press: 'Двойной «Стоп» — аварийная остановка ядра',
}

let emergencyInFlight = false

async function runEmergencyStop(reason: EmergencyReason): Promise<void> {
  // Пока оболочка перезапускает ядро, повторные вызовы ничего не добавят.
  if (emergencyInFlight) return
  emergencyInFlight = true
  const { addNotice } = useJarvis.getState()
  try {
    const supported = await emergencyStop()
    if (supported) addNotice('warning', `${EMERGENCY_NOTICES[reason]}: ядро перезапускается`, 'emergency_stop')
    else addNotice('warning', 'Аварийный стоп доступен только в приложении', 'emergency_unavailable')
  } catch (err) {
    addNotice('error', `Аварийный стоп не удался: ${String(err)}`, 'emergency_failed')
  } finally {
    emergencyInFlight = false
  }
}

export const stopController = createStopController({
  send: () => sendCommand({ type: 'stop', source: 'button' }),
  acknowledgedSince: (since) => {
    const { lastStop, stateChangedAt } = useJarvis.getState()
    return (lastStop !== null && lastStop.at >= since) || stateChangedAt >= since
  },
  emergency: (reason) => void runEmergencyStop(reason),
})
