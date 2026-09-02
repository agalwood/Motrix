import { AppError, ErrorCode } from '@shared/errors'
import type { PluginListDTO, PluginManifest } from '@shared/types/plugin'
import { describe, expect, it, vi } from 'vitest'
import type { IndexedPlugin } from '../plugin-registry'
import {
  ActivationDispatcher,
  type HostActivationEvent,
} from './activation-dispatcher'
import type { ActiveMeta } from './plugin-host'

// ---------------------------------------------------------------------------
// Mock builders
// ---------------------------------------------------------------------------

function makeManifest(
  id: string,
  overrides: Partial<PluginManifest> = {}
): PluginManifest {
  return {
    manifestVersion: 1,
    id,
    name: id,
    version: '1.0.0',
    description: '',
    categories: [],
    engines: { motrix: '>=2.0.0' },
    main: 'index.js',
    permissions: [],
    activationEvents: ['onStartup'],
    contributes: {},
    ...overrides,
  }
}

function makeIndexed(manifest: PluginManifest, enabled = true): IndexedPlugin {
  return {
    manifestRaw: manifest,
    manifest,
    origin: 'community',
    rootDir: `/tmp/plugins/${manifest.id}`,
    state: {
      pluginId: manifest.id,
      enabled,
      status: 'inactive',
      errorCount: 0,
      installedAt: 0,
    },
  }
}

function makeDto(id: string): PluginListDTO {
  return {
    id,
    name: id,
    version: '1.0.0',
    description: '',
    status: 'inactive',
    enabled: true,
    permissions: [],
    optionalPermissions: [],
    errorCount: 0,
  }
}

interface MockHostState {
  activeIds: string[]
  meta: ActiveMeta[]
}

function makeMockHost(state: MockHostState) {
  return {
    activeIds: () => [...state.activeIds],
    isActive: (id: string) => state.activeIds.includes(id),
    activeMeta: () => [...state.meta],
    activate: vi.fn(async (id: string) => {
      state.activeIds.push(id)
      state.meta.push({
        id,
        lastActivityAt: Date.now(),
        idleMs: 0,
        evictionTier: 'audit',
      })
    }),
    deactivate: vi.fn(async (id: string) => {
      state.activeIds = state.activeIds.filter((x) => x !== id)
      state.meta = state.meta.filter((m) => m.id !== id)
    }),
  }
}

function makeMockRegistry(
  plugins: Array<{ manifest: PluginManifest; enabled?: boolean }>
) {
  const indexed = new Map(
    plugins.map(({ manifest, enabled = true }) => [
      manifest.id,
      makeIndexed(manifest, enabled),
    ])
  )
  return {
    list: () => plugins.map(({ manifest }) => makeDto(manifest.id)),
    get: (id: string) => indexed.get(id),
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

const startupEvent: HostActivationEvent = { kind: 'startup' }

describe('ActivationDispatcher', () => {
  describe('below cap -- all activate successfully', () => {
    it('activates all 5 matching plugins when maxActive=32', async () => {
      const manifests = Array.from({ length: 5 }, (_, i) =>
        makeManifest(`plugin-${i}`)
      )
      const state: MockHostState = { activeIds: [], meta: [] }
      const host = makeMockHost(state)
      const registry = makeMockRegistry(
        manifests.map((manifest) => ({ manifest }))
      )
      const dispatcher = new ActivationDispatcher(
        registry as never,
        host as never
      )

      await dispatcher.dispatch(startupEvent)

      expect(state.activeIds).toHaveLength(5)
      expect(host.activate).toHaveBeenCalledTimes(5)
    })
  })

  describe('at cap -- eviction triggers', () => {
    it('evicts the audit-tier plugin to make room for the 33rd', async () => {
      // 32 already-active plugins: 31 'enrich' + 1 'audit'
      const now = Date.now()
      const auditMeta: ActiveMeta = {
        id: 'audit-plugin',
        lastActivityAt: now - 120_000, // 2 min idle -> will be picked by idle pass
        idleMs: 120_000,
        evictionTier: 'audit',
      }
      const enrichMeta: ActiveMeta[] = Array.from({ length: 31 }, (_, i) => ({
        id: `enrich-${i}`,
        lastActivityAt: now - 70_000,
        idleMs: 70_000,
        evictionTier: 'enrich' as const,
      }))

      const state: MockHostState = {
        activeIds: [auditMeta.id, ...enrichMeta.map((m) => m.id)],
        meta: [auditMeta, ...enrichMeta],
      }
      const host = makeMockHost(state)

      // 33rd plugin to admit
      const newManifest = makeManifest('new-plugin')
      const registry = makeMockRegistry([{ manifest: newManifest }])
      const dispatcher = new ActivationDispatcher(
        registry as never,
        host as never,
        { maxActive: 32 }
      )

      await dispatcher.admit(['new-plugin'], startupEvent)

      // audit-plugin should have been deactivated (it was idle > 60s)
      expect(host.deactivate).toHaveBeenCalledWith('audit-plugin')
      expect(host.activate).toHaveBeenCalledWith('new-plugin')
    })
  })

  describe('idle-LRU -- evicts oldest idle first', () => {
    it('picks the 200s-idle plugin over 70s-idle and 10s-idle', async () => {
      const now = Date.now()
      const plugins: ActiveMeta[] = [
        {
          id: 'idle-10s',
          lastActivityAt: now - 10_000,
          idleMs: 10_000,
          evictionTier: 'audit',
        },
        {
          id: 'idle-70s',
          lastActivityAt: now - 70_000,
          idleMs: 70_000,
          evictionTier: 'audit',
        },
        {
          id: 'idle-200s',
          lastActivityAt: now - 200_000,
          idleMs: 200_000,
          evictionTier: 'audit',
        },
      ]

      const state: MockHostState = {
        activeIds: plugins.map((p) => p.id),
        meta: plugins,
      }
      const host = makeMockHost(state)
      const registry = makeMockRegistry([
        { manifest: makeManifest('new-plugin') },
      ])
      const dispatcher = new ActivationDispatcher(
        registry as never,
        host as never,
        { maxActive: 3 }
      )

      await dispatcher.admit(['new-plugin'], startupEvent)

      // Only 1 slot needed. idle-200s should be evicted first.
      expect(host.deactivate).toHaveBeenCalledTimes(1)
      expect(host.deactivate).toHaveBeenCalledWith('idle-200s')
    })
  })

  describe('tier-aware fallback -- all plugins idle < 60s', () => {
    it('evicts audit-tier before enrich-tier when no idle > 60s candidates', async () => {
      const now = Date.now()
      const plugins: ActiveMeta[] = [
        {
          id: 'enrich-plugin',
          lastActivityAt: now - 30_000,
          idleMs: 30_000,
          evictionTier: 'enrich',
        },
        {
          id: 'audit-plugin',
          lastActivityAt: now - 20_000,
          idleMs: 20_000,
          evictionTier: 'audit',
        },
      ]

      const state: MockHostState = {
        activeIds: plugins.map((p) => p.id),
        meta: plugins,
      }
      const host = makeMockHost(state)
      const registry = makeMockRegistry([
        { manifest: makeManifest('new-plugin') },
      ])
      const dispatcher = new ActivationDispatcher(
        registry as never,
        host as never,
        { maxActive: 2 }
      )

      await dispatcher.admit(['new-plugin'], startupEvent)

      // No idle > 60s -> tier-aware pass. audit evicted, not enrich.
      expect(host.deactivate).toHaveBeenCalledTimes(1)
      expect(host.deactivate).toHaveBeenCalledWith('audit-plugin')
    })
  })

  describe('empty criticalSet -- eviction proceeds freely', () => {
    it('taskAdded event returns empty criticalSet, eviction can free slots', async () => {
      const now = Date.now()
      const auditMeta: ActiveMeta = {
        id: 'evictable',
        lastActivityAt: now - 90_000,
        idleMs: 90_000,
        evictionTier: 'audit',
      }

      const state: MockHostState = {
        activeIds: ['evictable'],
        meta: [auditMeta],
      }
      const host = makeMockHost(state)

      const newManifest = makeManifest('new-plugin', {
        activationEvents: ['onTaskType:http'],
        hostPermissions: ['<all_urls>'],
      })
      const registry = makeMockRegistry([{ manifest: newManifest }])
      const dispatcher = new ActivationDispatcher(
        registry as never,
        host as never,
        { maxActive: 1 }
      )

      const taskEvent: HostActivationEvent = {
        kind: 'taskAdded',
        taskType: 'http',
        url: 'https://example.com/file.zip',
      }

      await dispatcher.dispatch(taskEvent)

      expect(host.deactivate).toHaveBeenCalledWith('evictable')
      expect(host.activate).toHaveBeenCalledWith('new-plugin')
    })
  })

  describe('cap fail-closed -- throws when all candidates are in criticalSet', () => {
    it('throws PluginActivationCapExceeded when eviction cannot free enough slots', async () => {
      // Use a subclass to override deriveCriticalSet so everything is critical.
      class FullyCriticalDispatcher extends ActivationDispatcher {
        protected deriveCriticalSet() {
          return new Set(['critical-1', 'critical-2'])
        }
      }

      const now = Date.now()
      const plugins: ActiveMeta[] = [
        {
          id: 'critical-1',
          lastActivityAt: now - 200_000,
          idleMs: 200_000,
          evictionTier: 'audit',
        },
        {
          id: 'critical-2',
          lastActivityAt: now - 200_000,
          idleMs: 200_000,
          evictionTier: 'audit',
        },
      ]

      const state: MockHostState = {
        activeIds: ['critical-1', 'critical-2'],
        meta: plugins,
      }
      const host = makeMockHost(state)
      const registry = makeMockRegistry([
        { manifest: makeManifest('new-plugin') },
      ])
      const dispatcher = new FullyCriticalDispatcher(
        registry as never,
        host as never,
        { maxActive: 2 }
      )

      await expect(
        dispatcher.admit(['new-plugin'], startupEvent)
      ).rejects.toMatchObject({
        code: ErrorCode.PluginActivationCapExceeded,
      })
      // No plugins should have been deactivated.
      expect(host.deactivate).not.toHaveBeenCalled()
    })
  })

  describe('I23 -- implicit onCommand:<id> activation', () => {
    it('plugin with no explicit onCommand:<id> still activates on its command', async () => {
      const manifest = makeManifest('alice.cmds', {
        activationEvents: ['onStartup'],
        contributes: {
          commands: [{ id: 'alice.cmds.run', title: 'run' }],
        },
      })
      const state: MockHostState = { activeIds: [], meta: [] }
      const host = makeMockHost(state)
      const registry = makeMockRegistry([{ manifest }])
      const dispatcher = new ActivationDispatcher(
        registry as never,
        host as never
      )

      await dispatcher.dispatch({
        kind: 'command',
        commandId: 'alice.cmds.run',
      })

      expect(host.activate).toHaveBeenCalledWith('alice.cmds')
    })

    it('public command (with argsSchema + resultSchema) activates implicitly', async () => {
      const manifest = makeManifest('alice.public', {
        activationEvents: ['onStartup'],
        contributes: {
          commands: [
            {
              id: 'alice.public.greet',
              title: 'greet',
              public: true,
              argsSchema: { type: 'object' },
              resultSchema: { type: 'object' },
            },
          ],
        },
      })
      const state: MockHostState = { activeIds: [], meta: [] }
      const host = makeMockHost(state)
      const registry = makeMockRegistry([{ manifest }])
      const dispatcher = new ActivationDispatcher(
        registry as never,
        host as never
      )

      await dispatcher.dispatch({
        kind: 'command',
        commandId: 'alice.public.greet',
      })

      expect(host.activate).toHaveBeenCalledWith('alice.public')
    })

    it('multiple declared commands are all implicit activation tokens', async () => {
      const manifest = makeManifest('alice.multi', {
        activationEvents: ['onStartup'],
        contributes: {
          commands: [
            { id: 'alice.multi.a', title: 'a' },
            { id: 'alice.multi.b', title: 'b' },
          ],
        },
      })
      const state: MockHostState = { activeIds: [], meta: [] }
      const host = makeMockHost(state)
      const registry = makeMockRegistry([{ manifest }])
      const dispatcher = new ActivationDispatcher(
        registry as never,
        host as never
      )

      await dispatcher.dispatch({
        kind: 'command',
        commandId: 'alice.multi.b',
      })
      expect(host.activate).toHaveBeenCalledWith('alice.multi')

      // Reset both the mock counter and the simulated active state so the
      // dispatcher's already-active short-circuit doesn't mask the second
      // command's implicit activation.
      host.activate.mockClear()
      state.activeIds.length = 0
      state.meta.length = 0

      await dispatcher.dispatch({
        kind: 'command',
        commandId: 'alice.multi.a',
      })
      expect(host.activate).toHaveBeenCalledWith('alice.multi')
    })
  })

  describe('backward-compat dispatch', () => {
    it('does not re-activate already-active plugins', async () => {
      const manifest = makeManifest('already-active')
      const state: MockHostState = {
        activeIds: ['already-active'],
        meta: [
          {
            id: 'already-active',
            lastActivityAt: Date.now(),
            idleMs: 0,
            evictionTier: 'audit',
          },
        ],
      }
      const host = makeMockHost(state)
      const registry = makeMockRegistry([{ manifest }])
      const dispatcher = new ActivationDispatcher(
        registry as never,
        host as never
      )

      await dispatcher.dispatch(startupEvent)

      expect(host.activate).not.toHaveBeenCalled()
    })

    it('skips disabled plugins during dispatch', async () => {
      const manifest = makeManifest('disabled-plugin')
      const state: MockHostState = { activeIds: [], meta: [] }
      const host = makeMockHost(state)
      const registry = makeMockRegistry([{ manifest, enabled: false }])
      const dispatcher = new ActivationDispatcher(
        registry as never,
        host as never
      )

      await dispatcher.dispatch(startupEvent)

      expect(host.activate).not.toHaveBeenCalled()
    })

    it('activates a matching inactive plugin when below cap', async () => {
      const manifest = makeManifest('p1')
      const state: MockHostState = { activeIds: [], meta: [] }
      const host = makeMockHost(state)
      const registry = makeMockRegistry([{ manifest }])
      const dispatcher = new ActivationDispatcher(
        registry as never,
        host as never
      )

      await dispatcher.dispatch(startupEvent)

      expect(host.activate).toHaveBeenCalledWith('p1')
    })

    it('applies hostPermissions filter for taskAdded events', async () => {
      const manifest = makeManifest('url-scoped', {
        activationEvents: ['onTaskType:http'],
        hostPermissions: ['https://allowed.com/*'],
      })
      const state: MockHostState = { activeIds: [], meta: [] }
      const host = makeMockHost(state)
      const registry = makeMockRegistry([{ manifest }])
      const dispatcher = new ActivationDispatcher(
        registry as never,
        host as never
      )

      // Should NOT activate for a non-matching host
      await dispatcher.dispatch({
        kind: 'taskAdded',
        taskType: 'http',
        url: 'https://other.com/file.zip',
      })
      expect(host.activate).not.toHaveBeenCalled()

      // Should activate for the matching host
      await dispatcher.dispatch({
        kind: 'taskAdded',
        taskType: 'http',
        url: 'https://allowed.com/file.zip',
      })
      expect(host.activate).toHaveBeenCalledWith('url-scoped')
    })

    it('activates wildcard-scoped plugins for nested download paths', async () => {
      const manifest = makeManifest('nested-path', {
        activationEvents: ['onTaskType:http'],
        hostPermissions: ['*://*/*'],
      })
      const state: MockHostState = { activeIds: [], meta: [] }
      const host = makeMockHost(state)
      const registry = makeMockRegistry([{ manifest }])
      const dispatcher = new ActivationDispatcher(
        registry as never,
        host as never
      )

      await dispatcher.dispatch({
        kind: 'taskAdded',
        taskType: 'http',
        url: 'https://example.com/releases/v2/archive/file.zip',
      })

      expect(host.activate).toHaveBeenCalledWith('nested-path')
    })
  })

  describe('AppError typing', () => {
    it('PluginActivationCapExceeded is an AppError instance', async () => {
      // Override deriveCriticalSet to protect p1 so eviction cannot free the slot.
      class ProtectedDispatcher extends ActivationDispatcher {
        protected deriveCriticalSet() {
          return new Set(['p1'])
        }
      }

      const state: MockHostState = {
        activeIds: ['p1'],
        meta: [
          {
            id: 'p1',
            lastActivityAt: Date.now() - 200_000,
            idleMs: 200_000,
            evictionTier: 'audit',
          },
        ],
      }
      const host = makeMockHost(state)
      const registry = makeMockRegistry([{ manifest: makeManifest('p2') }])
      const dispatcher = new ProtectedDispatcher(
        registry as never,
        host as never,
        { maxActive: 1 }
      )

      let caught: unknown
      try {
        await dispatcher.admit(['p2'], startupEvent)
      } catch (e) {
        caught = e
      }

      expect(caught).toBeInstanceOf(AppError)
      expect((caught as AppError).code).toBe(
        ErrorCode.PluginActivationCapExceeded
      )
    })
  })
})
