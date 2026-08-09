import { describe, expect, it } from 'vitest'
import { PluginEngineVersionTooOld, PluginManifestInvalid } from './errors'
import { parseManifest } from './parse'

const VALID_JSON = JSON.stringify({
  manifestVersion: 1,
  id: 'alice.demo',
  name: 'Demo',
  version: '1.0.0',
  description: 'd',
  categories: ['integration'],
  engines: { motrix: '>=2.0.0 <3.0.0' },
  main: 'dist/plugin.js',
  permissions: [],
  activationEvents: ['onStartup'],
  contributes: {},
})

describe('parseManifest', () => {
  it('parses a valid manifest', () => {
    const r = parseManifest(VALID_JSON, { hostVersion: '2.5.0' })
    expect(r.manifest.id).toBe('alice.demo')
  })

  it('throws PluginEngineVersionTooOld when host version below range', () => {
    expect(() => parseManifest(VALID_JSON, { hostVersion: '1.9.0' })).toThrow(
      PluginEngineVersionTooOld
    )
  })

  it('throws PluginManifestInvalid for syntactic JSON error', () => {
    expect(() => parseManifest('{ not json', { hostVersion: '2.5.0' })).toThrow(
      PluginManifestInvalid
    )
  })

  it('throws PluginManifestInvalid for schema violation', () => {
    expect(() =>
      parseManifest(JSON.stringify({ ...JSON.parse(VALID_JSON), id: 'BAD' }), {
        hostVersion: '2.5.0',
      })
    ).toThrow(PluginManifestInvalid)
  })

  it('engines check runs BEFORE schema check', () => {
    const bad = JSON.stringify({
      ...JSON.parse(VALID_JSON),
      id: 'BAD',
      engines: { motrix: '>=99.0.0' },
    })
    expect(() => parseManifest(bad, { hostVersion: '2.5.0' })).toThrow(
      PluginEngineVersionTooOld
    )
  })

  it('warnings collected for unknown contributes keys', () => {
    const m = JSON.stringify({
      ...JSON.parse(VALID_JSON),
      contributes: { themes: {} },
    })
    const r = parseManifest(m, { hostVersion: '2.5.0' })
    expect(r.warnings.some((w) => w.code === 'unknown-contributes-key')).toBe(
      true
    )
  })

  describe('reserved publisher (origin gate)', () => {
    const RESERVED = JSON.stringify({
      ...JSON.parse(VALID_JSON),
      id: 'motrix.demo',
    })

    it('rejects motrix.* when origin is community (default)', () => {
      expect(() => parseManifest(RESERVED, { hostVersion: '2.5.0' })).toThrow(
        PluginManifestInvalid
      )
    })

    it('rejects motrix.* when origin is explicitly community', () => {
      expect(() =>
        parseManifest(RESERVED, {
          hostVersion: '2.5.0',
          origin: 'community',
        })
      ).toThrow(PluginManifestInvalid)
    })

    it('accepts motrix.* when origin is builtin', () => {
      const r = parseManifest(RESERVED, {
        hostVersion: '2.5.0',
        origin: 'builtin',
      })
      expect(r.manifest.id).toBe('motrix.demo')
    })

    it('builtin origin still rejects bad schema (motrix.* with invalid version)', () => {
      const bad = JSON.stringify({
        ...JSON.parse(RESERVED),
        version: 'not-semver',
      })
      expect(() =>
        parseManifest(bad, { hostVersion: '2.5.0', origin: 'builtin' })
      ).toThrow(PluginManifestInvalid)
    })
  })
})
