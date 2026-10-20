// «СТОП» — всегда на виду. Логика обычного и аварийного стопа — в core/stop.ts.

import { useState } from 'react'
import { stopController } from '../core/stop'
import { formatHotkey } from '../format'
import { DEFAULT_STOP_HOTKEY } from '../labels'
import { useJarvis } from '../store'
import { Icon } from './Icon'

interface Pulse {
  seq: number
  emergency: boolean
}

export function StopButton() {
  const hotkey = useJarvis((s) => s.info?.hotkeys.stop || DEFAULT_STOP_HOTKEY)
  // seq как key перезапускает CSS-вспышку при каждом нажатии
  const [pulse, setPulse] = useState<Pulse | null>(null)

  const onClick = () => {
    const result = stopController.press()
    setPulse((p) => ({ seq: (p?.seq ?? 0) + 1, emergency: result === 'emergency' }))
  }

  return (
    <button
      type="button"
      className="stop"
      onClick={onClick}
      title={`Остановить всё (${hotkey}). Двойное нажатие — аварийная остановка ядра`}
    >
      {pulse && (
        <span key={pulse.seq} className={pulse.emergency ? 'stop__flash stop__flash--emergency' : 'stop__flash'} aria-hidden="true" />
      )}
      <Icon name="stop" className="stop__icon" />
      <span className="stop__label">СТОП</span>
      <kbd className="stop__kbd">{formatHotkey(hotkey)}</kbd>
    </button>
  )
}
