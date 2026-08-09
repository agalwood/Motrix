// Tests for m3 (audit) — schema-hash canonicalization. Spec §2 L504-505.

import type { PluginManifest } from '@shared/types/plugin'
import { describe, expect, it } from 'vitest'
import { canonicalize, computePublicCommandHashes } from './public-command-hash'

function manifest(commands: unknown[]): PluginManifest {
  return {
    manifestVersion: 1,
    id: 'alice.demo',
    name: 'Demo',
    version: '1.0.0',
    description: 'd',
    categories: ['integration'],
    engines: { motrix: '>=2.0.0' },
    main: 'dist/plugin.js',
    permissions: [],
    activationEvents: ['onStartup'],
    contributes: {
      commands: commands as PluginManifest['contributes']['commands'],
    },
  }
}

describe('canonicalize', () => {
  it('sorts object keys recursively', () => {
    const a = canonicalize({ b: 1, a: { y: 2, x: 1 } })
    expect(JSON.stringify(a)).toBe('{"a":{"x":1,"y":2},"b":1}')
  })

  it('preserves array order', () => {
    const a = canonicalize({ enum: ['c', 'b', 'a'] })
    expect(JSON.stringify(a)).toBe('{"enum":["c","b","a"]}')
  })

  it('handles primitives and null', () => {
    expect(canonicalize('x')).toBe('x')
    expect(canonicalize(42)).toBe(42)
    expect(canonicalize(true)).toBe(true)
    expect(canonicalize(null)).toBe(null)
  })
})

describe('computePublicCommandHashes', () => {
  it('produces identical hashes for key-order-only diffs', () => {
    const m1 = manifest([
      {
        id: 'alice.demo.greet',
        title: 'Greet',
        public: true,
        argsSchema: {
          type: 'object',
          properties: { name: { type: 'string', maxLength: 64 } },
          required: ['name'],
        },
        resultSchema: { type: 'string' },
      },
    ])
    const m2 = manifest([
      {
        id: 'alice.demo.greet',
        title: 'Greet',
        public: true,
        // Same schema, keys in different order.
        argsSchema: {
          required: ['name'],
          properties: { name: { maxLength: 64, type: 'string' } },
          type: 'object',
        },
        resultSchema: { type: 'string' },
      },
    ])
    const h1 = computePublicCommandHashes(m1)
    const h2 = computePublicCommandHashes(m2)
    expect(h1['alice.demo.greet']).toBe(h2['alice.demo.greet'])
  })

  it('produces different hashes when schema shape genuinely changes', () => {
    const m1 = manifest([
      {
        id: 'alice.demo.greet',
        title: 'Greet',
        public: true,
        argsSchema: { type: 'object', properties: { a: { type: 'string' } } },
        resultSchema: { type: 'string' },
      },
    ])
    const m2 = manifest([
      {
        id: 'alice.demo.greet',
        title: 'Greet',
        public: true,
        argsSchema: { type: 'object', properties: { a: { type: 'number' } } },
        resultSchema: { type: 'string' },
      },
    ])
    expect(computePublicCommandHashes(m1)['alice.demo.greet']).not.toBe(
      computePublicCommandHashes(m2)['alice.demo.greet']
    )
  })

  it('omits private commands from the hash map', () => {
    const m = manifest([
      { id: 'alice.demo.private', title: 'X', public: false },
      {
        id: 'alice.demo.public',
        title: 'Y',
        public: true,
        argsSchema: { type: 'string' },
        resultSchema: { type: 'string' },
      },
    ])
    const h = computePublicCommandHashes(m)
    expect(Object.keys(h)).toEqual(['alice.demo.public'])
  })
})
