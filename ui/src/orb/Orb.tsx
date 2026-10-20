// Анимированное ядро HUD. Компонент лишь владеет <canvas> и жизненным циклом движка;
// кадры рисуются вне React (см. orbEngine.ts), поэтому ре-рендеров на кадр нет.

import { type CSSProperties, useEffect, useRef, useState } from 'react'
import { type OrbStats, startOrbEngine } from './orbEngine'
import type { OrbRendererKind } from './renderer'

export type { OrbStats } from './orbEngine'

/** Ручки для orb-lab. В HUD не используются. */
export interface OrbLabOptions {
  /** Заморозить время анимации (секунды): кадр зависит только от состояния — для скриншотов. */
  frozenTime?: number
  /** Начать с указанной отрисовки (проверка запасного Canvas 2D). */
  renderer?: OrbRendererKind
  onStats?: (stats: OrbStats) => void
}

export interface OrbProps {
  className?: string
  lab?: OrbLabOptions
}

// Холст заполняет контейнер; позиционирование (absolute и т. п.) — забота className.
const CANVAS_STYLE: CSSProperties = { display: 'block', width: '100%', height: '100%' }

export function Orb({ className, lab }: OrbProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [kind, setKind] = useState<OrbRendererKind>(lab?.renderer ?? 'webgl2')
  const labRef = useRef(lab)
  useEffect(() => {
    labRef.current = lab
  })
  const frozenTime = lab?.frozenTime
  const wantsStats = lab?.onStats !== undefined

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    return startOrbEngine(canvas, {
      kind,
      frozenTime,
      onStats: wantsStats ? (stats) => labRef.current?.onStats?.(stats) : undefined,
      // Холст с контекстом WebGL нельзя переиспользовать под 2D: key ниже пересоздаёт элемент.
      onUnsupported: () => setKind('canvas2d'),
    })
  }, [kind, frozenTime, wantsStats])

  return <canvas key={kind} ref={canvasRef} className={className} style={CANVAS_STYLE} aria-hidden="true" />
}
