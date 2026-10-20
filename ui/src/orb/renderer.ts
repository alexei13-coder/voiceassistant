// Общий интерфейс отрисовки ядра: WebGL2 (основная) и Canvas 2D (запасная, если WebGL2 нет).

import { HALF_SIDE_IN_R } from './orbGeometry'
import type { OrbFrame } from './orbModel'

export type OrbRendererKind = 'webgl2' | 'canvas2d'

export interface OrbRenderer {
  readonly kind: OrbRendererKind
  /** Размер подложки уже выставлен движком; рендерер лишь пересчитывает свою геометрию. */
  resize(viewport: OrbViewport): void
  render(frame: OrbFrame): void
  dispose(): void
}

export interface OrbViewport {
  /** Размер подложки, px устройства. */
  width: number
  height: number
  /** px устройства на 1 CSS px (уже с ограничением сверху). */
  pixelRatio: number
}

export interface OrbLayout {
  centerX: number
  centerY: number
  /** R в px устройства. */
  scale: number
  /** Квадрат отрисовки (px устройства). */
  squareX: number
  squareY: number
  squareSize: number
  /** Базовая толщина линии («1 CSS px», чуть растёт на больших ядрах) в долях R. */
  line: number
}

/** Квадрат по центру холста: ядро всегда круглое, лишняя площадь остаётся прозрачной. */
export function layoutFor({ width, height, pixelRatio }: OrbViewport): OrbLayout {
  const side = Math.min(width, height)
  const squareSize = Math.max(1, Math.floor(side))
  const scale = side / 2 / HALF_SIDE_IN_R
  const cssSide = side / pixelRatio
  const lineCss = Math.min(1.6, Math.max(0.85, cssSide / 640))
  return {
    centerX: width / 2,
    centerY: height / 2,
    scale,
    squareX: Math.floor((width - squareSize) / 2),
    squareY: Math.floor((height - squareSize) / 2),
    squareSize,
    line: (lineCss * pixelRatio) / scale,
  }
}
