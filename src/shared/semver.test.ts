import { describe, expect, it } from 'vitest'
import { compareSemver, semverGt } from './semver'

describe('compareSemver', () => {
  it('orders numeric triples', () => {
    expect(compareSemver('1.2.3', '1.2.2')).toBe(1)
    expect(compareSemver('2.0.0', '1.9.9')).toBe(1)
    expect(compareSemver('1.2.3', '1.2.3')).toBe(0)
    expect(compareSemver('1.2.3', '1.10.0')).toBe(-1)
  })

  it('sorts a prerelease below its release', () => {
    expect(compareSemver('1.0.0', '1.0.0-rc.1')).toBe(1)
    expect(compareSemver('1.0.0-rc.1', '1.0.0')).toBe(-1)
  })

  it('compares prerelease identifiers per semver §11', () => {
    expect(compareSemver('1.0.0-alpha.1', '1.0.0-alpha')).toBe(1)
    expect(compareSemver('1.0.0-alpha.10', '1.0.0-alpha.2')).toBe(1)
    expect(compareSemver('1.0.0-alpha', '1.0.0-1')).toBe(1) // numeric < alpha
    expect(compareSemver('1.0.0-beta', '1.0.0-alpha')).toBe(1)
  })

  it('ignores build metadata', () => {
    expect(compareSemver('1.0.0+build.5', '1.0.0')).toBe(0)
  })

  it('treats unparseable cores as unorderable', () => {
    expect(compareSemver('garbage', '1.0.0')).toBe(0)
  })

  it('treats a core segment with trailing garbage as unorderable', () => {
    expect(compareSemver('1.2.4a', '1.2.3')).toBe(0)
    expect(semverGt('1.2.4a', '1.2.3')).toBe(false)
  })
})

describe('semverGt', () => {
  it('is strict greater-than', () => {
    expect(semverGt('1.1.0', '1.0.0')).toBe(true)
    expect(semverGt('1.0.0', '1.0.0')).toBe(false)
    expect(semverGt('garbage', '1.0.0')).toBe(false)
  })
})
