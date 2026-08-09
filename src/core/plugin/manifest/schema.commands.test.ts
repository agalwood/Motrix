// src/core/plugin/manifest/schema.commands.test.ts
import { describe, expect, it } from 'vitest'
import { PluginManifestInvalid } from './errors'
import { parseManifest } from './parse'
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

function withCommands(commands: unknown[]) {
  return { ...MINIMAL, contributes: { commands } }
}

function basicArgsSchema() {
  return {
    type: 'object',
    properties: { name: { type: 'string' } },
    required: ['name'],
  }
}

function basicResultSchema() {
  return { type: 'object', properties: { ok: { type: 'boolean' } } }
}

describe('ManifestSchema — commands contribution', () => {
  it('accepts public:true with both argsSchema and resultSchema', () => {
    const m = ManifestSchema.parse(
      withCommands([
        {
          id: 'alice.demo.greet',
          title: 'Greet',
          public: true,
          argsSchema: basicArgsSchema(),
          resultSchema: basicResultSchema(),
        },
      ])
    )
    expect(m.contributes.commands?.[0]?.public).toBe(true)
  })

  it('rejects public:true missing argsSchema with public_missing_schema', () => {
    const result = ManifestSchema.safeParse(
      withCommands([
        {
          id: 'alice.demo.greet',
          title: 'Greet',
          public: true,
          resultSchema: basicResultSchema(),
        },
      ])
    )
    expect(result.success).toBe(false)
    if (!result.success) {
      const msgs = result.error.issues.map((i) => i.message).join('|')
      expect(msgs).toContain('plugin.manifest.command.public_missing_schema')
    }
  })

  it('rejects public:true missing resultSchema with public_missing_schema', () => {
    const result = ManifestSchema.safeParse(
      withCommands([
        {
          id: 'alice.demo.greet',
          title: 'Greet',
          public: true,
          argsSchema: basicArgsSchema(),
        },
      ])
    )
    expect(result.success).toBe(false)
    if (!result.success) {
      const msgs = result.error.issues.map((i) => i.message).join('|')
      expect(msgs).toContain('plugin.manifest.command.public_missing_schema')
    }
  })

  it('accepts public:false without schemas', () => {
    const m = ManifestSchema.parse(
      withCommands([{ id: 'alice.demo.greet', title: 'Greet', public: false }])
    )
    expect(m.contributes.commands?.[0]?.public).toBe(false)
  })

  it('public defaults to false when omitted', () => {
    const m = ManifestSchema.parse(
      withCommands([{ id: 'alice.demo.greet', title: 'Greet' }])
    )
    expect(m.contributes.commands?.[0]?.public).toBe(false)
  })

  it('rejects 33 public commands with too_many_public', () => {
    const cmds = Array.from({ length: 33 }, (_, i) => ({
      id: `alice.demo.pub${i}`,
      title: `Pub ${i}`,
      public: true,
      argsSchema: basicArgsSchema(),
      resultSchema: basicResultSchema(),
    }))
    const result = ManifestSchema.safeParse(withCommands(cmds))
    expect(result.success).toBe(false)
    if (!result.success) {
      const msgs = result.error.issues.map((i) => i.message).join('|')
      expect(msgs).toContain('plugin.manifest.command.too_many_public')
    }
  })

  it('accepts 64 total commands', () => {
    const cmds = Array.from({ length: 64 }, (_, i) => ({
      id: `alice.demo.cmd${i}`,
      title: `Cmd ${i}`,
    }))
    const m = ManifestSchema.parse(withCommands(cmds))
    expect(m.contributes.commands).toHaveLength(64)
  })

  it('rejects 65 total commands', () => {
    const cmds = Array.from({ length: 65 }, (_, i) => ({
      id: `alice.demo.cmd${i}`,
      title: `Cmd ${i}`,
    }))
    expect(() => ManifestSchema.parse(withCommands(cmds))).toThrow()
  })

  it('rejects $ref inside argsSchema (BoundedJsonSchema is strict)', () => {
    const result = ManifestSchema.safeParse(
      withCommands([
        {
          id: 'alice.demo.greet',
          title: 'Greet',
          public: false,
          argsSchema: { type: 'object', $ref: '#/defs/foo' },
        },
      ])
    )
    expect(result.success).toBe(false)
  })

  it('rejects oneOf inside argsSchema', () => {
    const result = ManifestSchema.safeParse(
      withCommands([
        {
          id: 'alice.demo.greet',
          title: 'Greet',
          public: false,
          argsSchema: {
            oneOf: [{ type: 'string' }, { type: 'number' }],
          },
        },
      ])
    )
    expect(result.success).toBe(false)
  })

  it('rejects anyOf / allOf / not inside argsSchema', () => {
    for (const banned of ['anyOf', 'allOf', 'not'] as const) {
      const result = ManifestSchema.safeParse(
        withCommands([
          {
            id: 'alice.demo.greet',
            title: 'Greet',
            public: false,
            argsSchema: { [banned]: { type: 'string' } },
          },
        ])
      )
      expect(result.success).toBe(false)
    }
  })

  it('accepts nested properties recursively in argsSchema', () => {
    const m = ManifestSchema.parse(
      withCommands([
        {
          id: 'alice.demo.greet',
          title: 'Greet',
          public: false,
          argsSchema: {
            type: 'object',
            properties: {
              user: {
                type: 'object',
                properties: {
                  name: { type: 'string', minLength: 1, maxLength: 64 },
                  age: { type: 'integer', minimum: 0, maximum: 150 },
                  tags: {
                    type: 'array',
                    items: { type: 'string', pattern: '^[a-z]+$' },
                  },
                },
                required: ['name'],
                additionalProperties: false,
              },
            },
            required: ['user'],
          },
        },
      ])
    )
    expect(m.contributes.commands?.[0]?.argsSchema).toBeDefined()
  })

  it('accepts additionalProperties as a nested BoundedJsonSchema', () => {
    const m = ManifestSchema.parse(
      withCommands([
        {
          id: 'alice.demo.greet',
          title: 'Greet',
          public: false,
          argsSchema: {
            type: 'object',
            additionalProperties: { type: 'string', maxLength: 32 },
          },
        },
      ])
    )
    expect(m.contributes.commands?.[0]?.argsSchema).toBeDefined()
  })

  it('rejects unknown keys inside command (strict)', () => {
    const result = ManifestSchema.safeParse(
      withCommands([
        { id: 'alice.demo.greet', title: 'Greet', extraKey: 'nope' },
      ])
    )
    expect(result.success).toBe(false)
  })

  it('rejects bad command id format (uppercase / wrong shape)', () => {
    expect(() =>
      ManifestSchema.parse(
        withCommands([{ id: 'Alice.Demo.Greet', title: 'Greet' }])
      )
    ).toThrow()
    expect(() =>
      ManifestSchema.parse(withCommands([{ id: 'no-dots', title: 'X' }]))
    ).toThrow()
    expect(() =>
      ManifestSchema.parse(withCommands([{ id: 'alice.demo.', title: 'X' }]))
    ).toThrow()
  })

  it('rejects command id not prefixed with manifest.id via parseManifest', () => {
    const raw = JSON.stringify({
      ...MINIMAL,
      contributes: {
        commands: [{ id: 'bob.other.greet', title: 'Greet' }],
      },
    })
    expect.assertions(2)
    try {
      parseManifest(raw, { hostVersion: '2.5.0' })
    } catch (e) {
      expect(e).toBeInstanceOf(PluginManifestInvalid)
      expect((e as PluginManifestInvalid).validationCode).toBe(
        'plugin.manifest.command.id_out_of_namespace'
      )
    }
  })

  it('accepts command id correctly prefixed with manifest.id via parseManifest', () => {
    const raw = JSON.stringify({
      ...MINIMAL,
      contributes: {
        commands: [{ id: 'alice.demo.greet', title: 'Greet' }],
      },
    })
    const r = parseManifest(raw, { hostVersion: '2.5.0' })
    expect(r.manifest.contributes.commands?.[0]?.id).toBe('alice.demo.greet')
  })
})
