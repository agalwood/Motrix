import { expect, it } from 'vitest'
import { systemAccentHue } from './system-accent-color'

it('uses the real system hue and keeps neutral or unavailable accents gray', () => {
  expect(systemAccentHue('#ff0000')).toBe(0)
  expect(systemAccentHue('#00ff00')).toBe(120)
  expect(systemAccentHue('#0000ff')).toBe(240)
  expect(systemAccentHue('#888888')).toBeNull()
  expect(systemAccentHue(null)).toBeNull()
  expect(systemAccentHue('url(example.com)')).toBeNull()
})
