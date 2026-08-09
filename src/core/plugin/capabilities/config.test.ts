// Tests for ConfigCapabilityHost — value resolver, secret decrypt, onChange.

import { describe, expect, it, vi } from 'vitest'
import type { ConfigOptions } from './config'
import { ConfigCapabilityHost, ConfigError } from './config'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeHost(
  stored: Record<string, unknown>,
  overrides: Partial<ConfigOptions> = {}
) {
  const opts: ConfigOptions = {
    pluginId: 'test-plugin',
    readValues: () => stored,
    schemaDefaults: { theme: 'dark', timeout: 30 },
    secretFields: new Set(['apiKey']),
    ...overrides,
  }
  return new ConfigCapabilityHost(opts)
}

// ---------------------------------------------------------------------------
// ConfigError
// ---------------------------------------------------------------------------

describe('ConfigError', () => {
  it('has code property and extends Error', () => {
    const err = new ConfigError('plugin.lifecycle.secrets_seed_missing', 'oops')
    expect(err.code).toBe('plugin.lifecycle.secrets_seed_missing')
    expect(err).toBeInstanceOf(Error)
    expect(err.name).toBe('ConfigError')
    expect(err.message).toBe('oops')
  })
})

// ---------------------------------------------------------------------------
// get — value resolution
// ---------------------------------------------------------------------------

describe('ConfigCapabilityHost.get', () => {
  it('returns stored value when present (no default fallback)', async () => {
    const host = makeHost({ theme: 'light' })
    await expect(host.get('theme')).resolves.toBe('light')
  })

  it('returns schema default when no stored value', async () => {
    const host = makeHost({})
    await expect(host.get('timeout')).resolves.toBe(30)
  })

  it('returns undefined when neither stored nor default', async () => {
    const host = makeHost({})
    await expect(host.get('nonexistent')).resolves.toBeUndefined()
  })

  it('decrypts secret field when stored value is a string', async () => {
    const decryptSecret = vi.fn(async (_c: string) => 'plaintext-key')
    const host = makeHost(
      { apiKey: 'cipher123' },
      { secretFields: new Set(['apiKey']), decryptSecret }
    )
    const result = await host.get('apiKey')
    expect(result).toBe('plaintext-key')
    expect(decryptSecret).toHaveBeenCalledWith('cipher123')
  })

  it('throws secrets_seed_missing when secret field has stored string but no decryptSecret', async () => {
    const host = makeHost(
      { apiKey: 'cipher123' },
      { secretFields: new Set(['apiKey']), decryptSecret: undefined }
    )
    await expect(host.get('apiKey')).rejects.toMatchObject({
      code: 'plugin.lifecycle.secrets_seed_missing',
    })
  })

  it('does not decrypt non-string secret value (numeric default)', async () => {
    // A numeric value in a secret field should pass through as-is.
    const decryptSecret = vi.fn(async (_c: string) => 'should-not-be-called')
    const host = makeHost(
      {},
      {
        schemaDefaults: { apiVersion: 42 },
        secretFields: new Set(['apiVersion']),
        decryptSecret,
      }
    )
    const result = await host.get('apiVersion')
    expect(result).toBe(42)
    expect(decryptSecret).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// getRaw
// ---------------------------------------------------------------------------

describe('ConfigCapabilityHost.getRaw', () => {
  it('returns stored value when present', async () => {
    const host = makeHost({ theme: 'light' })
    await expect(host.getRaw('theme')).resolves.toBe('light')
  })

  it('returns undefined when not stored, even if default exists', async () => {
    const host = makeHost({})
    // 'timeout' has a schema default of 30 but is not stored
    await expect(host.getRaw('timeout')).resolves.toBeUndefined()
  })

  it('returns ciphertext verbatim for secret field (no decrypt)', async () => {
    const decryptSecret = vi.fn(async (_c: string) => 'should-not-be-called')
    const host = makeHost(
      { apiKey: 'cipher123' },
      { secretFields: new Set(['apiKey']), decryptSecret }
    )
    const result = await host.getRaw('apiKey')
    expect(result).toBe('cipher123')
    expect(decryptSecret).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// getAll
// ---------------------------------------------------------------------------

describe('ConfigCapabilityHost.getAll', () => {
  it('merges defaults and stored, stored wins', async () => {
    const host = makeHost(
      { theme: 'light' },
      {
        schemaDefaults: { theme: 'dark', timeout: 30 },
        secretFields: new Set(),
      }
    )
    const all = await host.getAll()
    expect(all).toEqual({ theme: 'light', timeout: 30 })
  })

  it('decrypts secret fields in the merged result', async () => {
    const decryptSecret = vi.fn(async (c: string) => `decrypted:${c}`)
    const host = makeHost(
      { apiKey: 'cipher999' },
      {
        schemaDefaults: { apiKey: undefined },
        secretFields: new Set(['apiKey']),
        decryptSecret,
      }
    )
    const all = await host.getAll()
    expect(all.apiKey).toBe('decrypted:cipher999')
  })
})

// ---------------------------------------------------------------------------
// onChange / applyExternalChange
// ---------------------------------------------------------------------------

describe('ConfigCapabilityHost.onChange', () => {
  it('fires handler on applyExternalChange', () => {
    const stored: Record<string, unknown> = {}
    const host = makeHost(stored, { secretFields: new Set() })
    const calls: unknown[] = []
    host.onChange((changes) => calls.push(changes))

    const changes = [{ key: 'theme', value: 'light', previous: 'dark' }]
    host.applyExternalChange(changes)

    expect(calls).toHaveLength(1)
    expect(calls[0]).toEqual(changes)
  })

  it('dispose removes handler; subsequent applyExternalChange does not fire it', () => {
    const stored: Record<string, unknown> = {}
    const host = makeHost(stored, { secretFields: new Set() })
    const calls: unknown[] = []
    const reg = host.onChange((changes) => calls.push(changes))

    reg.dispose()
    host.applyExternalChange([
      { key: 'theme', value: 'light', previous: 'dark' },
    ])

    expect(calls).toHaveLength(0)
  })

  it('two handlers both fire', () => {
    const stored: Record<string, unknown> = {}
    const host = makeHost(stored, { secretFields: new Set() })
    const calls1: unknown[] = []
    const calls2: unknown[] = []
    host.onChange((changes) => calls1.push(changes))
    host.onChange((changes) => calls2.push(changes))

    const changes = [{ key: 'theme', value: 'light', previous: 'dark' }]
    host.applyExternalChange(changes)

    expect(calls1).toHaveLength(1)
    expect(calls2).toHaveLength(1)
  })

  it('handler that throws is caught; subsequent handlers still fire', () => {
    const stored: Record<string, unknown> = {}
    const host = makeHost(stored, { secretFields: new Set() })
    const calls: unknown[] = []
    host.onChange(() => {
      throw new Error('bad handler')
    })
    host.onChange((changes) => calls.push(changes))

    const changes = [{ key: 'theme', value: 'light', previous: 'dark' }]
    expect(() => host.applyExternalChange(changes)).not.toThrow()
    expect(calls).toHaveLength(1)
  })
})
