import { describe, expect, it } from 'vitest'
import { INCOMPLETE_SUFFIX, MAX_DEDUP_ATTEMPTS } from './incomplete'

describe('incomplete constants', () => {
  it('exports INCOMPLETE_SUFFIX = ".motrix"', () => {
    expect(INCOMPLETE_SUFFIX).toBe('.motrix')
  })

  it('exports MAX_DEDUP_ATTEMPTS = 9999', () => {
    expect(MAX_DEDUP_ATTEMPTS).toBe(9999)
  })
})
