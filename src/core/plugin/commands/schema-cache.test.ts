// src/core/plugin/commands/schema-cache.test.ts
import { AppError, ErrorCode } from '@shared/errors'
import { describe, expect, it } from 'vitest'
import { SchemaCache } from './schema-cache'

const argsSchema = {
  type: 'object',
  properties: {
    name: { type: 'string' },
    age: { type: 'integer' },
  },
  required: ['name'],
  additionalProperties: false,
}

const resultSchema = {
  type: 'object',
  properties: { ok: { type: 'boolean' } },
  required: ['ok'],
  additionalProperties: false,
}

function publicCmd(id = 'greet') {
  return { id, argsSchema, resultSchema, public: true }
}

describe('SchemaCache', () => {
  it('validates valid args without throwing', () => {
    const cache = new SchemaCache()
    cache.installCommandSchemas('alice.demo', [publicCmd()])
    expect(() =>
      cache.validateArgs('alice.demo', 'greet', { name: 'Bob', age: 12 })
    ).not.toThrow()
  })

  it('throws args_invalid when a required field is missing', () => {
    const cache = new SchemaCache()
    cache.installCommandSchemas('alice.demo', [publicCmd()])
    try {
      cache.validateArgs('alice.demo', 'greet', { age: 12 })
      throw new Error('expected throw')
    } catch (e) {
      expect(e).toBeInstanceOf(AppError)
      const err = e as AppError
      expect(err.code).toBe(ErrorCode.PluginRuntimeFault)
      expect(err.message).toMatch(/^plugin\.command\.args_invalid: /)
      expect(err.message).toContain('name')
    }
  })

  it('throws args_invalid when a field has the wrong type', () => {
    const cache = new SchemaCache()
    cache.installCommandSchemas('alice.demo', [publicCmd()])
    try {
      cache.validateArgs('alice.demo', 'greet', {
        name: 'Bob',
        age: 'not-a-number',
      })
      throw new Error('expected throw')
    } catch (e) {
      expect(e).toBeInstanceOf(AppError)
      const err = e as AppError
      expect(err.code).toBe(ErrorCode.PluginRuntimeFault)
      expect(err.message).toMatch(/^plugin\.command\.args_invalid: /)
    }
  })

  it('validateResult returns silently when no validator is installed', () => {
    const cache = new SchemaCache()
    // No installCommandSchemas call at all.
    expect(() =>
      cache.validateResult('alice.demo', 'greet', { anything: true })
    ).not.toThrow()
  })

  it('validateResult throws result_invalid on shape mismatch', () => {
    const cache = new SchemaCache()
    cache.installCommandSchemas('alice.demo', [publicCmd()])
    try {
      cache.validateResult('alice.demo', 'greet', { ok: 'yes' })
      throw new Error('expected throw')
    } catch (e) {
      expect(e).toBeInstanceOf(AppError)
      const err = e as AppError
      expect(err.code).toBe(ErrorCode.PluginRuntimeFault)
      expect(err.message).toMatch(/^plugin\.command\.result_invalid: /)
    }
  })

  it('validateArgs throws not_public when commandId is unknown', () => {
    const cache = new SchemaCache()
    cache.installCommandSchemas('alice.demo', [publicCmd()])
    try {
      cache.validateArgs('alice.demo', 'does-not-exist', { name: 'Bob' })
      throw new Error('expected throw')
    } catch (e) {
      expect(e).toBeInstanceOf(AppError)
      const err = e as AppError
      expect(err.code).toBe(ErrorCode.PluginRuntimeFault)
      expect(err.message).toBe('plugin.command.not_public')
    }
  })

  it('validateArgs throws not_public when pluginId is unknown', () => {
    const cache = new SchemaCache()
    try {
      cache.validateArgs('bob.unknown', 'greet', { name: 'Bob' })
      throw new Error('expected throw')
    } catch (e) {
      expect(e).toBeInstanceOf(AppError)
      const err = e as AppError
      expect(err.code).toBe(ErrorCode.PluginRuntimeFault)
      expect(err.message).toBe('plugin.command.not_public')
    }
  })

  it('does not compile a non-public command', () => {
    const cache = new SchemaCache()
    cache.installCommandSchemas('alice.demo', [
      { id: 'private-cmd', argsSchema, resultSchema, public: false },
    ])
    expect(() =>
      cache.validateArgs('alice.demo', 'private-cmd', { name: 'Bob' })
    ).toThrowError(/plugin\.command\.not_public/)
  })

  it('does not compile a public command lacking argsSchema', () => {
    const cache = new SchemaCache()
    cache.installCommandSchemas('alice.demo', [
      { id: 'partial', resultSchema, public: true },
    ])
    expect(() => cache.validateArgs('alice.demo', 'partial', {})).toThrowError(
      /plugin\.command\.not_public/
    )
  })

  it('wraps Ajv compile failure as schema_compile_failed', () => {
    const cache = new SchemaCache()
    const badSchema = {
      type: 'object',
      properties: { foo: { type: 'unknown_type_xyz' } },
    }
    try {
      cache.installCommandSchemas('alice.demo', [
        { id: 'bad', argsSchema: badSchema, resultSchema, public: true },
      ])
      throw new Error('expected throw')
    } catch (e) {
      expect(e).toBeInstanceOf(AppError)
      const err = e as AppError
      expect(err.code).toBe(ErrorCode.PluginManifestInvalid)
      expect(err.message).toBe('plugin.command.schema_compile_failed: bad')
      expect(err.cause).toBeDefined()
    }
  })

  it('uninstall removes a plugin’s validators', () => {
    const cache = new SchemaCache()
    cache.installCommandSchemas('alice.demo', [publicCmd()])
    cache.uninstall('alice.demo')
    expect(() =>
      cache.validateArgs('alice.demo', 'greet', { name: 'Bob' })
    ).toThrowError(/plugin\.command\.not_public/)
  })

  it('uninstall is a no-op for an unknown pluginId', () => {
    const cache = new SchemaCache()
    expect(() => cache.uninstall('never.installed')).not.toThrow()
  })

  it('reinstall replaces previous validators', () => {
    const cache = new SchemaCache()
    cache.installCommandSchemas('alice.demo', [publicCmd()])
    // New version of greet: requires `target` (number) instead of `name` (string).
    const newArgs = {
      type: 'object',
      properties: { target: { type: 'integer' } },
      required: ['target'],
      additionalProperties: false,
    }
    cache.installCommandSchemas('alice.demo', [
      { id: 'greet', argsSchema: newArgs, resultSchema, public: true },
    ])
    // Old shape should now fail.
    expect(() =>
      cache.validateArgs('alice.demo', 'greet', { name: 'Bob' })
    ).toThrowError(/plugin\.command\.args_invalid: /)
    // New shape should pass.
    expect(() =>
      cache.validateArgs('alice.demo', 'greet', { target: 42 })
    ).not.toThrow()
  })
})
