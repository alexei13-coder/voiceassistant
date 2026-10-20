// Запасная отрисовка ядра на Canvas 2D — если WebGL2 недоступен (старый драйвер, удалённый рабочий стол).
// Упрощённая, но с теми же состояниями: плазма-градиент, кольца, дуги, столбики, отсчёт, прогресс.

import {
  ARC_DASH_DUTY,
  ARC_RADIUS_A,
  ARC_RADIUS_B,
  ARCS_A,
  ARCS_B,
  BAR_AUDIO_SPAN,
  BAR_COUNT,
  BAR_INNER,
  BAR_OUTER,
  BAR_WAVE_SPAN,
  barShape,
  COLLAPSED_SCALE,
  COUNTDOWN_RADIUS,
  DIAL_RADIUS,
  DIAL_TICKS,
  PARTICLE_COUNT,
  RING_RADIUS,
  RING_TICKS,
  RIPPLE_STEP,
  THINK_INNER,
  THINK_OUTER,
} from './orbGeometry'
import type { OrbFrame } from './orbModel'
import type { OrbTheme, Rgb } from './orbTheme'
import { layoutFor, type OrbLayout, type OrbRenderer } from './renderer'

const TAU = Math.PI * 2
const TOP = Math.PI / 2

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

  /** Окружность или дуга по часовой от «12 часов» (система координат — y вверх, как в шейдере). */
  const strokeArc = (radius: number, from: number, length: number, width: number, style: string) => {
    ctx.beginPath()
    ctx.arc(0, 0, radius, from, from - length, true)
    ctx.lineWidth = width
    ctx.strokeStyle = style
    ctx.stroke()
  }

  const radialTicks = (count: number, angle: number, r0: (i: number) => number, r1: (i: number) => number) => {
    ctx.beginPath()
    for (let i = 0; i < count; i++) {
      const a = angle + (i / count) * TAU
      const cos = Math.cos(a)
      const sin = Math.sin(a)
      ctx.moveTo(cos * r0(i), sin * r0(i))
      ctx.lineTo(cos * r1(i), sin * r1(i))
    }
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
      const scale = layout.scale * (1 + (COLLAPSED_SCALE - 1) * collapse) * (1 + 0.03 * f.flash)
      ctx.setTransform(scale, 0, 0, -scale, layout.centerX, layout.centerY)
      ctx.globalCompositeOperation = 'lighter'
      ctx.lineCap = 'butt'

      const lw = (layout.line * layout.scale) / scale
      let color: Rgb = mixRgb(f.color, red, Math.min(1, f.flash * 0.75))
      color = mixRgb(color, grey, collapse * 0.85)
      const rings = f.energy * (1 - 0.55 * collapse)

      // Плазма: радиальный градиент с горячим центром.
      const core = f.coreRadius
      const glow = ctx.createRadialGradient(0, 0, 0, 0, 0, core * 1.9)
      const boost = Math.min(1, f.coreBoost)
      glow.addColorStop(0, rgba(mixRgb(color, [1, 1, 1], 0.55), 0.95 * boost))
      glow.addColorStop(0.3, rgba(color, 0.75 * boost))
      glow.addColorStop(0.52, rgba(color, 0.4 * boost))
      glow.addColorStop(0.56, rgba(color, 0.18 * boost))
      glow.addColorStop(1, rgba(color, 0))
      ctx.fillStyle = glow
      ctx.beginPath()
      ctx.arc(0, 0, core * 1.9, 0, TAU)
      ctx.fill()

      // Говорю: волны от ядра (пики той же синусоиды, что в шейдере).
      if (f.ripple > 0.001) {
        const first = (RIPPLE_STEP * (f.ripplePhase + Math.PI / 2)) / TAU
        for (let r = first; r < DIAL_RADIUS; r += RIPPLE_STEP) {
          if (r <= core) continue
          const fade = 1 - Math.min(1, Math.max(0, (r - 0.3) / (DIAL_RADIUS - 0.3)))
          strokeArc(r, 0, TAU, lw, rgba(color, 0.3 * f.ripple * fade))
        }
      }

      // Внутреннее кольцо и 72 деления.
      strokeArc(RING_RADIUS, 0, TAU, lw * 1.1, rgba(color, 0.8 * rings))
      radialTicks(
        RING_TICKS,
        f.ringAngle,
        (i) => RING_RADIUS - 0.004 - (i % 6 === 0 ? 0.02 : 0.009),
        () => RING_RADIUS - 0.004,
      )
      ctx.lineWidth = lw
      ctx.strokeStyle = rgba(color, 0.6 * rings)
      ctx.stroke()

      // Сегментные дуги. Мелкие штрихи (шаг < 7 px) рисуются сплошной линией потусклее — как в шейдере.
      for (const [start, length, dash] of ARCS_A) {
        const dashed = dash > 0 && dash * ARC_RADIUS_A * scale >= 7
        const dim = dash > 0 && !dashed ? ARC_DASH_DUTY * 0.85 : 1
        ctx.setLineDash(dashed ? [dash * ARC_DASH_DUTY * ARC_RADIUS_A, dash * (1 - ARC_DASH_DUTY) * ARC_RADIUS_A] : [])
        ctx.beginPath()
        ctx.arc(0, 0, ARC_RADIUS_A, f.arcAngleA + start, f.arcAngleA + start + length)
        ctx.lineWidth = lw * 2.7
        ctx.strokeStyle = rgba(color, 0.9 * dim * rings)
        ctx.stroke()
      }
      ctx.setLineDash([])
      for (const [start, length] of ARCS_B) {
        ctx.beginPath()
        ctx.arc(0, 0, ARC_RADIUS_B, f.arcAngleB + start, f.arcAngleB + start + length)
        ctx.lineWidth = lw
        ctx.strokeStyle = rgba(color, 0.75 * rings)
        ctx.stroke()
      }

      // Столбики-эквалайзер.
      radialTicks(
        BAR_COUNT,
        0,
        () => BAR_INNER,
        (i) => {
          const shape = barShape(i, f.barPhase)
          const len = f.barBase + f.barAudio * shape.audio * BAR_AUDIO_SPAN + f.barWave * shape.wave * BAR_WAVE_SPAN
          return BAR_INNER + Math.min(len, BAR_OUTER - BAR_INNER)
        },
      )
      ctx.lineWidth = 0.32 * ((TAU * BAR_INNER) / BAR_COUNT)
      ctx.strokeStyle = rgba(color, 0.85 * rings)
      ctx.stroke()

      // Отсчёт подтверждения и прогресс выполнения — на одном радиусе.
      if (f.countdown > 0.001) {
        const alpha = f.countdown * (1 - 0.55 * collapse)
        strokeArc(COUNTDOWN_RADIUS, 0, TAU, lw, rgba(amber, 0.18 * alpha))
        strokeArc(COUNTDOWN_RADIUS, TOP, f.countdownFraction * TAU, lw * 2.4, rgba(amber, 0.95 * alpha))
      }
      if (f.chase > 0.001) {
        const tail = TOP - f.chaseHead + f.chaseLength
        strokeArc(COUNTDOWN_RADIUS, tail, f.chaseLength, lw * 2, rgba(color, 0.9 * f.chase * rings))
      }

      // Лимб.
      strokeArc(DIAL_RADIUS, 0, TAU, lw * 0.9, rgba(color, 0.4 * rings))
      radialTicks(
        DIAL_TICKS,
        f.dialAngle,
        () => DIAL_RADIUS + 0.004,
        (i) => DIAL_RADIUS + 0.004 + (i % 5 === 0 ? 0.015 : 0.006),
      )
      ctx.lineWidth = lw * 0.9
      ctx.strokeStyle = rgba(color, 0.4 * rings)
      ctx.stroke()

      // Думаю: развёртка и частицы.
      if (f.sweep > 0.001 && typeof ctx.createConicGradient === 'function') {
        // Ведущий край — там же, где в шейдере; хвост тянется против часовой стрелки.
        const cone = ctx.createConicGradient(TOP - f.sweepAngle, 0, 0)
        cone.addColorStop(0, rgba(color, 0.2 * f.sweep * rings))
        cone.addColorStop(0.04, rgba(color, 0.08 * f.sweep * rings))
        cone.addColorStop(0.3, rgba(color, 0))
        cone.addColorStop(1, rgba(color, 0))
        ctx.fillStyle = cone
        ctx.beginPath()
        ctx.arc(0, 0, THINK_OUTER, 0, TAU)
        ctx.arc(0, 0, THINK_INNER, 0, TAU, true)
        ctx.fill()
      }
      if (f.particles > 0.001) {
        ctx.fillStyle = rgba(mixRgb(color, [1, 1, 1], 0.4), f.particles * rings)
        ctx.beginPath()
        const pd = f.particleData
        for (let i = 0; i < PARTICLE_COUNT; i++) {
          // Мерцание в 2D упрощено до «видна / не видна».
          if (pd[i * 4 + 3] < 0.3) continue
          const x = pd[i * 4]
          const y = pd[i * 4 + 1]
          const size = pd[i * 4 + 2]
          ctx.moveTo(x + size, y)
          ctx.arc(x, y, size, 0, TAU)
        }
        ctx.fill()
      }

      // Ошибка: ударная волна.
      if (f.shockAlpha > 0.001) {
        strokeArc(0.24 + 0.42 * f.shock, 0, TAU, lw * 2.6, rgba(red, f.shockAlpha))
      }
      ctx.globalCompositeOperation = 'source-over'
    },
    dispose() {
      ctx.setTransform(1, 0, 0, 1, 0, 0)
      ctx.clearRect(0, 0, canvas.width, canvas.height)
    },
  }
}
