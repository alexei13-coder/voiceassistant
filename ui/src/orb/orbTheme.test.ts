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
    expect(theme.states.awaiting_confirmation).toEqual(parseCssColor('#f5b14c'))
    expect(theme.states.error).toEqual(parseCssColor('#ff5a67'))
    expect(theme.states.idle).toEqual(parseCssColor('#5fd4e6'))
  })
})

describe('константы шейдера', () => {
  it('целые числа записаны как float GLSL', () => {
    const glsl = glslConstants()
    expect(glsl).toContain('const float BAR_N = 60.0;')
    expect(glsl).toContain('const float RING_R = 0.33;')
    // Каждая строка — объявление константы: никакого мусора в исходник шейдера не попадает.
    for (const line of glsl.split('\n')) expect(line).toMatch(/^const float [A-Z_]+ = -?\d+\.\d+;$/)
  })
})
