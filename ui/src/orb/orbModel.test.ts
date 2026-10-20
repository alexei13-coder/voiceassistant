import { describe, expect, it } from 'vitest'
import type { AssistantState } from '../protocol'
import { CORE_RADIUS } from './orbGeometry'
import { type OrbInputs, OrbModel, STOP_HOLD_MS } from './orbModel'
import type { OrbTheme } from './orbTheme'

const THEME: OrbTheme = {
  states: {
    idle: [0, 0.5, 0.6],
    listening: [0, 0.9, 1],
    thinking: [0.3, 0.6, 1],
    speaking: [0.5, 0.95, 1],
    awaiting_confirmation: [1, 0.7, 0.3],
    executing: [0.2, 1, 0.6],
    error: [1, 0.3, 0.37],
    stopped: [0.4, 0.5, 0.5],
  },
}

const WALL = 1_700_000_000_000
const SILENCE = { mic: 0, tts: 0 }

function inputs(state: AssistantState, extra: Partial<OrbInputs> = {}): OrbInputs {
  return { state, stateChangedAt: WALL, confirmation: null, reducedMotion: false, lastStopAt: null, ...extra }
}

/** Прогнать модель `seconds` секунд с шагом 60 к/с, начиная с момента `from`. */
function advance(model: OrbModel, input: OrbInputs, from: number, seconds: number, levels = SILENCE): number {
  let t = from
  for (let i = 0; i < Math.round(seconds * 60); i++) {
    t += 1 / 60
    model.update(input, levels, t, WALL + t * 1000)
  }
  return t
}

describe('модель ядра', () => {
  it('первый кадр сразу в цели: без анимации от нулевых значений', () => {
    const model = new OrbModel(THEME)
    const f = model.update(inputs('thinking'), SILENCE, 0, WALL)
    expect(f.color).toEqual([0.3, 0.6, 1])
    expect(f.arc).toBe(1)
    expect(f.arcPair).toBeGreaterThan(0)
  })

  it('минимализм: в покое столбики почти не видны, при голосе — видны ясно', () => {
    const idle = new OrbModel(THEME).update(inputs('idle'), SILENCE, 0, WALL)
    expect(idle.bars).toBeLessThan(0.2)
    expect(idle.arcPair).toBe(0)
    expect(idle.chase).toBe(0)
    expect(idle.ripple).toBe(0)
    for (const state of ['listening', 'speaking'] as const) {
      expect(new OrbModel(THEME).update(inputs(state), SILENCE, 0, WALL).bars).toBe(1)
    }
  })

  it('под активной дугой (думаю, отсчёт, выполняю) само кольцо приглушено', () => {
    const ringOf = (state: AssistantState) => new OrbModel(THEME).update(inputs(state), SILENCE, 0, WALL).ring
    for (const state of ['thinking', 'awaiting_confirmation', 'executing'] as const) {
      expect(ringOf(state)).toBeLessThan(ringOf('idle'))
    }
  })

  it('смена состояния плавная: цвет не «щёлкает», а доезжает за ~0,4 с', () => {
    const model = new OrbModel(THEME)
    model.update(inputs('idle'), SILENCE, 0, WALL)
    const t = advance(model, inputs('listening'), 0, 1 / 60)
    const g = model.frame.color[1]
    expect(g).toBeGreaterThan(0.5)
    expect(g).toBeLessThan(0.55)
    advance(model, inputs('listening'), t, 0.6)
    expect(model.frame.color[1]).toBeCloseTo(0.9, 2)
  })

  it('уровень звука берётся из источника своего состояния', () => {
    const model = new OrbModel(THEME)
    model.update(inputs('listening'), SILENCE, 0, WALL)
    advance(model, inputs('listening'), 0, 0.5, { mic: 0.8, tts: 0 })
    expect(model.frame.level).toBeCloseTo(0.8, 2)
    expect(model.frame.barAudio).toBeGreaterThan(0.7)
    expect(model.frame.coreRadius).toBeGreaterThan(CORE_RADIUS * 1.1)

    const speaking = new OrbModel(THEME)
    speaking.update(inputs('speaking'), SILENCE, 0, WALL)
    advance(speaking, inputs('speaking'), 0, 0.5, { mic: 0.8, tts: 0 })
    expect(speaking.frame.level).toBeLessThan(0.01)
  })

  it('волна «говорю» идёт от плазмы наружу и сильнее при громкой речи', () => {
    const quiet = new OrbModel(THEME).update(inputs('speaking'), SILENCE, 1, WALL, true)
    const loud = new OrbModel(THEME).update(inputs('speaking'), { mic: 0, tts: 1 }, 1, WALL, true)
    expect(quiet.ripple).toBeGreaterThan(0)
    expect(loud.ripple).toBeGreaterThan(quiet.ripple)

    const model = new OrbModel(THEME)
    model.update(inputs('speaking'), SILENCE, 0, WALL)
    const before = model.frame.rippleProgress
    advance(model, inputs('speaking'), 0, 0.5)
    expect(model.frame.rippleProgress).toBeGreaterThan(before)
  })

  it('вспышка ошибки — только на переход в ошибку, не при монтировании в ней', () => {
    const mounted = new OrbModel(THEME)
    mounted.update(inputs('error'), SILENCE, 0, WALL)
    advance(mounted, inputs('error'), 0, 0.1)
    expect(mounted.frame.flash).toBe(0)

    const model = new OrbModel(THEME)
    model.update(inputs('idle'), SILENCE, 0, WALL)
    const error = inputs('error', { stateChangedAt: WALL + 50 })
    const t = advance(model, error, 0, 0.1)
    expect(model.frame.flash).toBeGreaterThan(0.8)
    advance(model, error, t, 1.2)
    expect(model.frame.flash).toBeLessThan(0.05)
  })

  it('«Стоп» сжимает ядро даже до прихода состояния stopped и отпускает после удержания', () => {
    const model = new OrbModel(THEME)
    model.update(inputs('idle'), SILENCE, 0, WALL)
    const stop = inputs('idle', { lastStopAt: WALL })
    const t = advance(model, stop, 0, 0.25)
    expect(model.frame.collapse).toBeGreaterThan(0.9)
    advance(model, stop, t, STOP_HOLD_MS / 1000 + 1.2)
    expect(model.frame.collapse).toBeLessThan(0.02)
  })

  it('«Стоп» из будущего (часы перевели назад) не держит ядро сжатым', () => {
    const model = new OrbModel(THEME)
    model.update(inputs('idle'), SILENCE, 0, WALL)
    advance(model, inputs('idle', { lastStopAt: WALL + 60_000 }), 0, 1)
    expect(model.frame.collapse).toBeLessThan(0.01)
  })

  it('отсчёт подтверждения: доля оставшегося времени и пульс до начала отсчёта', () => {
    const model = new OrbModel(THEME)
    const pending = inputs('awaiting_confirmation', { confirmation: { expires_at: null, timeout_ms: 15_000 } })
    model.update(pending, SILENCE, 0, WALL)
    expect(model.frame.countdownFraction).toBe(1)

    const counting = inputs('awaiting_confirmation', {
      confirmation: { expires_at: WALL + 6_000, timeout_ms: 15_000 },
    })
    const f = model.update(counting, SILENCE, 0, WALL, true)
    expect(f.countdownFraction).toBeCloseTo(0.4, 6)
    expect(f.countdown).toBe(1)
  })

  it('после ответа дуга отсчёта гаснет с прежней долей, без скачка к полному кольцу', () => {
    const model = new OrbModel(THEME)
    const counting = inputs('awaiting_confirmation', {
      confirmation: { expires_at: WALL + 6_000, timeout_ms: 15_000 },
    })
    model.update(counting, SILENCE, 0, WALL)
    expect(model.frame.countdownFraction).toBeCloseTo(0.4, 6)

    // Ответ «да»: подтверждение закрыто, ядро ушло выполнять.
    const t = advance(model, inputs('executing'), 0, 0.1)
    expect(model.frame.countdown).toBeGreaterThan(0.2)
    expect(model.frame.countdownFraction).toBeCloseTo(0.4, 6)
    advance(model, inputs('executing'), t, 1)
    expect(model.frame.countdown).toBeLessThan(0.01)
  })

  it('30 к/с разрешены только в устоявшемся ожидании', () => {
    const model = new OrbModel(THEME)
    model.update(inputs('listening'), SILENCE, 0, WALL)
    expect(model.isSteadyIdle()).toBe(false)
    const t = advance(model, inputs('idle'), 0, 0.1)
    expect(model.isSteadyIdle()).toBe(false)
    // Звук, пришедший уже после смены состояния, на ожидание не влияет.
    advance(model, inputs('idle'), t, 2, { mic: 0.5, tts: 0 })
    expect(model.isSteadyIdle()).toBe(true)
  })

  it('статичный режим детерминирован: кадр зависит только от входов и времени', () => {
    const a = new OrbModel(THEME)
    const b = new OrbModel(THEME)
    advance(a, inputs('executing'), 0, 1)
    const fa = a.update(inputs('thinking'), SILENCE, 6, WALL, true)
    const fb = b.update(inputs('thinking'), SILENCE, 6, WALL, true)
    expect(fa.arcAngle).toBeCloseTo(fb.arcAngle, 9)
    expect(fa.arcLength).toBeCloseTo(fb.arcLength, 9)
    expect(fa.chaseHead).toBeCloseTo(fb.chaseHead, 9)
    expect(fa.coreRadius).toBeCloseTo(fb.coreRadius, 9)
    expect(fa.spin).toEqual(fb.spin)
  })

  it('фазы остаются в [0, 2π) после долгой работы', () => {
    const model = new OrbModel(THEME)
    const f = model.update(inputs('thinking'), SILENCE, 86_400 * 7, WALL, true)
    for (const v of [f.arcAngle, f.chaseHead, ...f.spin, ...f.barPhase]) {
      expect(v).toBeGreaterThanOrEqual(0)
      expect(v).toBeLessThan(Math.PI * 2)
    }
    expect(f.rippleProgress).toBeGreaterThanOrEqual(0)
    expect(f.rippleProgress).toBeLessThan(1)
  })
})
