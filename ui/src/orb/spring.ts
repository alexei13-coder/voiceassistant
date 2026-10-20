// Плавность параметров ядра. Пружина считается точным решением, а не шагом Эйлера,
// поэтому результат не зависит от частоты кадров (60, 30 или пропуск кадров после свёрнутого окна).

/** Угловая частота критически демпфированной пружины, проходящей ~95 % пути за settleSeconds. */
export function springOmega(settleSeconds: number): number {
  // (1 + x)·e^(−x) = 0,05 при x ≈ 4,744
  return 4.744 / settleSeconds
}

/** Набор независимых критически демпфированных пружин (без перерегулирования, без рывков скорости). */
export class SpringBank {
  readonly value: Float64Array
  private readonly velocity: Float64Array

  constructor(size: number) {
    this.value = new Float64Array(size)
    this.velocity = new Float64Array(size)
  }

  /** Мгновенно поставить все значения в цель (первый кадр, статичный режим лаборатории). */
  snap(target: ArrayLike<number>): void {
    for (let i = 0; i < this.value.length; i++) {
      this.value[i] = target[i]
      this.velocity[i] = 0
    }
  }

  step(target: ArrayLike<number>, omega: ArrayLike<number>, dt: number): void {
    if (dt <= 0) return
    for (let i = 0; i < this.value.length; i++) {
      const w = omega[i]
      const y = this.value[i] - target[i]
      const v = this.velocity[i]
      const k = v + w * y
      const decay = Math.exp(-w * dt)
      this.value[i] = target[i] + (y + k * dt) * decay
      this.velocity[i] = (v - k * w * dt) * decay
    }
  }

  settled(target: ArrayLike<number>, epsilon: number): boolean {
    for (let i = 0; i < this.value.length; i++) {
      if (Math.abs(this.value[i] - target[i]) > epsilon || Math.abs(this.velocity[i]) > epsilon) return false
    }
    return true
  }
}

/** Огибающая уровня: быстрая атака, медленный спад — как у индикатора громкости. */
export function followEnvelope(current: number, input: number, dt: number, attack: number, release: number): number {
  if (dt <= 0) return current
  const tau = input > current ? attack : release
  return input + (current - input) * Math.exp(-dt / tau)
}
