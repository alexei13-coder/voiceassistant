// WebGL2-отрисовка ядра: один шейдер на квадрат по центру холста.
// Потеря контекста (сон, сброс драйвера) переживается: ресурсы пересоздаются по webglcontextrestored.

import type { OrbFrame } from './orbModel'
import { FRAGMENT_SHADER, VERTEX_SHADER } from './orbShader'
import type { OrbTheme } from './orbTheme'
import { layoutFor, type OrbLayout, type OrbRenderer, type OrbViewport } from './renderer'

export interface WebGLHooks {
  /** Контекст потерян — кадры рисовать нельзя до восстановления. */
  onLost(): void
  onRestored(): void
  /** Восстановить не удалось — нужна запасная отрисовка. */
  onFailed(): void
}

const UNIFORMS = [
  'uCenter',
  'uScale',
  'uPx',
  'uLine',
  'uColor',
  'uCore',
  'uSpin',
  'uRing',
  'uArcLen',
  'uBars',
  'uBarPhase',
  'uChase',
  'uCountdown',
  'uRipple',
  'uFx',
  'uAmber',
  'uRed',
  'uGrey',
] as const

type UniformName = (typeof UNIFORMS)[number]

interface GpuResources {
  program: WebGLProgram
  vao: WebGLVertexArrayObject
  u: Record<UniformName, WebGLUniformLocation | null>
}

function compile(gl: WebGL2RenderingContext, type: GLenum, source: string): WebGLShader {
  const shader = gl.createShader(type)
  if (!shader) throw new Error('не удалось создать шейдер')
  gl.shaderSource(shader, source)
  gl.compileShader(shader)
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(shader) ?? ''
    gl.deleteShader(shader)
    throw new Error(`шейдер не скомпилирован: ${log}`)
  }
  return shader
}

function createResources(gl: WebGL2RenderingContext, theme: OrbTheme): GpuResources {
  const vs = compile(gl, gl.VERTEX_SHADER, VERTEX_SHADER)
  const fs = compile(gl, gl.FRAGMENT_SHADER, FRAGMENT_SHADER)
  const program = gl.createProgram()
  gl.attachShader(program, vs)
  gl.attachShader(program, fs)
  gl.linkProgram(program)
  // Шейдеры больше не нужны: программа держит скомпилированный код сама.
  gl.deleteShader(vs)
  gl.deleteShader(fs)
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    const log = gl.getProgramInfoLog(program) ?? ''
    gl.deleteProgram(program)
    throw new Error(`программа не слинкована: ${log}`)
  }
  const vao = gl.createVertexArray()
  const u = {} as Record<UniformName, WebGLUniformLocation | null>
  for (const name of UNIFORMS) u[name] = gl.getUniformLocation(program, name)

  // Постоянные цвета акцентов задаём один раз.
  gl.useProgram(program)
  gl.uniform3fv(u.uAmber, theme.states.awaiting_confirmation)
  gl.uniform3fv(u.uRed, theme.states.error)
  gl.uniform3fv(u.uGrey, theme.states.stopped)
  gl.disable(gl.DEPTH_TEST)
  gl.disable(gl.BLEND)
  gl.clearColor(0, 0, 0, 0)
  return { program, vao, u }
}

export function createWebGLRenderer(
  canvas: HTMLCanvasElement,
  theme: OrbTheme,
  hooks: WebGLHooks,
): OrbRenderer | null {
  const gl = canvas.getContext('webgl2', {
    alpha: true,
    premultipliedAlpha: true,
    antialias: false,
    depth: false,
    stencil: false,
    preserveDrawingBuffer: false,
    // HUD не должен будить дискретную видеокарту ноутбука.
    powerPreference: 'low-power',
  })
  if (!gl || gl.isContextLost()) return null

  let res: GpuResources | null
  try {
    res = createResources(gl, theme)
  } catch (err) {
    console.warn('[orb] WebGL2 недоступен, переход на Canvas 2D:', err)
    return null
  }

  let viewport: OrbViewport = { width: canvas.width, height: canvas.height, pixelRatio: 1 }
  let layout: OrbLayout = layoutFor(viewport)

  const onLost = (e: Event) => {
    // preventDefault — обязательное условие, чтобы браузер вообще попытался восстановить контекст.
    e.preventDefault()
    res = null
    hooks.onLost()
  }
  const onRestored = () => {
    try {
      res = createResources(gl, theme)
      hooks.onRestored()
    } catch (err) {
      console.warn('[orb] контекст WebGL не восстановлен:', err)
      hooks.onFailed()
    }
  }
  canvas.addEventListener('webglcontextlost', onLost)
  canvas.addEventListener('webglcontextrestored', onRestored)

  return {
    kind: 'webgl2',
    resize(next) {
      viewport = next
      layout = layoutFor(next)
    },
    render(f: OrbFrame) {
      if (!res) return
      const { u } = res
      gl.viewport(0, 0, viewport.width, viewport.height)
      gl.clear(gl.COLOR_BUFFER_BIT)
      gl.viewport(layout.squareX, layout.squareY, layout.squareSize, layout.squareSize)
      gl.useProgram(res.program)
      gl.bindVertexArray(res.vao)

      gl.uniform2f(u.uCenter, layout.centerX, layout.centerY)
      gl.uniform1f(u.uScale, layout.scale)
      gl.uniform1f(u.uPx, 1 / layout.scale)
      gl.uniform1f(u.uLine, layout.line)
      gl.uniform3fv(u.uColor, f.color)
      gl.uniform4f(u.uCore, f.coreRadius, f.coreBoost, f.turbulence, f.energy)
      gl.uniform3fv(u.uSpin, f.spin)
      gl.uniform4f(u.uRing, f.ring, f.arc, f.arcPair, f.arcAngle)
      gl.uniform2f(u.uArcLen, f.arcLength, f.arcPairLength)
      gl.uniform4f(u.uBars, f.barBase, f.barAudio, f.barWave, f.bars)
      gl.uniform3fv(u.uBarPhase, f.barPhase)
      gl.uniform3f(u.uChase, f.chase, f.chaseHead, f.chaseLength)
      gl.uniform2f(u.uCountdown, f.countdown, f.countdownFraction)
      gl.uniform2f(u.uRipple, f.ripple, f.rippleProgress)
      gl.uniform2f(u.uFx, f.flash, f.collapse)

      gl.drawArrays(gl.TRIANGLES, 0, 3)
    },
    dispose() {
      canvas.removeEventListener('webglcontextlost', onLost)
      canvas.removeEventListener('webglcontextrestored', onRestored)
      if (res && !gl.isContextLost()) {
        gl.deleteVertexArray(res.vao)
        gl.deleteProgram(res.program)
      }
      // Сам контекст не теряем намеренно: в StrictMode тот же <canvas> монтируется повторно
      // и получит этот же контекст обратно.
      res = null
    },
  }
}
