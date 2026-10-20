import type { CSSProperties } from 'react'

/** Типобезопасная передача CSS-переменных через style. */
export function cssVars(vars: Record<`--${string}`, string>): CSSProperties {
  return vars as CSSProperties
}
