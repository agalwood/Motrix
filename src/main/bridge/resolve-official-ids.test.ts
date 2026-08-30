import { describe, expect, it } from 'vitest'
import { resolveOfficialIds } from './index'

describe('resolveOfficialIds', () => {
  it('returns true only for an id+browser pair in the allowlist', () => {
    const isOfficialId = resolveOfficialIds([
      { id: 'aaa', browser: 'chromium' },
      { id: 'b@c', browser: 'firefox' },
    ])

    expect(isOfficialId('chromium', 'aaa')).toBe(true)
    expect(isOfficialId('firefox', 'b@c')).toBe(true)
    expect(isOfficialId('chromium', 'unknown')).toBe(false)
  })

  it('does not cross browsers — the same id under a different browser is not official', () => {
    const isOfficialId = resolveOfficialIds([
      { id: 'aaa', browser: 'chromium' },
    ])

    expect(isOfficialId('firefox', 'aaa')).toBe(false)
  })

  it('returns false for every id against an empty allowlist', () => {
    const isOfficialId = resolveOfficialIds([])

    expect(isOfficialId('chromium', 'aaa')).toBe(false)
    expect(isOfficialId('firefox', 'b@c')).toBe(false)
  })
})
