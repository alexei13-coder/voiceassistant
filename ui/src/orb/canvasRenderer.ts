// Запасная отрисовка ядра на Canvas 2D — если WebGL2 недоступен (старый драйвер, удалённый рабочий стол).
// Упрощённая, но с теми же состояниями и той же композицией, что и шейдер: мягкая плазма-градиент,
// одно кольцо с дугами, отсчётом и прогрессом, редкие столбики и одна волна «говорю».

import {
  BAR_AUDIO_SPAN,
  BAR_COUNT,
  BAR_INNER,
  BAR_OUTER,
  BAR_WAVE_SPAN,
  barShape,
  COLLAPSED_SCALE,
  cometFade,
  RING_RADIUS,
  RIPPLE_END,
} from './orbGeometry'
import type { OrbFrame } from './orbModel'
import type { OrbTheme, Rgb } from './orbTheme'
import { layoutFor, type OrbLayout, type OrbRenderer } from './renderer'

const TAU = Math.PI * 2
const TOP = Math.PI / 2
/** На сколько отрезков режется хвост «кометы»: плавный градиент яркости без шейдера. */
const COMET_STEPS = 16

function rgba(c: Rgb, alpha: number): string {
  const a = Math.min(1, Math.max(0, alpha))
  return `rgba(${Math.round(c[0] * 255)}, ${Math.round(c[1] * 255)}, ${Math.round(c[2] * 255)}, ${a.toFixed(3)})`
}

function mixRgb(a: Rgb, b: Rgb, t: number): Rgb {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]
}

export function createCanvasRenderer(canvas: HTMLCanvasElement, theme: OrbTheme): OrbRenderer | null {
  const ctx = canvas.getContext('2d', { alpha: true })
  if (!ctx) return null
  let layout: OrbLayout = layoutFor({ width: canvas.width, height: canvas.height, pixelRatio: 1 })
  const amber = theme.states.awaiting_confirmation
  const red = theme.states.error
  const grey = theme.states.stopped

  /** Дуга по часовой от угла `from` (угол по часовой от «12»). Система координат — y вверх, как в шейдере. */
  const strokeArc = (radius: number, from: number, length: number, width: number, style: string) => {
    ctx.beginPath()
    ctx.arc(0, 0, radius, TOP - from, TOP - from - length, true)
    ctx.lineWidth = width
    ctx.strokeStyle = style
    ctx.stroke()
  }

  /** «Комета» на кольце: скруглённая голова под углом head, хвост длиной length растворяется. */
  const comet = (head: number, length: number, width: number, color: Rgb, alpha: number) => {
    const step = length / COMET_STEPS
    ctx.lineCap = 'butt'
    for (let i = 0; i < COMET_STEPS; i++) {
      const fade = cometFade((i + 0.5) / COMET_STEPS)
      strokeArc(RING_RADIUS, head - length + i * step, step, width, rgba(color, alpha * fade))
    }
    const a = TOP - head
    ctx.beginPath()
    ctx.arc(Math.cos(a) * RING_RADIUS, Math.sin(a) * RING_RADIUS, width / 2, 0, TAU)
    ctx.fillStyle = rgba(color, alpha)
    ctx.fill()
  }

  return {
    kind: 'canvas2d',
    resize(viewport) {
      layout = layoutFor(viewport)
    },
    render(f: OrbFrame) {
      ctx.setTransform(1, 0, 0, 1, 0, 0)
      ctx.clearRect(0, 0, canvas.width, canvas.height)
      const collapse = f.collapse
      const scale = layout.scale * (1 + (COLLAPSED_SCALE - 1) * collapse) * (1 + 0.012 * f.flash)
      ctx.setTransform(scale, 0, 0, -scale, layout.centerX, layout.centerY)
      ctx.globalCompositeOperation = 'lighter'

      const lw = (layout.line * layout.scale) / scale
      let color: Rgb = mixRgb(f.color, red, Math.min(1, f.flash * 0.6))
      color = mixRgb(color, grey, collapse * 0.85)
      const lines = f.energy * (1 - 0.45 * collapse)

      // Плазма: мягкий радиальный градиент со светлым, но не белым центром.
      const core = f.coreRadius
      const reach = core * 1.6
      const glow = ctx.createRadialGradient(0, 0, 0, 0, 0, reach)
      const boost = Math.min(1, f.coreBoost)
      glow.addColorStop(0, rgba(mixRgb(color, [1, 1, 1], 0.3), 0.92 * boost))
      glow.addColorStop(0.3, rgba(color, 0.78 * boost))
      glow.addColorStop(0.58, rgba(color, 0.6 * boost))
      glow.addColorStop(0.64, rgba(color, 0.14 * boost))
      glow.addColorStop(1, rgba(color, 0))
      ctx.fillStyle = glow
      ctx.beginPath()
      ctx.arc(0, 0, reach, 0, TAU)
      ctx.fill()

      // Говорю: одна волна от плазмы наружу.
      if (f.ripple > 0.001) {
        const t = f.rippleProgress
        const fade = (1 - t) * (1 - t) * Math.min(1, t / 0.12)
        strokeArc(core * 1.05 + (RIPPLE_END - core * 1.05) * t, 0, TAU, lw, rgba(color, 0.8 * f.ripple * fade * lines))
      }

      // Кольцо и дуги на нём.
      ctx.lineCap = 'butt'
      strokeArc(RING_RADIUS, 0, TAU, lw, rgba(color, 0.7 * f.ring * lines))
      if (f.arc > 0.001) comet(f.arcAngle, f.arcLength, lw * 1.5, color, f.arc * lines)
      if (f.arcPair > 0.001) comet(f.arcAngle + Math.PI, f.arcPairLength, lw * 1.5, color, f.arcPair * lines)
      if (f.countdown > 0.001 && f.countdownFraction > 0.002) {
        ctx.lineCap = f.countdownFraction < 1 ? 'round' : 'butt'
        const alpha = f.countdown * (1 - 0.45 * collapse)
        strokeArc(RING_RADIUS, 0, f.countdownFraction * TAU, lw * 1.5, rgba(amber, alpha))
      }
      if (f.chase > 0.001) comet(f.chaseHead, f.chaseLength, lw * 1.5, color, f.chase * lines)

      // Столбики: тонкие лучи, к кончику тускнеют.
      if (f.bars > 0.001) {
        ctx.beginPath()
        for (let i = 0; i < BAR_COUNT; i++) {
          const shape = barShape(i, f.barPhase)
          const len = f.barBase + f.barAudio * shape.audio * BAR_AUDIO_SPAN + f.barWave * shape.wave * BAR_WAVE_SPAN
          const r1 = BAR_INNER + Math.min(len, BAR_OUTER - BAR_INNER)
          const a = (i / BAR_COUNT) * TAU
          ctx.moveTo(Math.cos(a) * BAR_INNER, Math.sin(a) * BAR_INNER)
          ctx.lineTo(Math.cos(a) * r1, Math.sin(a) * r1)
        }
        const alpha = 0.85 * f.bars * lines
        const fade = ctx.createRadialGradient(0, 0, BAR_INNER, 0, 0, BAR_INNER + BAR_AUDIO_SPAN)
        fade.addColorStop(0, rgba(color, alpha))
        fade.addColorStop(1, rgba(color, 0.3 * alpha))
        ctx.lineCap = 'round'
        ctx.lineWidth = lw
        ctx.strokeStyle = fade
        ctx.stroke()
      }

      ctx.lineCap = 'butt'
      ctx.globalCompositeOperation = 'source-over'
    },
    dispose() {
      ctx.setTransform(1, 0, 0, 1, 0, 0)
      ctx.clearRect(0, 0, canvas.width, canvas.height)
    },
  }
}
