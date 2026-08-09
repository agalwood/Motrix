// Parse-time invariants on top of the strict schema.
// Covers Batch 1 audit findings M1 (hostPermissions required for hooks),
// M2 (unknown activation events warn), and the hook role eligibility refine
// that completes C1.
import { describe, expect, it } from 'vitest'
import { PluginManifestInvalid } from './errors'
import { parseManifest } from './parse'

const BASE = {
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

function withOverrides(overrides: Record<string, unknown>): string {
  return JSON.stringify({ ...BASE, ...overrides })
}

function findCode(e: unknown): string | undefined {
  return e instanceof PluginManifestInvalid ? e.validationCode : undefined
}

describe('parseManifest — hostPermissions required when hooks declared (M1)', () => {
  it('rejects a hook-declaring manifest with empty hostPermissions', () => {
    const raw = withOverrides({
      contributes: { hooks: { beforeCreate: { role: 'enrich' } } },
      hostPermissions: [],
    })
    expect.assertions(2)
    try {
      parseManifest(raw, { hostVersion: '2.5.0' })
    } catch (e) {
      expect(e).toBeInstanceOf(PluginManifestInvalid)
      expect(findCode(e)).toBe(
        'plugin.manifest.host_permissions_required_for_hooks'
      )
    }
  })

  it('rejects a hook-declaring manifest with hostPermissions omitted', () => {
    const raw = withOverrides({
      contributes: { hooks: { beforeCreate: { role: 'enrich' } } },
    })
    expect.assertions(2)
    try {
      parseManifest(raw, { hostVersion: '2.5.0' })
    } catch (e) {
      expect(e).toBeInstanceOf(PluginManifestInvalid)
      expect(findCode(e)).toBe(
        'plugin.manifest.host_permissions_required_for_hooks'
      )
    }
  })

  it('accepts hook-declaring manifest with at least one hostPermissions entry', () => {
    const raw = withOverrides({
      contributes: { hooks: { beforeCreate: { role: 'enrich' } } },
      hostPermissions: ['*://example.com/*'],
    })
    const r = parseManifest(raw, { hostVersion: '2.5.0' })
    const hooks = r.manifest.contributes.hooks as Record<
      string,
      { role: string }
    >
    expect(hooks.beforeCreate.role).toBe('enrich')
  })

  it('accepts a commands-only manifest without hostPermissions', () => {
    const raw = withOverrides({
      contributes: {
        commands: [{ id: 'alice.demo.cmd', title: 'Cmd' }],
      },
    })
    const r = parseManifest(raw, { hostVersion: '2.5.0' })
    expect(r.manifest.contributes.commands).toHaveLength(1)
  })
})

describe('parseManifest — hook role eligibility (C1)', () => {
  it('rejects pre-resolve role for community plugins', () => {
    const raw = withOverrides({
      contributes: { hooks: { beforeCreate: { role: 'pre-resolve' } } },
      hostPermissions: ['*://example.com/*'],
    })
    expect.assertions(2)
    try {
      parseManifest(raw, { hostVersion: '2.5.0', origin: 'community' })
    } catch (e) {
      expect(e).toBeInstanceOf(PluginManifestInvalid)
      expect(findCode(e)).toBe('plugin.manifest.role.requires_builtin')
    }
  })

  it('accepts pre-resolve role when origin is builtin', () => {
    const raw = JSON.stringify({
      ...BASE,
      id: 'motrix.demo',
      contributes: { hooks: { beforeCreate: { role: 'pre-resolve' } } },
      hostPermissions: ['*://example.com/*'],
    })
    const r = parseManifest(raw, { hostVersion: '2.5.0', origin: 'builtin' })
    const hooks = r.manifest.contributes.hooks as Record<
      string,
      { role: string }
    >
    expect(hooks.beforeCreate.role).toBe('pre-resolve')
  })

  it('rejects resolve role without site-resolver category', () => {
    const raw = withOverrides({
      categories: ['integration'],
      contributes: { hooks: { beforeCreate: { role: 'resolve' } } },
      hostPermissions: ['*://example.com/*'],
    })
    expect.assertions(2)
    try {
      parseManifest(raw, { hostVersion: '2.5.0' })
    } catch (e) {
      expect(e).toBeInstanceOf(PluginManifestInvalid)
      expect(findCode(e)).toBe('plugin.manifest.role.requires_category')
    }
  })

  it('accepts resolve role when site-resolver is in categories', () => {
    const raw = withOverrides({
      categories: ['site-resolver'],
      contributes: { hooks: { beforeCreate: { role: 'resolve' } } },
      hostPermissions: ['*://example.com/*'],
    })
    const r = parseManifest(raw, { hostVersion: '2.5.0' })
    const hooks = r.manifest.contributes.hooks as Record<
      string,
      { role: string }
    >
    expect(hooks.beforeCreate.role).toBe('resolve')
  })

  it('rejects post-process role without post-action category', () => {
    const raw = withOverrides({
      categories: ['integration'],
      contributes: {
        hooks: { beforeFinalize: { role: 'post-process' } },
      },
      hostPermissions: ['*://example.com/*'],
    })
    expect.assertions(2)
    try {
      parseManifest(raw, { hostVersion: '2.5.0' })
    } catch (e) {
      expect(e).toBeInstanceOf(PluginManifestInvalid)
      expect(findCode(e)).toBe('plugin.manifest.role.requires_category')
    }
  })

  it('accepts post-process role when post-action is in categories', () => {
    const raw = withOverrides({
      categories: ['post-action'],
      contributes: {
        hooks: { beforeFinalize: { role: 'post-process' } },
      },
      hostPermissions: ['*://example.com/*'],
    })
    const r = parseManifest(raw, { hostVersion: '2.5.0' })
    const hooks = r.manifest.contributes.hooks as Record<
      string,
      { role: string }
    >
    expect(hooks.beforeFinalize.role).toBe('post-process')
  })

  it('accepts audit role on any category', () => {
    const raw = withOverrides({
      categories: ['integration'],
      contributes: { hooks: { onError: { role: 'audit' } } },
      hostPermissions: ['*://example.com/*'],
    })
    const r = parseManifest(raw, { hostVersion: '2.5.0' })
    const hooks = r.manifest.contributes.hooks as Record<
      string,
      { role: string }
    >
    expect(hooks.onError.role).toBe('audit')
  })
})

describe('parseManifest — unknown activation events warn (M2)', () => {
  it('does NOT throw for a future event token', () => {
    const raw = withOverrides({
      activationEvents: ['onStartup', 'onSettingsOpen'],
    })
    const r = parseManifest(raw, { hostVersion: '2.5.0' })
    expect(r.warnings.some((w) => w.code === 'unknown-activation-event')).toBe(
      true
    )
  })

  it('emits one warning per unknown token, naming the token', () => {
    const raw = withOverrides({
      activationEvents: ['onStartup', 'onSettingsOpen', 'onMystery'],
    })
    const r = parseManifest(raw, { hostVersion: '2.5.0' })
    const unknown = r.warnings.filter(
      (w) => w.code === 'unknown-activation-event'
    )
    expect(unknown).toHaveLength(2)
    expect(unknown.map((w) => w.key).sort()).toEqual([
      'onMystery',
      'onSettingsOpen',
    ])
  })

  it('accepts all spec-defined Phase 1A tokens without warnings', () => {
    const raw = withOverrides({
      activationEvents: [
        '*',
        'onStartup',
        'onCommand:alice.demo.cmd',
        'onTaskType:http',
        'onProtocol:https',
      ],
    })
    const r = parseManifest(raw, { hostVersion: '2.5.0' })
    expect(
      r.warnings.filter((w) => w.code === 'unknown-activation-event')
    ).toHaveLength(0)
  })

  it('accepts each Phase 1B event token (forward-compat) with a warning', () => {
    const raw = withOverrides({
      activationEvents: [
        'onStartup',
        'onSettingsOpen',
        'onTaskComplete',
        'onTaskError',
      ],
    })
    const r = parseManifest(raw, { hostVersion: '2.5.0' })
    expect(
      r.warnings.filter((w) => w.code === 'unknown-activation-event')
    ).toHaveLength(3)
  })
})
