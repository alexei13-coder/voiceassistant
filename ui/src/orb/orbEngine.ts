// Движок ядра: цикл requestAnimationFrame, размеры холста, подписка на хранилище, выбор частоты кадров.
// React здесь не участвует: состояние читается из zustand напрямую, уровни звука — из live.ts,
// поэтому кадр анимации не вызывает ни одного ре-рендера.

import { currentLevel } from '../live'
import { type SwyvornStore, useSwyvorn } from '../store'
import { createCanvasRenderer } from './canvasRenderer'
import { type OrbInputs, type OrbLevels, OrbModel } from './orbModel'
import { getOrbTheme } from './orbTheme'
import type { OrbRenderer, OrbRendererKind, OrbViewport } from './renderer'
import { createWebGLRenderer } from './webglRenderer'

export interface OrbStats {
  renderer: OrbRendererKind
  /** Отрисованных кадров в секунду (не частота rAF). */
  fps: number
  /** Среднее время кадра на CPU (модель + команды отрисовки), мс. */
  frameMs: number
  /** Размер подложки, px устройства. */
  width: number
  height: number
}

export interface OrbEngineOptions {
  kind: OrbRendererKind
  /** Заморозить время анимации (секунды) — для детерминированных скриншотов лаборатории. */
  frozenTime?: number
  onStats?: (stats: OrbStats) => void
  /** Выбранная отрисовка не работает — нужно пересоздать холст с Canvas 2D. */
  onUnsupported: () => void
}

const ACTIVE_FRAME_MS = 1000 / 60
const CALM_FRAME_MS = 1000 / 30
/** Допуск, чтобы на 60-герцовом мониторе не пропускать кадры из-за дрожания меток времени. */
const FRAME_SLACK_MS = 1.5
const MAX_PIXEL_RATIO = 2
/** Потолок подложки: на 4K-мониторе огромное ядро не должно съедать видеокарту. */
const MAX_BACKING_SIDE = 2048

function toInputs(s: SwyvornStore): OrbInputs {
  return {
    state: s.state,
    stateChangedAt: s.stateChangedAt,
    confirmation: s.confirmation,
    reducedMotion: s.reducedMotion,
    lastStopAt: s.lastStop?.at ?? null,
  }
}

/** Запускает ядро на холсте и возвращает функцию полной очистки. */
export function startOrbEngine(canvas: HTMLCanvasElement, options: OrbEngineOptions): () => void {
  const theme = getOrbTheme()
  let lost = false
  let disposed = false

  const created: OrbRenderer | null =
    options.kind === 'webgl2'
      ? createWebGLRenderer(canvas, theme, {
          onLost: () => {
            lost = true
            sync()
          },
          onRestored: () => {
            lost = false
            // Размер подложки контекст пережил — достаточно перезапустить цикл.
            sync()
          },
          onFailed: () => {
            if (!disposed) options.onUnsupported()
          },
        })
      : createCanvasRenderer(canvas, theme)

  if (!created) {
    options.onUnsupported()
    return () => {}
  }
  const renderer = created

  const model = new OrbModel(theme)
  // Хранилище меняется редко (единицы раз в секунду) — свежий снимок на каждое изменение дешевле сверок.
  let inputs = toInputs(useSwyvorn.getState())
  const unsubscribe = useSwyvorn.subscribe((s) => {
    inputs = toInputs(s)
  })
  const levels: OrbLevels = { mic: 0, tts: 0 }
  const frozen = options.frozenTime !== undefined
  const frozenWall = Date.now()

  let cssWidth = 0
  let cssHeight = 0
  /** Точный размер в px устройства (device-pixel-content-box), если браузер его сообщает. */
  let deviceWidth = 0
  let deviceHeight = 0
  let raf = 0
  let running = false
  let lastFrameAt = 0
  let lastTickAt = 0
  let time = 0
  let statsFrom = 0
  let statsFrames = 0
  let statsCpu = 0

  function drawFrame(now: number): void {
    const started = performance.now()
    const dt = lastTickAt ? Math.min(0.1, (now - lastTickAt) / 1000) : 0
    lastTickAt = now
    time += dt
    levels.mic = currentLevel('mic')
    levels.tts = currentLevel('tts')
    const frame = frozen
      ? model.update(inputs, levels, options.frozenTime ?? 0, frozenWall, true)
      : model.update(inputs, levels, time, Date.now())
    renderer.render(frame)
    reportStats(now, performance.now() - started)
  }

  function reportStats(now: number, cpuMs: number): void {
    if (!options.onStats) return
    statsFrames++
    statsCpu += cpuMs
    if (!statsFrom) statsFrom = now
    const elapsed = now - statsFrom
    if (elapsed < 1000) return
    options.onStats({
      renderer: options.kind,
      fps: (statsFrames * 1000) / elapsed,
      frameMs: statsCpu / statsFrames,
      width: canvas.width,
      height: canvas.height,
    })
    statsFrom = now
    statsFrames = 0
    statsCpu = 0
  }

  const tick = (now: number) => {
    raf = requestAnimationFrame(tick)
    const calm = inputs.reducedMotion || model.isSteadyIdle()
    const interval = calm ? CALM_FRAME_MS : ACTIVE_FRAME_MS
    const since = now - lastFrameAt
    if (since < interval - FRAME_SLACK_MS) return
    // Держим ровный шаг сетки кадров, но после долгой паузы не пытаемся «догонять».
    lastFrameAt = since > interval * 2 ? now : lastFrameAt + interval
    drawFrame(now)
  }

  /** Цикл крутится, только когда кадр кому-то виден. */
  function sync(): void {
    const visible = !document.hidden && cssWidth > 0 && cssHeight > 0 && !lost && !disposed
    if (visible && !running) {
      running = true
      lastFrameAt = 0
      lastTickAt = 0
      statsFrom = 0
      statsFrames = 0
      statsCpu = 0
      raf = requestAnimationFrame(tick)
    } else if (!visible && running) {
      running = false
      cancelAnimationFrame(raf)
    }
  }

  function backingViewport(): OrbViewport {
    const dpr = window.devicePixelRatio || 1
    const ratio = Math.min(dpr, MAX_PIXEL_RATIO)
    const fit = Math.min(1, MAX_BACKING_SIDE / Math.max(1, cssWidth * ratio, cssHeight * ratio))
    // На масштабе 125 %/150 % (обычном для Windows) округление CSS-размера сдвигает сетку на полпикселя
    // и тонкие линии мылятся; точный размер в px устройства даёт отображение пиксель в пиксель.
    // Ему верим, только если он согласуется с devicePixelRatio с точностью до привязки к пикселям:
    // эмуляция масштаба в DevTools сообщает размер без масштаба — подложка вышла бы мутной.
    const exact =
      deviceWidth > 0 &&
      Math.abs(deviceWidth - cssWidth * dpr) < 2 &&
      Math.abs(deviceHeight - cssHeight * dpr) < 2
    if (exact && ratio === dpr && fit === 1) {
      return { width: deviceWidth, height: deviceHeight, pixelRatio: deviceWidth / cssWidth }
    }
    return {
      width: Math.max(1, Math.round(cssWidth * ratio * fit)),
      height: Math.max(1, Math.round(cssHeight * ratio * fit)),
      pixelRatio: ratio * fit,
    }
  }

  function applySize(): void {
    const viewport = backingViewport()
    if (canvas.width !== viewport.width) canvas.width = viewport.width
    if (canvas.height !== viewport.height) canvas.height = viewport.height
    renderer.resize(viewport)
    // Смена размера стирает холст — дорисовываем сразу, чтобы не мигнуть пустым кадром.
    if (running && !lost) drawFrame(performance.now())
  }

  const resizeObserver = new ResizeObserver((entries) => {
    const entry = entries[entries.length - 1]
    cssWidth = entry.contentRect.width
    cssHeight = entry.contentRect.height
    const device = entry.devicePixelContentBoxSize?.[0]
    deviceWidth = device ? Math.round(device.inlineSize) : 0
    deviceHeight = device ? Math.round(device.blockSize) : 0
    if (cssWidth > 0 && cssHeight > 0) applySize()
    sync()
  })
  try {
    resizeObserver.observe(canvas, { box: 'device-pixel-content-box' })
  } catch {
    // Старый движок без device-pixel-content-box: обходимся CSS-размером.
    resizeObserver.observe(canvas)
  }

  // Окно перетащили на монитор с другим масштабом: без device-pixel-content-box ResizeObserver
  // этого не видит, а при ограничении масштаба сверху меняется и толщина линий.
  let ratioQuery: MediaQueryList | null = null
  const onRatioChange = () => {
    watchPixelRatio()
    if (cssWidth > 0 && cssHeight > 0) applySize()
  }
  function watchPixelRatio(): void {
    ratioQuery?.removeEventListener('change', onRatioChange)
    ratioQuery = window.matchMedia(`(resolution: ${window.devicePixelRatio || 1}dppx)`)
    ratioQuery.addEventListener('change', onRatioChange)
  }
  watchPixelRatio()

  document.addEventListener('visibilitychange', sync)

  return () => {
    disposed = true
    sync()
    resizeObserver.disconnect()
    ratioQuery?.removeEventListener('change', onRatioChange)
    document.removeEventListener('visibilitychange', sync)
    unsubscribe()
    renderer.dispose()
  }
}
