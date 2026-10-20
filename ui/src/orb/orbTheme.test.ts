import { describe, expect, it } from 'vitest'
import { glslConstants } from './orbGeometry'
import { getOrbTheme, parseCssColor } from './orbTheme'

describe('цвета ядра', () => {
  it('разбирает hex и rgb()', () => {
    expect(parseCssColor('#00e5ff')).toEqual([0, 229 / 255, 1])
    expect(parseCssColor('  #FFF ')).toEqual([1, 1, 1])
    expect(parseCssColor('rgb(255, 0, 51)')).toEqual([1, 0, 0.2])
    expect(parseCssColor('rgba(255 128 0 / 0.5)')).toEqual([1, 128 / 255, 0])
  })

  it('мусор — null, а не чёрный цвет', () => {
    expect(parseCssColor('')).toBeNull()
    expect(parseCssColor('var(--cyan)')).toBeNull()
    expect(parseCssColor('#12345')).toBeNull()
  })

  it('без DOM берёт запасные цвета токенов', () => {
    const theme = getOrbTheme()
    expect(theme.states.awaiting_confirmation).toEqual(parseCssColor('#ffb547'))
    expect(theme.states.error).toEqual(parseCssColor('#ff4d5e'))
  })
})

describe('константы шейдера', () => {
  it('целые числа записаны как float GLSL', () => {
    const glsl = glslConstants()
    expect(glsl).toContain('const float BAR_N = 80.0;')
    expect(glsl).toContain('#define PARTICLES 24')
    expect(glsl).toMatch(/const vec3 ARCS_A\[3\] = vec3\[3\]\(vec3\(0\.15, 1\.35, 0\.0\)/)
  })
})
