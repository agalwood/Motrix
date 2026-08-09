import type { InstallRecord } from '@shared/types/plugin-install'
import { describe, expect, it } from 'vitest'
import {
  isServerAckSatisfied,
  parseAllowlist,
  type ServerAckCtx,
} from './server-ack'

function emptyCtx(over: Partial<ServerAckCtx> = {}): ServerAckCtx {
  return { allowlist: [], blanketBypass: false, ...over }
}

function makeRecord(): InstallRecord {
  return {
    version: 1,
    pluginId: 'com.example.plugin',
    source: {
      type: 'github',
      url: 'https://github.com/example/plugin',
      bundleSha256: 'a'.repeat(64),
      recordedAt: 0,
    },
    grants: {},
    consentSnapshot: {
      permissions: [],
      optionalPermissions: [],
      invokesCommands: [],
      publicCommands: {},
      requestedHeapMB: 32,
      enginesMotrix: '^2.0.0',
      hostPermissions: [],
    },
  }
}

describe('isServerAckSatisfied', () => {
  it('accepts when a prior install record exists (operator already acked)', () => {
    expect(
      isServerAckSatisfied(
        { type: 'github', url: 'https://github.com/example/plugin' },
        makeRecord(),
        emptyCtx()
      )
    ).toEqual({ ok: true })
  })

  it('fails closed when nothing matches', () => {
    expect(
      isServerAckSatisfied(
        { type: 'github', url: 'https://github.com/example/plugin' },
        null,
        emptyCtx()
      )
    ).toEqual({ ok: false, reason: 'plugin.lifecycle.unsigned_not_allowed' })
  })

  it('accepts when blanketBypass is on', () => {
    expect(
      isServerAckSatisfied(
        { type: 'url', url: 'https://untrusted.example/x.moext' },
        null,
        emptyCtx({ blanketBypass: true })
      )
    ).toEqual({ ok: true })
  })

  it('accepts when allowlist entry matches scheme + host + path prefix', () => {
    expect(
      isServerAckSatisfied(
        { type: 'github', url: 'https://github.com/example/plugin' },
        null,
        emptyCtx({ allowlist: ['https://github.com/example'] })
      )
    ).toEqual({ ok: true })
  })

  it('rejects when allowlist host matches but path does not', () => {
    expect(
      isServerAckSatisfied(
        { type: 'github', url: 'https://github.com/other/plugin' },
        null,
        emptyCtx({ allowlist: ['https://github.com/example'] })
      ).ok
    ).toBe(false)
  })

  it('rejects allowlist patterns that lack a scheme', () => {
    expect(
      isServerAckSatisfied(
        { type: 'url', url: 'https://example.com/widgets/foo' },
        null,
        emptyCtx({ allowlist: ['example.com/widgets'] })
      ).ok
    ).toBe(false)
  })

  it('rejects allowlist entry when scheme mismatches', () => {
    expect(
      isServerAckSatisfied(
        { type: 'url', url: 'http://example.com' },
        null,
        emptyCtx({ allowlist: ['https://example.com'] })
      ).ok
    ).toBe(false)
  })
})

describe('parseAllowlist', () => {
  it('returns [] for undefined or empty string', () => {
    expect(parseAllowlist(undefined)).toEqual([])
    expect(parseAllowlist('')).toEqual([])
    expect(parseAllowlist('   ')).toEqual([])
  })

  it('parses comma-separated values, trimming whitespace', () => {
    expect(parseAllowlist('  a , b ,c,')).toEqual(['a', 'b', 'c'])
  })

  it('parses a JSON array', () => {
    expect(parseAllowlist('["x", "y"]')).toEqual(['x', 'y'])
  })

  it('returns [] when JSON array contains non-strings', () => {
    expect(parseAllowlist('[1, 2]')).toEqual([])
  })

  it('returns [] for malformed JSON', () => {
    expect(parseAllowlist('[broken')).toEqual([])
  })
})
