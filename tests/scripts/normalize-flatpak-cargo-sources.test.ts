import { describe, expect, it } from 'vitest'
// @ts-expect-error -- JavaScript packaging script intentionally has no declarations
import {
  mergeFlatpakCargoSources,
  serializeFlatpakCargoSources,
} from '../../scripts/normalize-flatpak-cargo-sources.mjs'

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

describe('mergeFlatpakCargoSources', () => {
  const archive = { type: 'archive', dest: 'cargo/vendor/a-1', sha256: 'a' }
  const checksum = {
    type: 'inline',
    dest: 'cargo/vendor/a-1',
    'dest-filename': '.cargo-checksum.json',
    contents: 'a',
  }
  const config = {
    type: 'inline',
    dest: 'cargo',
    'dest-filename': 'config',
    contents: 'registry',
  }
  it('merges both locks deterministically without duplicating registry config', () => {
    const additional = { ...archive, dest: 'cargo/vendor/b-1' }
    expect(
      mergeFlatpakCargoSources(
        [config, checksum, archive],
        [additional, archive, config]
      )
    ).toEqual([archive, checksum, additional, config])
  })
  it('rejects conflicting checksums or registry config', () => {
    expect(() =>
      mergeFlatpakCargoSources([archive], [{ ...archive, sha256: 'b' }])
    ).toThrow('Conflicting Cargo source')
    expect(() =>
      mergeFlatpakCargoSources([config], [{ ...config, contents: 'different' }])
    ).toThrow('Conflicting Cargo source')
  })
})
