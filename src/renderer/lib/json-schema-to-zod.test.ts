import { describe, expect, it } from 'vitest'
import { defaultFromSchema, jsonSchemaToZod } from './json-schema-to-zod'

describe('jsonSchemaToZod', () => {
  it('converts an object with required string + enum + boolean', () => {
    const s = jsonSchemaToZod({
      type: 'object',
      properties: {
        quality: { type: 'string', enum: ['1080p', '720p'] },
        verbose: { type: 'boolean', default: false },
      },
      required: ['quality'],
    })
    expect(s.safeParse({ quality: '1080p', verbose: true }).success).toBe(true)
    expect(s.safeParse({ verbose: true }).success).toBe(false)
  })

  it('honors integer min/max bounds', () => {
    const s = jsonSchemaToZod({
      type: 'object',
      properties: { port: { type: 'integer', minimum: 1, maximum: 65535 } },
      required: ['port'],
    })
    expect(s.safeParse({ port: 3000 }).success).toBe(true)
    expect(s.safeParse({ port: 0 }).success).toBe(false)
    expect(s.safeParse({ port: 70000 }).success).toBe(false)
    expect(s.safeParse({ port: 1.5 }).success).toBe(false)
  })

  it('honors string pattern + length constraints', () => {
    const s = jsonSchemaToZod({
      type: 'object',
      properties: {
        slug: {
          type: 'string',
          pattern: '^[a-z0-9-]+$',
          minLength: 3,
          maxLength: 12,
        },
      },
      required: ['slug'],
    })
    expect(s.safeParse({ slug: 'foo-bar' }).success).toBe(true)
    expect(s.safeParse({ slug: 'AB' }).success).toBe(false)
    expect(s.safeParse({ slug: 'has space' }).success).toBe(false)
  })

  it('arrays unwrap items recursively', () => {
    const s = jsonSchemaToZod({
      type: 'array',
      items: { type: 'string' },
    })
    expect(s.safeParse(['a', 'b']).success).toBe(true)
    expect(s.safeParse(['a', 1]).success).toBe(false)
  })

  it('rejects unknown keywords from outside the bounded subset', () => {
    expect(() =>
      jsonSchemaToZod({ $ref: 'foo' } as unknown as Parameters<
        typeof jsonSchemaToZod
      >[0])
    ).toThrow(/unsupported/)
  })

  it('defaultFromSchema picks property defaults only', () => {
    const defaults = defaultFromSchema({
      type: 'object',
      properties: {
        quality: { type: 'string', default: '1080p' },
        notes: { type: 'string' },
      },
    })
    expect(defaults).toEqual({ quality: '1080p' })
  })
})
