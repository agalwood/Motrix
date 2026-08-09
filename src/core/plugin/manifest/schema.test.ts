// src/core/plugin/manifest/schema.test.ts
import { describe, expect, it } from 'vitest'
import { ManifestSchema } from './schema'

const MINIMAL = {
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
}

describe('ManifestSchema', () => {
  it('accepts a minimal valid manifest', () => {
    expect(ManifestSchema.parse(MINIMAL)).toBeDefined()
  })
  it('rejects unknown top-level field', () => {
    expect(() => ManifestSchema.parse({ ...MINIMAL, foo: 1 })).toThrow()
  })
  it('rejects bad id format', () => {
    expect(() => ManifestSchema.parse({ ...MINIMAL, id: 'Bad.Id' })).toThrow()
  })
  it('accepts reserved publisher at the schema layer (parseManifest enforces by origin)', () => {
    // RESERVED_PUBLISHERS is no longer enforced inside ManifestSchema so that
    // built-in plugins (origin === 'builtin') can claim motrix.* ids. The
    // reservation is enforced in parseManifest based on origin.
    expect(ManifestSchema.parse({ ...MINIMAL, id: 'motrix.foo' })).toBeDefined()
  })
  it('rejects log/i18n in permissions (auto-injected)', () => {
    expect(() =>
      ManifestSchema.parse({ ...MINIMAL, permissions: ['log'] })
    ).toThrow()
  })
  it('passes through unknown contributes keys', () => {
    const m = ManifestSchema.parse({
      ...MINIMAL,
      contributes: { commands: [], themes: { foo: 'bar' } },
    })
    expect((m.contributes as Record<string, unknown>).themes).toEqual({
      foo: 'bar',
    })
  })
  it('rejects manifestVersion != 1', () => {
    expect(() =>
      ManifestSchema.parse({ ...MINIMAL, manifestVersion: 2 })
    ).toThrow()
  })
})
