import { describe, expect, it } from 'vitest'
import { browserDisplayName } from './browser-name'

describe('browserDisplayName', () => {
  it('names each browser family the way every surface must', () => {
    expect(browserDisplayName('chromium')).toBe('Chrome / Edge')
    expect(browserDisplayName('firefox')).toBe('Firefox')
  })
})
