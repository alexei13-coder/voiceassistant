// Модель анимации ядра: из состояния ассистента и уровней звука считает параметры кадра.
// Чистая логика без DOM — одинаково кормит WebGL- и Canvas-отрисовку и проверяется тестами.
// Все параметры состояния идут через пружины, поэтому смена состояния никогда не «щёлкает».

import type { AssistantState } from '../protocol'
import { CORE_RADIUS, hash11, PARTICLE_COUNT, THINK_INNER, THINK_OUTER } from './orbGeometry'
import { STATE_LOOKS } from './orbLook'
import type { OrbTheme } from './orbTheme'
import { followEnvelope, SpringBank, springOmega } from './spring'

const TAU = Math.PI * 2

export interface OrbInputs {
  state: AssistantState
  /** Date.now() последней смены состояния. */
  stateChangedAt: number
  confirmation: { expires_at: number | null; timeout_ms: number } | null
  reducedMotion: boolean
  /** Date.now() последнего «Стоп». */
  lastStopAt: number | null
}

export interface OrbLevels {
  mic: number
  tts: number
}

export interface OrbFrame {
  /** Цвет состояния, sRGB 0..1. */
  color: [number, number, number]
  energy: number
  /** Сглаженный уровень звука текущего источника 0..1. */
  level: number
  coreRadius: number
  coreBoost: number
  turbulence: number
  /** Фазы вращения плазмы, рад (периодичны — точность не теряется за дни работы). */
  spin: [number, number, number]
  ringAngle: number
  arcAngleA: number
  arcAngleB: number
  dialAngle: number
  barBase: number
  barAudio: number
  barWave: number
  barPhase: [number, number, number, number]
  sweep: number
  sweepAngle: number
  particles: number
  /** PARTICLE_COUNT × (x, y, радиус, яркость) в долях R. */
  particleData: Float32Array
  chase: number
  chaseHead: number
  chaseLength: number
  /** Волны «говорю»: сила (уже с уровнем звука) и фаза. */
  ripple: number
  ripplePhase: number
  /** Яркость кольца отсчёта с учётом пульса. */
  countdown: number
  /** Оставшаяся доля времени подтверждения 0..1. */
  countdownFraction: number
  flash: number
  /** Ударная волна вспышки ошибки: радиус-прогресс 0..1 и яркость. */
  shock: number
  shockAlpha: number
  collapse: number
}

// Каналы, которые ведут пружины.
const C = {
  r: 0,
  g: 1,
  b: 2,
  energy: 3,
  ringSpeed: 4,
  arcSpeed: 5,
  barGain: 6,
  barWave: 7,
  mic: 8,
  tts: 9,
  sweep: 10,
  particles: 11,
  chase: 12,
  countdown: 13,
  pulse: 14,
  turbulence: 15,
  breath: 16,
  collapse: 17,
  motion: 18,
  ripple: 19,
} as const
const CHANNELS = 20

// Фазы, которые накапливаются по времени (скорость — из сглаженных параметров).
const P = {
  ring: 0,
  arcA: 1,
  arcB: 2,
  dial: 3,
  sweep: 4,
  spinA: 5,
  spinB: 6,
  spinC: 7,
  bar0: 8,
  bar1: 9,
  bar2: 10,
  bar3: 11,
  chase: 12,
  chaseLength: 13,
  breath: 14,
  pulse: 15,
  ripple: 16,
} as const
const PHASES = 17

const SETTLE = springOmega(0.33)
const SETTLE_COLOR = springOmega(0.38)
const SETTLE_MOTION = springOmega(0.6)
const COLLAPSE_IN = springOmega(0.16)
const COLLAPSE_OUT = springOmega(0.6)

const LEVEL_ATTACK = 0.04
const LEVEL_RELEASE = 0.18

/** Сколько держится «сжатие» после события «Стоп», даже если состояние ещё не stopped. */
export const STOP_HOLD_MS = 700

/** Скорость движения при «уменьшить движение». */
const REDUCED_MOTION = 0.35

/** После паузы (свёрнутое окно) анимация продолжается с места, а не прыгает вперёд. */
const MAX_DT = 0.1

// Вспышка ошибки: атака ~30 мс, спад ~1 с.
const FLASH_ATTACK = 0.03
const FLASH_DECAY = 0.33
const FLASH_PEAK = (() => {
  const t = ((FLASH_ATTACK * FLASH_DECAY) / (FLASH_DECAY - FLASH_ATTACK)) * Math.log(FLASH_DECAY / FLASH_ATTACK)
  return (1 - Math.exp(-t / FLASH_ATTACK)) * Math.exp(-t / FLASH_DECAY)
})()

function flashEnvelope(age: number): number {
  if (!(age >= 0)) return 0
  return ((1 - Math.exp(-age / FLASH_ATTACK)) * Math.exp(-age / FLASH_DECAY)) / FLASH_PEAK
}

function wrap(angle: number): number {
  return angle - TAU * Math.floor(angle / TAU)
}

function clamp01(x: number): number {
  return x < 0 ? 0 : x > 1 ? 1 : x
}

interface ParticleSeed {
  radius: number
  speed: number
  phase: number
  size: number
  twinkle: number
}

// Частицы «думаю»: разные орбиты, скорости и направления — детерминированно из хэша.
const PARTICLE_SEEDS: readonly ParticleSeed[] = Array.from({ length: PARTICLE_COUNT }, (_, i) => {
  const h = (k: number) => hash11(i * 7.31 + k * 13.7 + 1)
  const direction = i % 3 === 0 ? -1 : 1
  return {
    radius: THINK_INNER + 0.03 + (THINK_OUTER - THINK_INNER - 0.05) * h(1),
    speed: direction * (0.22 + 0.7 * h(2)),
    phase: TAU * h(3),
    size: 0.0028 + 0.0032 * h(4),
    twinkle: 1.5 + 3 * h(5),
  }
})

export class OrbModel {
  readonly frame: OrbFrame = {
    color: [0, 0, 0],
    energy: 0,
    level: 0,
    coreRadius: CORE_RADIUS,
    coreBoost: 1,
    turbulence: 0,
    spin: [0, 0, 0],
    ringAngle: 0,
    arcAngleA: 0,
    arcAngleB: 0,
    dialAngle: 0,
    barBase: 0.006,
    barAudio: 0,
    barWave: 0,
    barPhase: [0, 0, 0, 0],
    sweep: 0,
    sweepAngle: 0,
    particles: 0,
    particleData: new Float32Array(PARTICLE_COUNT * 4),
    chase: 0,
    chaseHead: 0,
    chaseLength: 0,
    ripple: 0,
    ripplePhase: 0,
    countdown: 0,
    countdownFraction: 1,
    flash: 0,
    shock: 1,
    shockAlpha: 0,
    collapse: 0,
  }

  private readonly springs = new SpringBank(CHANNELS)
  private readonly target = new Float64Array(CHANNELS)
  private readonly omega = new Float64Array(CHANNELS).fill(SETTLE)
  private readonly phase = new Float64Array(PHASES)
  private readonly rate = new Float64Array(PHASES)
  private particleClock = 0
  private envMic = 0
  private envTts = 0
  private lastTime = 0
  private initialized = false
  private state: AssistantState = 'idle'
  private errorSeenAt: number | null = null
  private flashStart = Number.NEGATIVE_INFINITY

  constructor(private readonly theme: OrbTheme) {
    this.omega[C.r] = SETTLE_COLOR
    this.omega[C.g] = SETTLE_COLOR
    this.omega[C.b] = SETTLE_COLOR
    this.omega[C.motion] = SETTLE_MOTION
  }

  /**
   * Продвинуть анимацию к моменту `time` (секунды анимации) и вернуть кадр.
   * `wall` — Date.now() для обратного отсчёта и «Стоп». `snap` — сразу поставить всё в цель
   * (статичный режим лаборатории: кадр зависит только от входов и `time`).
   */
  update(inputs: OrbInputs, levels: OrbLevels, time: number, wall: number, snap = false): OrbFrame {
    const jump = snap || !this.initialized
    const dt = jump ? 0 : Math.min(MAX_DT, Math.max(0, time - this.lastTime))
    this.lastTime = time

    this.trackEvents(inputs, time, jump)
    this.fillTargets(inputs, wall)
    this.updateCollapseOmega()

    if (jump) {
      this.springs.snap(this.target)
      this.envMic = levels.mic
      this.envTts = levels.tts
    } else {
      this.springs.step(this.target, this.omega, dt)
      this.envMic = followEnvelope(this.envMic, levels.mic, dt, LEVEL_ATTACK, LEVEL_RELEASE)
      this.envTts = followEnvelope(this.envTts, levels.tts, dt, LEVEL_ATTACK, LEVEL_RELEASE)
    }

    const s = this.springs.value
    const level = clamp01(s[C.mic] * this.envMic + s[C.tts] * this.envTts)
    this.advancePhases(level, time, dt, jump)
    this.writeFrame(inputs, level, time, wall)
    this.initialized = true
    return this.frame
  }

  /** Покой: ожидание, всё доехало до цели, звука и вспышек нет — можно рисовать 30 к/с. */
  isSteadyIdle(): boolean {
    // Учитывается только тот уровень, который состояние действительно слушает: «сырые» огибающие
    // могут быть ненулевыми (звук пришёл в момент смены состояния), но картинку уже не меняют.
    return (
      this.state === 'idle' &&
      this.frame.level < 0.004 &&
      this.frame.flash < 0.002 &&
      this.springs.settled(this.target, 1e-3)
    )
  }

  private trackEvents(inputs: OrbInputs, time: number, jump: boolean): void {
    this.state = inputs.state
    if (inputs.state === 'error' && inputs.stateChangedAt !== this.errorSeenAt) {
      // При монтировании в уже идущей ошибке вспышки нет: это не событие, а состояние.
      if (!jump) this.flashStart = time
      this.errorSeenAt = inputs.stateChangedAt
    }
    if (jump) this.flashStart = Number.NEGATIVE_INFINITY
  }

  private fillTargets(inputs: OrbInputs, wall: number): void {
    const look = STATE_LOOKS[inputs.state]
    const t = this.target
    const base = this.theme.states[inputs.state]
    const [tintState, tintAmount] = look.tint ?? [inputs.state, 0]
    const tint = this.theme.states[tintState]
    for (let i = 0; i < 3; i++) t[C.r + i] = base[i] + (tint[i] - base[i]) * tintAmount

    t[C.energy] = look.energy
    t[C.ringSpeed] = look.ringSpeed
    t[C.arcSpeed] = look.arcSpeed
    t[C.barGain] = look.barGain
    t[C.barWave] = look.barWave
    t[C.mic] = look.mic
    t[C.tts] = look.tts
    t[C.sweep] = look.sweep
    t[C.particles] = look.particles
    t[C.chase] = look.chase
    t[C.ripple] = look.ripple
    t[C.countdown] = look.countdown
    t[C.pulse] = inputs.confirmation?.expires_at == null ? 1 : 0
    t[C.turbulence] = look.turbulence
    t[C.breath] = look.breath
    const stopHeld = inputs.lastStopAt !== null && wall - inputs.lastStopAt < STOP_HOLD_MS
    t[C.collapse] = stopHeld ? 1 : look.collapse
    t[C.motion] = inputs.reducedMotion ? REDUCED_MOTION : 1
  }

  /** Сжатие быстрое, обратное раскрытие — заметно мягче. */
  private updateCollapseOmega(): void {
    const current = this.springs.value[C.collapse]
    this.omega[C.collapse] = this.target[C.collapse] > current ? COLLAPSE_IN : COLLAPSE_OUT
  }

  private advancePhases(level: number, time: number, dt: number, jump: boolean): void {
    const s = this.springs.value
    const m = s[C.motion]
    const turb = s[C.turbulence]
    const wave = s[C.barWave]
    const r = this.rate
    r[P.ring] = s[C.ringSpeed]
    r[P.arcA] = s[C.arcSpeed]
    r[P.arcB] = -0.62 * s[C.arcSpeed]
    r[P.dial] = 0.012
    r[P.sweep] = 2.1
    r[P.spinA] = 0.14 + 0.3 * turb + 0.5 * level
    r[P.spinB] = 0.09 + 0.18 * turb
    r[P.spinC] = -(0.08 + 0.3 * turb + 0.4 * level)
    r[P.bar0] = 0.5 + 1.2 * wave + 1.4 * level
    r[P.bar1] = 0.35 + 0.9 * wave + 1.0 * level
    r[P.bar2] = 1.2 + 2.5 * wave + 7 * level
    r[P.bar3] = 0.7
    r[P.chase] = 2.3
    r[P.chaseLength] = 1.6
    r[P.breath] = TAU / 5.6
    r[P.pulse] = 2.6
    r[P.ripple] = 3.2 + 4 * level
    for (let i = 0; i < PHASES; i++) {
      this.phase[i] = wrap(jump ? r[i] * m * time : this.phase[i] + r[i] * m * dt)
    }
    this.particleClock = jump ? m * time : this.particleClock + m * dt
  }

  private writeFrame(inputs: OrbInputs, level: number, time: number, wall: number): void {
    const s = this.springs.value
    const f = this.frame
    const ph = this.phase
    const m = s[C.motion]
    const collapse = clamp01(s[C.collapse])
    // Движение от звука при «уменьшить движение» тоже приглушаем, но не убираем: это обратная связь.
    const audioScale = 0.5 + 0.5 * m

    f.color[0] = clamp01(s[C.r])
    f.color[1] = clamp01(s[C.g])
    f.color[2] = clamp01(s[C.b])
    f.energy = Math.max(0, s[C.energy])
    f.level = level
    f.turbulence = clamp01(s[C.turbulence])

    const breath = Math.sin(ph[P.breath]) * s[C.breath]
    f.coreRadius = CORE_RADIUS * (1 + 0.04 * breath + 0.24 * level * audioScale) * (1 - 0.3 * collapse)
    const age = time - this.flashStart
    const flashScale = inputs.reducedMotion ? 0.5 : 1
    f.flash = flashEnvelope(age) * flashScale
    f.shock = 1 - Math.exp(-Math.max(0, age) / 0.3)
    f.shockAlpha = inputs.reducedMotion ? 0 : f.flash * (1 - f.shock)
    f.coreBoost = f.energy * (1 + 0.9 * level) * (1 + 0.6 * f.flash)

    f.spin[0] = ph[P.spinA]
    f.spin[1] = ph[P.spinB]
    f.spin[2] = ph[P.spinC]
    f.ringAngle = ph[P.ring]
    f.arcAngleA = ph[P.arcA]
    f.arcAngleB = ph[P.arcB]
    f.dialAngle = ph[P.dial]

    f.barBase = 0.006
    f.barAudio = clamp01(s[C.barGain]) * level * audioScale
    f.barWave = clamp01(s[C.barWave])
    f.barPhase[0] = ph[P.bar0]
    f.barPhase[1] = ph[P.bar1]
    f.barPhase[2] = ph[P.bar2]
    f.barPhase[3] = ph[P.bar3]

    f.sweep = clamp01(s[C.sweep])
    f.sweepAngle = ph[P.sweep]
    f.particles = clamp01(s[C.particles])
    this.writeParticles()

    f.chase = clamp01(s[C.chase])
    f.chaseHead = ph[P.chase]
    f.chaseLength = TAU * (0.14 + 0.16 * (0.5 + 0.5 * Math.sin(ph[P.chaseLength])))
    f.ripple = clamp01(s[C.ripple]) * (0.25 + 0.75 * level)
    f.ripplePhase = ph[P.ripple]

    const pulse = clamp01(s[C.pulse])
    const pulseGlow = 0.35 + 0.65 * (0.5 + 0.5 * Math.sin(ph[P.pulse]))
    f.countdown = clamp01(s[C.countdown]) * (1 + (pulseGlow - 1) * pulse)
    const c = inputs.confirmation
    f.countdownFraction =
      c?.expires_at != null && c.timeout_ms > 0 ? clamp01((c.expires_at - wall) / c.timeout_ms) : 1

    f.collapse = collapse
  }

  private writeParticles(): void {
    const out = this.frame.particleData
    const clock = this.particleClock
    for (let i = 0; i < PARTICLE_COUNT; i++) {
      const p = PARTICLE_SEEDS[i]
      const angle = p.phase + clock * p.speed
      const radius = p.radius + 0.008 * Math.sin(clock * 0.7 + p.phase)
      out[i * 4] = radius * Math.cos(angle)
      out[i * 4 + 1] = radius * Math.sin(angle)
      out[i * 4 + 2] = p.size
      out[i * 4 + 3] = 0.55 + 0.45 * Math.sin(clock * p.twinkle + p.phase * 3)
    }
  }
}
