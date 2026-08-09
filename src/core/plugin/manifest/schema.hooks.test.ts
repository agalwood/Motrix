// Hooks contribution + BoundedJsonSchema bounds tests.
// Covers Batch 1 audit findings C1 (HookContributionSchema) and C2 (bounds).
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
  hostPermissions: ['*://*/*'],
}

function withHooks(hooks: unknown) {
  return { ...MINIMAL, contributes: { hooks } }
}

describe('ManifestSchema — hooks contribution (C1)', () => {
  it('accepts a valid hooks entry with enrich role', () => {
    const m = ManifestSchema.parse(
      withHooks({ beforeCreate: { role: 'enrich' } })
    )
    const hooks = m.contributes.hooks as Record<string, { role: string }>
    expect(hooks.beforeCreate.role).toBe('enrich')
  })

  it('accepts every spec-defined role on a recognized hook', () => {
    for (const role of [
      'pre-resolve',
      'resolve',
      'enrich',
      'post-process',
      'audit',
    ]) {
      const m = ManifestSchema.parse(withHooks({ beforeCreate: { role } }))
      const hooks = m.contributes.hooks as Record<string, { role: string }>
      expect(hooks.beforeCreate.role).toBe(role)
    }
  })

  it('rejects an unknown role enum value', () => {
    const r = ManifestSchema.safeParse(
      withHooks({ beforeCreate: { role: 'bogus' } })
    )
    expect(r.success).toBe(false)
  })

  it('rejects an unknown hook name', () => {
    const r = ManifestSchema.safeParse(
      withHooks({ randomHook: { role: 'enrich' } })
    )
    expect(r.success).toBe(false)
  })

  it('rejects unknown extra keys inside a hook entry (strict)', () => {
    const r = ManifestSchema.safeParse(
      withHooks({ beforeCreate: { role: 'enrich', priority: 100 } })
    )
    expect(r.success).toBe(false)
  })

  it('accepts every recognized hook name', () => {
    const m = ManifestSchema.parse(
      withHooks({
        beforeCreate: { role: 'enrich' },
        beforeFinalize: { role: 'post-process' },
        afterComplete: { role: 'audit' },
        onError: { role: 'audit' },
      })
    )
    const hooks = m.contributes.hooks as Record<string, { role: string }>
    expect(hooks.beforeFinalize.role).toBe('post-process')
    expect(hooks.afterComplete.role).toBe('audit')
    expect(hooks.onError.role).toBe('audit')
  })

  it('requires role when a hook entry is present', () => {
    // Empty object → role missing → reject. Plugin code paths that participate
    // without declaring a role default to 'enrich' at the runtime layer
    // (HookOrchestrator), not at the manifest schema layer.
    const r = ManifestSchema.safeParse(withHooks({ beforeCreate: {} }))
    expect(r.success).toBe(false)
  })

  it('allows the hooks key to be absent entirely', () => {
    const m = ManifestSchema.parse({ ...MINIMAL, contributes: {} })
    expect(m.contributes.hooks).toBeUndefined()
  })
})

describe('BoundedJsonSchema bounds (C2)', () => {
  function withArgsSchema(argsSchema: unknown) {
    return {
      ...MINIMAL,
      contributes: {
        commands: [
          {
            id: 'alice.demo.cmd',
            title: 'Cmd',
            public: false,
            argsSchema,
          },
        ],
      },
    }
  }

  it('rejects argsSchema serialized > 8 KB', () => {
    // Build a wide flat properties bag whose serialized form exceeds 8 KB.
    const properties: Record<string, unknown> = {}
    for (let i = 0; i < 200; i++) {
      properties[`field_${i}_long_field_name_to_inflate_payload`] = {
        type: 'string',
        pattern: '^[a-z0-9-]{1,64}$',
        description: 'this description text exists to add weight to the bytes',
      }
    }
    const r = ManifestSchema.safeParse(
      withArgsSchema({ type: 'object', properties })
    )
    expect(r.success).toBe(false)
    if (!r.success) {
      const msgs = r.error.issues.map((i) => i.message).join('|')
      expect(msgs).toContain('plugin.manifest.bounded_schema_invalid')
    }
  })

  it('rejects argsSchema with nesting depth > 8', () => {
    // Build properties chain 10 levels deep.
    let inner: Record<string, unknown> = { type: 'string' }
    for (let i = 0; i < 10; i++) {
      inner = { type: 'object', properties: { nest: inner } }
    }
    const r = ManifestSchema.safeParse(withArgsSchema(inner))
    expect(r.success).toBe(false)
    if (!r.success) {
      const msgs = r.error.issues.map((i) => i.message).join('|')
      expect(msgs).toContain('plugin.manifest.bounded_schema_invalid')
    }
  })

  it('rejects argsSchema with > 128 properties at one level', () => {
    const properties: Record<string, unknown> = {}
    for (let i = 0; i < 200; i++) {
      properties[`p${i}`] = { type: 'string' }
    }
    const r = ManifestSchema.safeParse(
      withArgsSchema({ type: 'object', properties })
    )
    expect(r.success).toBe(false)
    if (!r.success) {
      const msgs = r.error.issues.map((i) => i.message).join('|')
      expect(msgs).toContain('plugin.manifest.bounded_schema_invalid')
    }
  })

  it('rejects argsSchema whose combined enum entries exceed 256', () => {
    // Spread enums across nested properties to test combined cap.
    const properties: Record<string, unknown> = {}
    for (let i = 0; i < 5; i++) {
      properties[`field_${i}`] = {
        type: 'string',
        enum: Array.from({ length: 60 }, (_, j) => `v_${i}_${j}`),
      }
    }
    const r = ManifestSchema.safeParse(
      withArgsSchema({ type: 'object', properties })
    )
    expect(r.success).toBe(false)
    if (!r.success) {
      const msgs = r.error.issues.map((i) => i.message).join('|')
      expect(msgs).toContain('plugin.manifest.bounded_schema_invalid')
    }
  })

  it('accepts a moderately-sized argsSchema near but under all caps', () => {
    const properties: Record<string, unknown> = {}
    for (let i = 0; i < 20; i++) {
      properties[`field_${i}`] = {
        type: 'string',
        enum: ['a', 'b', 'c'],
      }
    }
    const m = ManifestSchema.parse(
      withArgsSchema({ type: 'object', properties })
    )
    expect(m.contributes.commands?.[0]?.argsSchema).toBeDefined()
  })

  it('accepts a deeply-nested argsSchema exactly at depth 8', () => {
    let inner: Record<string, unknown> = { type: 'string' }
    for (let i = 0; i < 7; i++) {
      inner = { type: 'object', properties: { nest: inner } }
    }
    // Wrapped 7 times around a leaf → 8 levels total counting the leaf.
    const m = ManifestSchema.parse(withArgsSchema(inner))
    expect(m.contributes.commands?.[0]?.argsSchema).toBeDefined()
  })
})
