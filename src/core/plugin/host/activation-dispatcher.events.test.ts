import { ErrorCode } from '@shared/errors'
import type { PluginListDTO, PluginManifest } from '@shared/types/plugin'
import { describe, expect, it, vi } from 'vitest'
import type { IndexedPlugin } from '../plugin-registry'
import {
  ActivationDispatcher,
  type ActivationDispatcherEmitter,
  type HostActivationEvent,
} from './activation-dispatcher'
import type { ActiveMeta } from './plugin-host'

// ---------------------------------------------------------------------------
// Mock builders (mirrors activation-dispatcher.test.ts helpers)
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

function makeEmitter(): {
  emitter: ActivationDispatcherEmitter
  mock: ReturnType<typeof vi.fn>
} {
  const mock = vi.fn()
  const emitter = { emit: mock } as unknown as ActivationDispatcherEmitter
  return { emitter, mock }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

const startupEvent: HostActivationEvent = { kind: 'startup' }

describe('ActivationDispatcher — event emission', () => {
  describe('eviction emits plugin.evicted per evicted plugin', () => {
    it('calls emitter twice with reason "cap" when two plugins are evicted', async () => {
      const now = Date.now()
      const evictableMeta: ActiveMeta[] = [
        {
          id: 'evict-a',
          lastActivityAt: now - 200_000,
          idleMs: 200_000,
          evictionTier: 'audit',
        },
        {
          id: 'evict-b',
          lastActivityAt: now - 180_000,
          idleMs: 180_000,
          evictionTier: 'audit',
        },
      ]

      const state: MockHostState = {
        activeIds: evictableMeta.map((m) => m.id),
        meta: [...evictableMeta],
      }
      const host = makeMockHost(state)

      // 2 new plugins need to fit into a cap-2 host that's already full.
      const registry = makeMockRegistry([
        { manifest: makeManifest('new-a') },
        { manifest: makeManifest('new-b') },
      ])
      const { emitter, mock } = makeEmitter()
      const dispatcher = new ActivationDispatcher(
        registry as never,
        host as never,
        { maxActive: 2, emitter }
      )

      await dispatcher.admit(['new-a', 'new-b'], startupEvent)

      expect(mock).toHaveBeenCalledTimes(2)
      expect(mock).toHaveBeenCalledWith('plugin.evicted', {
        pluginId: 'evict-a',
        reason: 'cap',
      })
      expect(mock).toHaveBeenCalledWith('plugin.evicted', {
        pluginId: 'evict-b',
        reason: 'cap',
      })
    })
  })

  describe('fail-closed emits plugin.activation_cap_exceeded once', () => {
    it('emits cap-exceeded and throws AppError when freed < slotsNeeded', async () => {
      // Protect all active plugins so eviction can free nothing.
      class AllCriticalDispatcher extends ActivationDispatcher {
        protected deriveCriticalSet() {
          return new Set(['critical-a', 'critical-b'])
        }
      }

      const now = Date.now()
      const criticalMeta: ActiveMeta[] = [
        {
          id: 'critical-a',
          lastActivityAt: now - 200_000,
          idleMs: 200_000,
          evictionTier: 'audit',
        },
        {
          id: 'critical-b',
          lastActivityAt: now - 200_000,
          idleMs: 200_000,
          evictionTier: 'audit',
        },
      ]

      const state: MockHostState = {
        activeIds: criticalMeta.map((m) => m.id),
        meta: [...criticalMeta],
      }
      const host = makeMockHost(state)
      const registry = makeMockRegistry([{ manifest: makeManifest('new-p') }])
      const { emitter, mock } = makeEmitter()
      const dispatcher = new AllCriticalDispatcher(
        registry as never,
        host as never,
        { maxActive: 2, emitter }
      )

      await expect(
        dispatcher.admit(['new-p'], startupEvent)
      ).rejects.toMatchObject({
        code: ErrorCode.PluginActivationCapExceeded,
      })

      const capCalls = mock.mock.calls.filter(
        (c: unknown[]) => c[0] === 'plugin.activation_cap_exceeded'
      )
      expect(capCalls).toHaveLength(1)
      expect(capCalls[0]?.[1]).toMatchObject({ unfittable: ['new-p'] })
    })
  })

  describe('no emit when below cap', () => {
    it('does not call emitter when no eviction is needed', async () => {
      const state: MockHostState = { activeIds: [], meta: [] }
      const host = makeMockHost(state)
      const registry = makeMockRegistry([
        { manifest: makeManifest('p1') },
        { manifest: makeManifest('p2') },
      ])
      const { emitter, mock } = makeEmitter()
      const dispatcher = new ActivationDispatcher(
        registry as never,
        host as never,
        { maxActive: 32, emitter }
      )

      await dispatcher.dispatch(startupEvent)

      expect(mock).not.toHaveBeenCalled()
    })
  })
})
