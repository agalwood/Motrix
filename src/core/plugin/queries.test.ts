// Provider helpers for the four new Phase 1A queries surfaced via IPC:
//   - GetPluginConfig
//   - GetContributionIndex
//   - CheckPluginCompatibility
//   - GetPluginHookRank
//
// These tests pin behavior independently of the IPC transport.

import type { PluginManifest } from '@shared/types/plugin'
import { describe, expect, it } from 'vitest'
import {
  buildContributionIndex,
  checkPluginCompatibility,
  computePluginHookRank,
  type IndexedPluginLike,
} from './queries'

function fakeManifest(over: Partial<PluginManifest>): PluginManifest {
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
    contributes: {},
    ...over,
  }
}

function fakeIndexed(over: Partial<IndexedPluginLike>): IndexedPluginLike {
  return {
    manifest: fakeManifest({}),
    origin: 'community',
    enabled: true,
    ...over,
  }
}

// ---------------------------------------------------------------------------
// checkPluginCompatibility
// ---------------------------------------------------------------------------

describe('checkPluginCompatibility', () => {
  it('returns ok when engines.motrix is satisfied', () => {
    const m = fakeManifest({ engines: { motrix: '>=2.0.0 <3.0.0' } })
    const r = checkPluginCompatibility(m, '2.5.0')
    expect(r.ok).toBe(true)
    expect(r.code).toBeUndefined()
  })

  it('returns engine_version_too_old when host is below required min', () => {
    const m = fakeManifest({ engines: { motrix: '>=2.5.0' } })
    const r = checkPluginCompatibility(m, '2.0.0')
    expect(r.ok).toBe(false)
    expect(r.code).toBe('plugin.manifest.engine_version_too_old')
  })

  it('returns engine_version_too_old when host is above required upper bound', () => {
    const m = fakeManifest({ engines: { motrix: '>=2.0.0 <2.5.0' } })
    const r = checkPluginCompatibility(m, '3.0.0')
    expect(r.ok).toBe(false)
    expect(r.code).toBe('plugin.manifest.engine_version_too_old')
  })

  it('returns ok with no warnings when only required permissions are present', () => {
    const m = fakeManifest({ permissions: ['http'] })
    const r = checkPluginCompatibility(m, '2.5.0')
    expect(r.ok).toBe(true)
  })

  it('flags permission_unsupported on community plugin requesting `exec`', () => {
    const m = fakeManifest({ permissions: ['exec'] })
    const r = checkPluginCompatibility(m, '2.5.0')
    expect(r.ok).toBe(false)
    expect(r.code).toBe('plugin.manifest.permissions.unsupported_on_runtime')
  })
})

// ---------------------------------------------------------------------------
// buildContributionIndex
// ---------------------------------------------------------------------------

describe('buildContributionIndex', () => {
  it('returns empty arrays when no plugins are indexed', () => {
    const idx = buildContributionIndex([])
    expect(idx.commands).toEqual([])
    expect(idx.hooks).toEqual([])
    expect(idx.configurations).toEqual([])
  })

  it('skips disabled plugins entirely', () => {
    const p = fakeIndexed({
      enabled: false,
      manifest: fakeManifest({
        id: 'alice.disabled',
        contributes: {
          commands: [{ id: 'alice.disabled.x', title: 'X' }],
        },
      }),
    })
    const idx = buildContributionIndex([p])
    expect(idx.commands).toEqual([])
  })

  it('lists commands grouped by pluginId for enabled plugins', () => {
    const p = fakeIndexed({
      manifest: fakeManifest({
        id: 'alice.demo',
        contributes: {
          commands: [
            { id: 'alice.demo.greet', title: 'Greet', public: true },
            { id: 'alice.demo.flush', title: 'Flush', public: false },
          ],
        },
      }),
    })
    const idx = buildContributionIndex([p])
    expect(idx.commands).toEqual([
      {
        pluginId: 'alice.demo',
        commandId: 'alice.demo.greet',
        title: 'Greet',
        public: true,
      },
      {
        pluginId: 'alice.demo',
        commandId: 'alice.demo.flush',
        title: 'Flush',
        public: false,
      },
    ])
  })

  it('lists hooks with role bands', () => {
    const p = fakeIndexed({
      manifest: fakeManifest({
        id: 'alice.demo',
        categories: ['site-resolver'],
        hostPermissions: ['*://*/*'],
        contributes: {
          hooks: {
            beforeCreate: { role: 'resolve' },
            onError: { role: 'audit' },
          },
        },
      }),
    })
    const idx = buildContributionIndex([p])
    expect(idx.hooks).toEqual([
      { pluginId: 'alice.demo', hook: 'beforeCreate', role: 'resolve' },
      { pluginId: 'alice.demo', hook: 'onError', role: 'audit' },
    ])
  })

  it('lists configurations only when contributes.configuration is set', () => {
    const withCfg = fakeIndexed({
      manifest: fakeManifest({
        id: 'alice.cfg',
        contributes: {
          configuration: {
            title: 'Settings',
            schema: { type: 'object' },
          },
        },
      }),
    })
    const withoutCfg = fakeIndexed({
      manifest: fakeManifest({ id: 'alice.no-cfg' }),
    })
    const idx = buildContributionIndex([withCfg, withoutCfg])
    expect(idx.configurations.map((c) => c.pluginId)).toEqual(['alice.cfg'])
  })
})

// ---------------------------------------------------------------------------
// computePluginHookRank
// ---------------------------------------------------------------------------

describe('computePluginHookRank', () => {
  // Three plugins all participating in beforeCreate, sorted by role-band then
  // lexically: resolve(alice) → enrich(bob) → audit(charlie)
  const a = fakeIndexed({
    manifest: fakeManifest({
      id: 'alice.resolver',
      categories: ['site-resolver'],
      hostPermissions: ['*://*/*'],
      contributes: { hooks: { beforeCreate: { role: 'resolve' } } },
    }),
  })
  const b = fakeIndexed({
    manifest: fakeManifest({
      id: 'bob.enricher',
      hostPermissions: ['*://*/*'],
      contributes: { hooks: { beforeCreate: { role: 'enrich' } } },
    }),
  })
  const c = fakeIndexed({
    manifest: fakeManifest({
      id: 'charlie.auditor',
      hostPermissions: ['*://*/*'],
      contributes: { hooks: { beforeCreate: { role: 'audit' } } },
    }),
  })

  it('places the resolve plugin at rank 1 of 3', () => {
    const r = computePluginHookRank([a, b, c], 'alice.resolver', 'beforeCreate')
    expect(r).toEqual({
      rank: 1,
      total: 3,
      role: 'resolve',
    })
  })

  it('places the enrich plugin at rank 2 of 3', () => {
    const r = computePluginHookRank([a, b, c], 'bob.enricher', 'beforeCreate')
    expect(r).toEqual({
      rank: 2,
      total: 3,
      role: 'enrich',
    })
  })

  it('places the audit plugin at rank 3 of 3', () => {
    const r = computePluginHookRank(
      [a, b, c],
      'charlie.auditor',
      'beforeCreate'
    )
    expect(r).toEqual({
      rank: 3,
      total: 3,
      role: 'audit',
    })
  })

  it('returns null when the plugin does not participate in the hook', () => {
    const r = computePluginHookRank([a, b, c], 'alice.resolver', 'onError')
    expect(r).toBeNull()
  })

  it('returns null when the plugin is unknown', () => {
    const r = computePluginHookRank([a, b, c], 'nobody', 'beforeCreate')
    expect(r).toBeNull()
  })

  it('ignores disabled plugins from the total count', () => {
    const disabled = fakeIndexed({
      enabled: false,
      manifest: fakeManifest({
        id: 'd.skipped',
        hostPermissions: ['*://*/*'],
        contributes: { hooks: { beforeCreate: { role: 'enrich' } } },
      }),
    })
    const r = computePluginHookRank(
      [a, b, c, disabled],
      'bob.enricher',
      'beforeCreate'
    )
    expect(r?.total).toBe(3)
  })

  it('sorts ties within a band by plugin id (lexical ASC) for stable rank', () => {
    const e1 = fakeIndexed({
      manifest: fakeManifest({
        id: 'beta.enricher',
        hostPermissions: ['*://*/*'],
        contributes: { hooks: { beforeCreate: { role: 'enrich' } } },
      }),
    })
    const e2 = fakeIndexed({
      manifest: fakeManifest({
        id: 'alpha.enricher',
        hostPermissions: ['*://*/*'],
        contributes: { hooks: { beforeCreate: { role: 'enrich' } } },
      }),
    })
    // alpha must be rank 1; beta rank 2.
    expect(
      computePluginHookRank([e1, e2], 'alpha.enricher', 'beforeCreate')?.rank
    ).toBe(1)
    expect(
      computePluginHookRank([e1, e2], 'beta.enricher', 'beforeCreate')?.rank
    ).toBe(2)
  })
})
