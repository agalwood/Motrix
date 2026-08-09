import { describe, expect, it } from 'vitest'
import { bandIndex, sortByBand } from './role-band'

describe('role-band', () => {
  it('orders bands deterministically', () => {
    expect(bandIndex('pre-resolve')).toBe(0)
    expect(bandIndex('audit')).toBe(4)
  })
  it('sortByBand sorts by band then plugin id', () => {
    const plugins = [
      { pluginId: 'z.x', role: 'enrich' as const },
      { pluginId: 'a.b', role: 'audit' as const },
      { pluginId: 'a.a', role: 'enrich' as const },
    ]
    const r = sortByBand(plugins).map((p) => p.pluginId)
    expect(r).toEqual(['a.a', 'z.x', 'a.b'])
  })
  it('throws on pre-resolve from non-builtin plugin', () => {
    expect(() => bandIndex('pre-resolve', { builtin: false })).toThrow(
      /requires_builtin/
    )
  })
})
