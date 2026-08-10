import { describe, expect, it } from 'vitest'
// @ts-expect-error -- JavaScript packaging script intentionally has no declarations
import { serializeFlatpakCargoSources } from '../../scripts/normalize-flatpak-cargo-sources.mjs'

describe('serializeFlatpakCargoSources', () => {
  it('serializes with two-space indent and a trailing newline', () => {
    const out = serializeFlatpakCargoSources([{ type: 'archive' }])
    expect(out).toBe('[\n  {\n    "type": "archive"\n  }\n]\n')
  })

  it('rejects a malformed generator output', () => {
    expect(() => serializeFlatpakCargoSources({})).toThrow(
      'Flatpak Cargo sources must be an array'
    )
  })
})
