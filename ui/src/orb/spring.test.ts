import { describe, expect, it } from 'vitest'
import { followEnvelope, SpringBank, springOmega } from './spring'

function run(bank: SpringBank, target: number[], omega: number[], seconds: number, fps: number): void {
  const dt = 1 / fps
  for (let t = 0; t < seconds - 1e-9; t += dt) bank.step(target, omega, dt)
}

describe('пружина', () => {
  it('проходит ~95 % пути за время установления и не перелетает цель', () => {
    const bank = new SpringBank(1)
    const omega = [springOmega(0.35)]
    let max = 0
    for (let i = 0; i < 21; i++) {
      bank.step([1], omega, 1 / 60)
      max = Math.max(max, bank.value[0])
    }
    expect(bank.value[0]).toBeGreaterThan(0.94)
    expect(bank.value[0]).toBeLessThan(0.97)
    run(bank, [1], omega, 2, 60)
    expect(bank.value[0]).toBeCloseTo(1, 4)
    expect(Math.max(max, bank.value[0])).toBeLessThanOrEqual(1 + 1e-9)
  })

  it('не зависит от частоты кадров', () => {
    const omega = [springOmega(0.3), springOmega(0.3)]
    const a = new SpringBank(2)
    const b = new SpringBank(2)
    run(a, [1, -2], omega, 0.2, 60)
    run(b, [1, -2], omega, 0.2, 30)
    expect(a.value[0]).toBeCloseTo(b.value[0], 6)
    expect(a.value[1]).toBeCloseTo(b.value[1], 6)
  })

  it('snap ставит значения в цель без скорости', () => {
    const bank = new SpringBank(2)
    bank.snap([0.5, 3])
    expect(Array.from(bank.value)).toEqual([0.5, 3])
    expect(bank.settled([0.5, 3], 1e-9)).toBe(true)
  })
})

describe('огибающая уровня', () => {
  it('атака быстрее спада', () => {
    const up = followEnvelope(0, 1, 0.04, 0.04, 0.18)
    const down = 1 - followEnvelope(1, 0, 0.04, 0.04, 0.18)
    expect(up).toBeCloseTo(1 - Math.exp(-1), 6)
    expect(down).toBeLessThan(up)
  })

  it('при dt = 0 значение не меняется', () => {
    expect(followEnvelope(0.3, 1, 0, 0.04, 0.18)).toBe(0.3)
  })
})
