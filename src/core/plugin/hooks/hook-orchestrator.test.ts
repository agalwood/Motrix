// src/core/plugin/hooks/hook-orchestrator.test.ts
// Unit tests for the Plan C HookOrchestrator. The orchestrator is the critical
// fan-out point for series + parallel chains; these tests exercise the
// fail-mode contract (resolve/audit/enrich error handling), the audit-view
// sanitization for audit-role plugins, the abort/timeout behaviour, and the
// parallel hook isolation.
//
// Mocking strategy: we substitute a minimal PluginHost shape that the
// orchestrator uses (allActive, invokeHook). The bridge/worker pair is mocked
// so newHookAbort can call notifyAbort without crashing. Real workers / VMs
// are not spawned here — that is T17's e2e responsibility.

import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import os from 'node:os'
import { join as pathJoin } from 'node:path'
import type { Worker } from 'node:worker_threads'
import type { PluginManifest } from '@shared/types/plugin'
import type {
  BeforeCreateHttpContextDTO,
  BeforeFinalizeContextDTO,
} from '@shared/types/plugin-hooks'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CircuitBreaker as RealCircuitBreaker } from '../circuit/circuit-breaker'
import type { CapabilityBridge } from '../host/capability-bridge'
import type { ActivePluginInfo, PluginHost } from '../host/plugin-host'
import {
  type CircuitBreaker,
  HookOrchestrator,
  type OrchestratorOptions,
} from './hook-orchestrator'
import { FfmpegStaging } from './staging-dir'

// ---------------------------------------------------------------------------
// Fixture types + helpers
// ---------------------------------------------------------------------------

type HookHandler = (args: {
  taskId: string
  signal: AbortSignal
  hook: string
  pluginId: string
  bridge: MockBridge
}) => void | Promise<void>

interface FixturePlugin {
  id: string
  role: 'pre-resolve' | 'resolve' | 'enrich' | 'post-process' | 'audit'
  hooks: ReadonlyArray<
    'beforeCreate' | 'beforeFinalize' | 'afterComplete' | 'onError'
  >
  hostPermissions?: ReadonlyArray<string>
  permissions?: ReadonlyArray<string>
  handler?: HookHandler
}

interface MockBridge {
  setHookContext: ReturnType<typeof vi.fn>
  clearHookContext: ReturnType<typeof vi.fn>
  notifyAbort: ReturnType<typeof vi.fn>
}

function makeManifest(p: FixturePlugin): PluginManifest {
  const hooks: Record<string, { role?: string }> = {}
  for (const h of p.hooks) hooks[h] = { role: p.role }
  return {
    manifestVersion: 1,
    id: p.id,
    name: p.id,
    version: '1.0.0',
    description: '',
    main: 'dist/plugin.js',
    permissions: p.permissions ?? [],
    hostPermissions: p.hostPermissions ?? ['<all_urls>'],
    activationEvents: [],
    engines: { motrix: '>=2.0.0 <3.0.0' },
    categories: [],
    contributes: { hooks },
  } as PluginManifest
}

function makeMockBridge(): MockBridge {
  return {
    setHookContext: vi.fn(),
    clearHookContext: vi.fn(),
    notifyAbort: vi.fn(),
  }
}

function makeMockWorker(): Worker {
  return {
    terminate: vi.fn(async () => 0),
    postMessage: vi.fn(),
    on: vi.fn(),
    off: vi.fn(),
    once: vi.fn(),
  } as unknown as Worker
}

interface MockHostExtras {
  invocations: Array<{ pluginId: string; hook: string }>
}

function makeMockHost(plugins: FixturePlugin[]): {
  host: PluginHost
  bridges: Map<string, MockBridge>
  extras: MockHostExtras
} {
  const bridges = new Map<string, MockBridge>()
  const extras: MockHostExtras = { invocations: [] }
  const active: ActivePluginInfo[] = plugins.map((p) => {
    const bridge = makeMockBridge()
    bridges.set(p.id, bridge)
    return {
      id: p.id,
      manifest: makeManifest(p),
      bridge: bridge as unknown as CapabilityBridge,
      worker: makeMockWorker(),
    }
  })

  const host: Partial<PluginHost> = {
    allActive: () => active,
    invokeHook: async (id, hook, args) => {
      extras.invocations.push({ pluginId: id, hook })
      const plugin = plugins.find((p) => p.id === id)
      const bridge = bridges.get(id)
      if (!plugin || !bridge) return
      if (plugin.handler) {
        await plugin.handler({
          taskId: args.taskId,
          signal: args.signal,
          hook,
          pluginId: id,
          bridge,
        })
      }
    },
    bridgeFor: (id: string) =>
      bridges.get(id) as unknown as CapabilityBridge | undefined,
    workerFor: () => undefined,
    disable: vi.fn(),
  }
  return { host: host as PluginHost, bridges, extras }
}

function makeBeforeCreateDto(
  partial: Partial<BeforeCreateHttpContextDTO> = {}
): BeforeCreateHttpContextDTO {
  return {
    type: 'http',
    sourceUrl: 'https://example.com/file.zip',
    createdBy: 'user',
    requestedAt: 1_700_000_000_000,
    uris: ['https://example.com/file.zip'],
    saveDir: '/downloads',
    headers: [],
    ...partial,
  } as BeforeCreateHttpContextDTO
}

function makeBeforeFinalizeDto(
  partial: Partial<BeforeFinalizeContextDTO> = {}
): BeforeFinalizeContextDTO {
  return {
    sourceUrl: 'https://example.com/file.zip',
    createdBy: 'user',
    requestedAt: 1_700_000_000_000,
    task: { id: 'task-1' } as never,
    filePath: '/downloads/file.zip',
    ...partial,
  } as BeforeFinalizeContextDTO
}

const TIMEOUTS = { series: 200, parallel: 500 }

const ORCH_OPTS_BASE = {
  pluginsDir: '/tmp/test-plugins',
  pluginStorageRootFor: (id: string) => `/tmp/test-plugins/${id}/storage`,
} as const

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('HookOrchestrator', () => {
  describe('runBeforeCreateHttp — happy path', () => {
    let host: PluginHost
    let bridges: Map<string, MockBridge>
    let extras: MockHostExtras

    beforeEach(() => {
      const mocks = makeMockHost([
        {
          id: 'plugin-resolve',
          role: 'resolve',
          hooks: ['beforeCreate'],
          handler: async ({ bridge, pluginId }) => {
            // resolve picks a CDN mirror
            const ctx = bridge.setHookContext.mock.calls[0]?.[0]
            ctx.staged.appendHttp(pluginId, 'resolve', {
              uris: ['https://cdn.example.com/file.zip'],
            })
          },
        },
        {
          id: 'plugin-enrich',
          role: 'enrich',
          hooks: ['beforeCreate'],
          handler: async ({ bridge, pluginId }) => {
            // enrich adds a Referer header
            const ctx = bridge.setHookContext.mock.calls[0]?.[0]
            ctx.staged.appendHttp(pluginId, 'enrich', {
              headers: [{ name: 'Referer', value: 'https://example.com/' }],
            })
          },
        },
        {
          id: 'plugin-audit',
          role: 'audit',
          hooks: ['beforeCreate'],
        },
      ])
      host = mocks.host
      bridges = mocks.bridges
      extras = mocks.extras
    })

    it('runs eligible plugins in role-band order and merges staged effects', async () => {
      const orch = new HookOrchestrator({
        host,
        hookTimeoutMs: TIMEOUTS,
        ...ORCH_OPTS_BASE,
      })
      const result = await orch.runBeforeCreateHttp(
        makeBeforeCreateDto(),
        'task-1'
      )
      if (result.aborted) throw new Error('expected non-aborted result')
      expect(extras.invocations.map((i) => i.pluginId)).toEqual([
        'plugin-resolve',
        'plugin-enrich',
        'plugin-audit',
      ])
      expect(result.final.uris).toEqual(['https://cdn.example.com/file.zip'])
      expect(
        result.final.headers.find((h) => h.name === 'Referer')?.value
      ).toBe('https://example.com/')
      expect(result.contributors.uris).toBe('plugin-resolve')
      expect(result.contributors.headers).toContain('plugin-enrich')
    })

    it('clears hook context on every plugin after invocation', async () => {
      const orch = new HookOrchestrator({
        host,
        hookTimeoutMs: TIMEOUTS,
        ...ORCH_OPTS_BASE,
      })
      await orch.runBeforeCreateHttp(makeBeforeCreateDto(), 'task-1')
      for (const id of ['plugin-resolve', 'plugin-enrich', 'plugin-audit']) {
        expect(bridges.get(id)?.clearHookContext).toHaveBeenCalled()
      }
    })
  })

  describe('runBeforeCreateHttp — fail-closed (resolve)', () => {
    it('aborts the chain when a resolve plugin throws', async () => {
      const { host, extras } = makeMockHost([
        {
          id: 'plugin-resolve',
          role: 'resolve',
          hooks: ['beforeCreate'],
          handler: () => {
            throw new Error('resolve boom')
          },
        },
        {
          id: 'plugin-enrich',
          role: 'enrich',
          hooks: ['beforeCreate'],
        },
      ])

      const orch = new HookOrchestrator({
        host,
        hookTimeoutMs: TIMEOUTS,
        ...ORCH_OPTS_BASE,
      })
      const result = await orch.runBeforeCreateHttp(
        makeBeforeCreateDto(),
        'task-1'
      )
      expect(result.aborted).toBe(true)
      if (!result.aborted) throw new Error('unreachable')
      expect(result.reason).toContain('plugin-resolve')
      expect(result.reason).toContain('resolve boom')
      // Subsequent plugins were not invoked
      expect(extras.invocations.map((i) => i.pluginId)).toEqual([
        'plugin-resolve',
      ])
    })
  })

  describe('runBeforeCreateHttp — fail-open (enrich)', () => {
    it('continues the chain and drops the failing plugin staged effects', async () => {
      const { host, extras } = makeMockHost([
        {
          id: 'plugin-resolve',
          role: 'resolve',
          hooks: ['beforeCreate'],
          handler: ({ bridge, pluginId }) => {
            const ctx = bridge.setHookContext.mock.calls[0]?.[0]
            ctx.staged.appendHttp(pluginId, 'resolve', {
              uris: ['https://cdn.example.com/file.zip'],
            })
          },
        },
        {
          id: 'plugin-enrich-bad',
          role: 'enrich',
          hooks: ['beforeCreate'],
          handler: ({ bridge, pluginId }) => {
            // Stage a header *before* throwing — fail-open must drop it.
            const ctx = bridge.setHookContext.mock.calls[0]?.[0]
            ctx.staged.appendHttp(pluginId, 'enrich', {
              headers: [{ name: 'X-Bad', value: 'leak' }],
            })
            throw new Error('enrich boom')
          },
        },
        {
          id: 'plugin-enrich-good',
          role: 'enrich',
          hooks: ['beforeCreate'],
          handler: ({ bridge, pluginId }) => {
            const ctx = bridge.setHookContext.mock.calls[0]?.[0]
            ctx.staged.appendHttp(pluginId, 'enrich', {
              headers: [{ name: 'Referer', value: 'https://example.com/' }],
            })
          },
        },
      ])

      const orch = new HookOrchestrator({
        host,
        hookTimeoutMs: TIMEOUTS,
        ...ORCH_OPTS_BASE,
      })
      const result = await orch.runBeforeCreateHttp(
        makeBeforeCreateDto(),
        'task-1'
      )
      if (result.aborted) throw new Error('expected non-aborted result')
      expect(extras.invocations.map((i) => i.pluginId)).toEqual([
        'plugin-resolve',
        'plugin-enrich-bad',
        'plugin-enrich-good',
      ])
      // resolve's CDN URI made it
      expect(result.final.uris).toEqual(['https://cdn.example.com/file.zip'])
      // good enrich's header made it
      expect(result.final.headers.some((h) => h.name === 'Referer')).toBe(true)
      // bad enrich's leak header was DROPPED via removeFromPlugin
      expect(result.final.headers.some((h) => h.name === 'X-Bad')).toBe(false)
    })
  })

  describe('runBeforeCreateHttp — audit role', () => {
    it('audit plugin receives sanitized ctx (via setHookContext args.staged role audit)', async () => {
      const seen: { role?: string; saveDir?: string } = {}
      const { host } = makeMockHost([
        {
          id: 'plugin-audit',
          role: 'audit',
          hooks: ['beforeCreate'],
          handler: ({ bridge }) => {
            const ctx = bridge.setHookContext.mock.calls[0]?.[0]
            seen.role = ctx.role
            seen.saveDir = ctx.saveDir
          },
        },
      ])

      const orch = new HookOrchestrator({
        host,
        hookTimeoutMs: TIMEOUTS,
        ...ORCH_OPTS_BASE,
      })
      const result = await orch.runBeforeCreateHttp(
        makeBeforeCreateDto(),
        'task-1'
      )
      if (result.aborted) throw new Error('expected non-aborted result')
      expect(seen.role).toBe('audit')
      expect(seen.saveDir).toBe('/downloads')
    })

    it('audit plugin throwing does not abort the chain (fail-open)', async () => {
      const { host, extras } = makeMockHost([
        {
          id: 'plugin-resolve',
          role: 'resolve',
          hooks: ['beforeCreate'],
        },
        {
          id: 'plugin-audit',
          role: 'audit',
          hooks: ['beforeCreate'],
          handler: () => {
            throw new Error('audit boom')
          },
        },
      ])

      const orch = new HookOrchestrator({
        host,
        hookTimeoutMs: TIMEOUTS,
        ...ORCH_OPTS_BASE,
      })
      const result = await orch.runBeforeCreateHttp(
        makeBeforeCreateDto(),
        'task-1'
      )
      expect(result.aborted).toBeFalsy()
      expect(extras.invocations.map((i) => i.pluginId)).toEqual([
        'plugin-resolve',
        'plugin-audit',
      ])
    })

    it('audit-view sanitizer is exposed for callers needing it', () => {
      const dto = makeBeforeCreateDto({
        sourceUrl: 'https://api.example.com/x',
        headers: [{ name: 'Authorization', value: 'Bearer secret' }],
      })
      const view = HookOrchestrator.audit(dto)
      expect(view.type).toBe('http')
      expect(view.sourceHost).toBe('https://api.example.com')
      expect(view.headerNames).toEqual(['Authorization'])
      // SHA-256 digest hex length = 64
      expect(view.headerValueDigests[0]).toMatch(/^[0-9a-f]{64}$/)
    })
  })

  describe('runBeforeCreateHttp — empty chain', () => {
    it('returns initial DTO unchanged when no plugins are eligible', async () => {
      const { host } = makeMockHost([])
      const orch = new HookOrchestrator({
        host,
        hookTimeoutMs: TIMEOUTS,
        ...ORCH_OPTS_BASE,
      })
      const initial = makeBeforeCreateDto()
      const result = await orch.runBeforeCreateHttp(initial, 'task-1')
      if (result.aborted) throw new Error('expected non-aborted result')
      expect(result.final).toBe(initial)
      expect(result.contributors).toEqual({ headers: [] })
    })
  })

  describe('runBeforeCreateHttp — abort/timeout', () => {
    it('aborts a hanging fail-closed plugin via the timeout signal', async () => {
      const { host } = makeMockHost([
        {
          id: 'plugin-resolve-hang',
          role: 'resolve',
          hooks: ['beforeCreate'],
          handler: ({ signal }) => {
            // Wait on the signal indefinitely.
            return new Promise<void>((_resolve, reject) => {
              signal.addEventListener('abort', () => {
                const e: Error & { code?: string } = new Error('aborted')
                e.code = 'plugin.hook.aborted'
                reject(e)
              })
            })
          },
        },
      ])
      const orch = new HookOrchestrator({
        host,
        hookTimeoutMs: { series: 50, parallel: 100 },
        ...ORCH_OPTS_BASE,
      })
      const result = await orch.runBeforeCreateHttp(
        makeBeforeCreateDto(),
        'task-1'
      )
      expect(result.aborted).toBe(true)
      if (!result.aborted) throw new Error('unreachable')
      expect(result.reason).toContain('plugin-resolve-hang')
    })
  })

  describe('runBeforeFinalize', () => {
    it('the last set finalize path wins and propagates through finalFilePath', async () => {
      const { host } = makeMockHost([
        {
          id: 'plugin-resolve',
          role: 'resolve',
          hooks: ['beforeFinalize'],
          handler: ({ bridge }) => {
            const ctx = bridge.setHookContext.mock.calls[0]?.[0]
            ctx.staged.setFinalizePath('/downloads/renamed-by-resolve.zip')
          },
        },
        {
          id: 'plugin-post',
          role: 'post-process',
          hooks: ['beforeFinalize'],
          handler: ({ bridge }) => {
            const ctx = bridge.setHookContext.mock.calls[0]?.[0]
            ctx.staged.setFinalizePath('/downloads/final.zip')
          },
        },
      ])
      const orch = new HookOrchestrator({
        host,
        hookTimeoutMs: TIMEOUTS,
        ...ORCH_OPTS_BASE,
      })
      const result = await orch.runBeforeFinalize(
        makeBeforeFinalizeDto(),
        'task-1'
      )
      if (result.aborted) throw new Error('expected non-aborted result')
      expect(result.finalFilePath).toBe('/downloads/final.zip')
      expect(result.final.filePath).toBe('/downloads/final.zip')
    })

    it('fail-closed resolves trigger chain abort with the plugin id in reason', async () => {
      const { host } = makeMockHost([
        {
          id: 'plugin-resolve',
          role: 'resolve',
          hooks: ['beforeFinalize'],
          handler: () => {
            throw new Error('resolve crash')
          },
        },
      ])
      const orch = new HookOrchestrator({
        host,
        hookTimeoutMs: TIMEOUTS,
        ...ORCH_OPTS_BASE,
      })
      const result = await orch.runBeforeFinalize(
        makeBeforeFinalizeDto(),
        'task-1'
      )
      expect(result.aborted).toBe(true)
      if (!result.aborted) throw new Error('unreachable')
      expect(result.reason).toContain('plugin-resolve')
      expect(result.reason).toContain('resolve crash')
    })

    it('still returns aborted when staging discard fails during the abort', async () => {
      // A discard failure must not escape the abort path and turn the
      // { aborted } result into a thrown rejection the caller can't classify.
      const discardSpy = vi
        .spyOn(FfmpegStaging.prototype, 'discard')
        .mockRejectedValue(new Error('EPERM: discard failed'))

      const { host } = makeMockHost([
        {
          id: 'plugin-resolve',
          role: 'resolve',
          hooks: ['beforeFinalize'],
          handler: () => {
            throw new Error('resolve crash')
          },
        },
      ])
      const orch = new HookOrchestrator({
        host,
        hookTimeoutMs: TIMEOUTS,
        ...ORCH_OPTS_BASE,
      })

      const result = await orch.runBeforeFinalize(
        makeBeforeFinalizeDto(),
        'task-1'
      )

      expect(result.aborted).toBe(true)
      if (!result.aborted) throw new Error('unreachable')
      expect(result.reason).toContain('plugin-resolve')
      expect(discardSpy).toHaveBeenCalled()

      discardSpy.mockRestore()
    })
  })

  describe('runParallel — afterComplete', () => {
    it('invokes every eligible plugin exactly once', async () => {
      const { host, extras } = makeMockHost([
        { id: 'p1', role: 'enrich', hooks: ['afterComplete'] },
        { id: 'p2', role: 'enrich', hooks: ['afterComplete'] },
        { id: 'p3', role: 'audit', hooks: ['afterComplete'] },
      ])
      const orch = new HookOrchestrator({
        host,
        hookTimeoutMs: TIMEOUTS,
        ...ORCH_OPTS_BASE,
      })
      await orch.runParallel(
        'afterComplete',
        { task: { id: 'task-1' } as never, filePath: '/x' },
        'task-1'
      )
      const counts = new Map<string, number>()
      for (const inv of extras.invocations) {
        counts.set(inv.pluginId, (counts.get(inv.pluginId) ?? 0) + 1)
      }
      expect(counts.get('p1')).toBe(1)
      expect(counts.get('p2')).toBe(1)
      expect(counts.get('p3')).toBe(1)
    })

    it('one plugin throwing does not affect the others', async () => {
      const seen: string[] = []
      const { host } = makeMockHost([
        {
          id: 'p1',
          role: 'enrich',
          hooks: ['afterComplete'],
          handler: () => {
            seen.push('p1')
          },
        },
        {
          id: 'p2',
          role: 'enrich',
          hooks: ['afterComplete'],
          handler: () => {
            throw new Error('p2 boom')
          },
        },
        {
          id: 'p3',
          role: 'audit',
          hooks: ['afterComplete'],
          handler: () => {
            seen.push('p3')
          },
        },
      ])
      const orch = new HookOrchestrator({
        host,
        hookTimeoutMs: TIMEOUTS,
        ...ORCH_OPTS_BASE,
      })
      await orch.runParallel(
        'afterComplete',
        { task: { id: 'task-1' } as never, filePath: '/x' },
        'task-1'
      )
      // p1 and p3 ran even though p2 threw
      expect(seen).toContain('p1')
      expect(seen).toContain('p3')
    })

    it('returns void when no plugins are eligible', async () => {
      const { host } = makeMockHost([])
      const orch = new HookOrchestrator({
        host,
        hookTimeoutMs: TIMEOUTS,
        ...ORCH_OPTS_BASE,
      })
      const r = await orch.runParallel(
        'afterComplete',
        { task: { id: 'task-1' } as never, filePath: '/x' },
        'task-1'
      )
      expect(r).toBeUndefined()
    })
  })

  describe('breaker integration', () => {
    it('skips plugins whose breaker is open and does not invoke them', async () => {
      const seen: string[] = []
      const { host, extras } = makeMockHost([
        {
          id: 'plugin-resolve',
          role: 'resolve',
          hooks: ['beforeCreate'],
          handler: () => {
            seen.push('resolve')
          },
        },
        {
          id: 'plugin-blocked',
          role: 'enrich',
          hooks: ['beforeCreate'],
          handler: () => {
            seen.push('blocked')
          },
        },
      ])
      const breaker: CircuitBreaker = {
        success: vi.fn(),
        failure: vi.fn(),
        isOpen: (id) => id === 'plugin-blocked',
      }
      const orch = new HookOrchestrator({
        host,
        hookTimeoutMs: TIMEOUTS,
        breaker,
        ...ORCH_OPTS_BASE,
      })
      await orch.runBeforeCreateHttp(makeBeforeCreateDto(), 'task-1')
      expect(seen).toEqual(['resolve'])
      // breaker.success ticked for the non-blocked plugin
      expect(breaker.success).toHaveBeenCalledWith(
        'plugin-resolve',
        'beforeCreate'
      )
      // blocked plugin was not invoked
      expect(
        extras.invocations.some((i) => i.pluginId === 'plugin-blocked')
      ).toBe(false)
    })

    it('failure ticks the breaker on fail-open isolation path', async () => {
      const { host } = makeMockHost([
        {
          id: 'plugin-enrich-bad',
          role: 'enrich',
          hooks: ['beforeCreate'],
          handler: () => {
            throw new Error('boom')
          },
        },
      ])
      const breaker: CircuitBreaker = {
        success: vi.fn(),
        failure: vi.fn(),
        isOpen: () => false,
      }
      const orch = new HookOrchestrator({
        host,
        hookTimeoutMs: TIMEOUTS,
        breaker,
        ...ORCH_OPTS_BASE,
      })
      const result = await orch.runBeforeCreateHttp(
        makeBeforeCreateDto(),
        'task-1'
      )
      expect(result.aborted).toBeFalsy()
      expect(breaker.failure).toHaveBeenCalledWith(
        'plugin-enrich-bad',
        'beforeCreate'
      )
    })

    it('success ticks the breaker when a plugin returns normally', async () => {
      const { host } = makeMockHost([
        {
          id: 'plugin-enrich-good',
          role: 'enrich',
          hooks: ['beforeCreate'],
        },
      ])
      const breaker: CircuitBreaker = {
        success: vi.fn(),
        failure: vi.fn(),
        isOpen: () => false,
      }
      const orch = new HookOrchestrator({
        host,
        hookTimeoutMs: TIMEOUTS,
        breaker,
        ...ORCH_OPTS_BASE,
      })
      const result = await orch.runBeforeCreateHttp(
        makeBeforeCreateDto(),
        'task-1'
      )
      expect(result.aborted).toBeFalsy()
      expect(breaker.success).toHaveBeenCalledWith(
        'plugin-enrich-good',
        'beforeCreate'
      )
      expect(breaker.failure).not.toHaveBeenCalled()
    })

    it('calls host.disable with reason "circuit_open" when breaker trips', async () => {
      const { host } = makeMockHost([
        {
          id: 'plugin-flaky',
          role: 'enrich',
          hooks: ['beforeCreate'],
          handler: () => {
            throw new Error('boom')
          },
        },
      ])
      // Threshold of 1 → a single failure flips the breaker open.
      const breaker = new RealCircuitBreaker({ failureThreshold: 1 })
      const orch = new HookOrchestrator({
        host,
        hookTimeoutMs: TIMEOUTS,
        breaker,
        ...ORCH_OPTS_BASE,
      })
      const result = await orch.runBeforeCreateHttp(
        makeBeforeCreateDto(),
        'task-1'
      )
      expect(result.aborted).toBeFalsy()
      expect(host.disable).toHaveBeenCalledTimes(1)
      expect(host.disable).toHaveBeenCalledWith('plugin-flaky', 'circuit_open')
    })
  })

  describe('OrchestratorOptions', () => {
    it('orchestrator requires pluginsDir and pluginStorageRootFor in options', () => {
      // Type-only sentinel — the test mainly fails to type-check if either
      // field is missing from OrchestratorOptions.
      const { host } = makeMockHost([])
      const opts: OrchestratorOptions = {
        host,
        hookTimeoutMs: { series: 1_000, parallel: 1_000 },
        pluginsDir: '/var/data/plugins',
        pluginStorageRootFor: (id) => `/var/data/plugins/${id}/storage`,
      }
      expect(opts.pluginStorageRootFor('alice')).toBe(
        '/var/data/plugins/alice/storage'
      )
    })
  })

  describe('pluginStorageRoot wiring', () => {
    it('beforeCreate setHookContext receives pluginStorageRoot from option', async () => {
      const { host, bridges } = makeMockHost([
        { id: 'alice', role: 'resolve', hooks: ['beforeCreate'] },
      ])
      const orch = new HookOrchestrator({
        host,
        hookTimeoutMs: TIMEOUTS,
        ...ORCH_OPTS_BASE,
      })
      await orch.runBeforeCreateHttp(makeBeforeCreateDto(), 'task-1')
      const ctx = bridges.get('alice')?.setHookContext.mock.calls[0]?.[0]
      expect(ctx).toMatchObject({
        pluginStorageRoot: '/tmp/test-plugins/alice/storage',
      })
    })

    it('beforeFinalize setHookContext receives pluginStorageRoot from option', async () => {
      const { host, bridges } = makeMockHost([
        { id: 'alice', role: 'resolve', hooks: ['beforeFinalize'] },
      ])
      const orch = new HookOrchestrator({
        host,
        hookTimeoutMs: TIMEOUTS,
        ...ORCH_OPTS_BASE,
      })
      await orch.runBeforeFinalize(makeBeforeFinalizeDto(), 'task-1')
      const ctx = bridges.get('alice')?.setHookContext.mock.calls[0]?.[0]
      expect(ctx).toMatchObject({
        pluginStorageRoot: '/tmp/test-plugins/alice/storage',
      })
    })

    it('parallel hooks (afterComplete) keep Plan-B shape — no pluginStorageRoot', async () => {
      const { host, bridges } = makeMockHost([
        { id: 'alice', role: 'audit', hooks: ['afterComplete'] },
      ])
      const orch = new HookOrchestrator({
        host,
        hookTimeoutMs: TIMEOUTS,
        ...ORCH_OPTS_BASE,
      })
      await orch.runParallel(
        'afterComplete',
        { task: { id: 'task-1' } as never, filePath: '/x' },
        'task-1'
      )
      const ctx = bridges.get('alice')?.setHookContext.mock.calls[0]?.[0]
      // Plan-B shape — only { fsTaskHost, taskId }
      expect(ctx).toMatchObject({ taskId: 'task-1' })
      expect(ctx).not.toHaveProperty('pluginStorageRoot')
      expect(ctx).not.toHaveProperty('phase')
    })
  })

  describe('runBeforeFinalize — FfmpegStaging wiring', () => {
    it('creates a FfmpegStaging per plugin and passes it into setHookContext', async () => {
      const { host, bridges } = makeMockHost([
        { id: 'alice', role: 'resolve', hooks: ['beforeFinalize'] },
        { id: 'bob', role: 'enrich', hooks: ['beforeFinalize'] },
      ])
      const orch = new HookOrchestrator({
        host,
        hookTimeoutMs: TIMEOUTS,
        ...ORCH_OPTS_BASE,
      })
      await orch.runBeforeFinalize(
        makeBeforeFinalizeDto({ filePath: '/var/data/downloads/t-1/file.mp4' }),
        't-1'
      )

      const aliceCtx = bridges.get('alice')?.setHookContext.mock.calls[0]?.[0]
      expect(aliceCtx?.staging).toBeDefined()
      // staging.dir is the deterministic per-(plugin, task) path
      expect(aliceCtx?.staging?.dir).toBe('/tmp/test-plugins/alice/staging/t-1')

      const bobCtx = bridges.get('bob')?.setHookContext.mock.calls[0]?.[0]
      expect(bobCtx?.staging).toBeDefined()
      expect(bobCtx?.staging?.dir).toBe('/tmp/test-plugins/bob/staging/t-1')
      // Distinct per-plugin instances
      expect(bobCtx?.staging).not.toBe(aliceCtx?.staging)
    })
  })

  describe('runBeforeFinalize — chain commit promotion', () => {
    let tmp: string

    beforeEach(async () => {
      tmp = await mkdtemp(pathJoin(os.tmpdir(), 'orch-promote-'))
    })

    afterEach(async () => {
      await rm(tmp, { recursive: true, force: true })
    })

    it('promotes the one staging whose dir contains the final filePath', async () => {
      const saveDir = pathJoin(tmp, 'sd')
      await mkdir(saveDir, { recursive: true })
      // Pre-write staged files for both plugins. The orchestrator will build
      // FfmpegStaging instances pointing at these same dirs.
      const aliceDir = pathJoin(tmp, 'alice', 'staging', 't-1')
      const bobDir = pathJoin(tmp, 'bob', 'staging', 't-1')
      await mkdir(aliceDir, { recursive: true })
      await mkdir(bobDir, { recursive: true })
      await writeFile(pathJoin(aliceDir, 'final.mp4'), 'alice-bytes')
      await writeFile(pathJoin(bobDir, 'draft.mp4'), 'bob-bytes')

      // alice = resolve (critical), bob = enrich.
      // alice's handler sets finalizePath to /sd/final.mp4 (lives under
      // alice's staging).
      const { host } = makeMockHost([
        {
          id: 'alice',
          role: 'resolve',
          hooks: ['beforeFinalize'],
          handler: ({ bridge }) => {
            const ctx = bridge.setHookContext.mock.calls[0]?.[0]
            ctx.staged.setFinalizePath(pathJoin(saveDir, 'final.mp4'))
          },
        },
        {
          id: 'bob',
          role: 'enrich',
          hooks: ['beforeFinalize'],
        },
      ])
      const orch = new HookOrchestrator({
        host,
        hookTimeoutMs: TIMEOUTS,
        pluginsDir: tmp,
        pluginStorageRootFor: (id) => pathJoin(tmp, id, 'storage'),
      })
      const result = await orch.runBeforeFinalize(
        makeBeforeFinalizeDto({ filePath: pathJoin(saveDir, 'input.mp4') }),
        't-1'
      )
      expect(result.aborted).toBeFalsy()
      expect(await readFile(pathJoin(saveDir, 'final.mp4'), 'utf8')).toBe(
        'alice-bytes'
      )
      // Bob's staging dir was discarded (didn't own finalFilePath)
      expect(await stat(bobDir).catch(() => null)).toBeNull()
      // Alice's staging dir was also removed after promote (promote() does
      // rm -rf)
      expect(await stat(aliceDir).catch(() => null)).toBeNull()
    })

    it('discards every staging when no plugin set finalizePath', async () => {
      const saveDir = pathJoin(tmp, 'sd2')
      await mkdir(saveDir, { recursive: true })
      const aliceDir = pathJoin(tmp, 'alice', 'staging', 't-2')
      await mkdir(aliceDir, { recursive: true })
      await writeFile(pathJoin(aliceDir, 'x.mp4'), 'x')

      const { host } = makeMockHost([
        { id: 'alice', role: 'enrich', hooks: ['beforeFinalize'] },
      ])
      const orch = new HookOrchestrator({
        host,
        hookTimeoutMs: TIMEOUTS,
        pluginsDir: tmp,
        pluginStorageRootFor: (id) => pathJoin(tmp, id, 'storage'),
      })
      const result = await orch.runBeforeFinalize(
        makeBeforeFinalizeDto({ filePath: pathJoin(saveDir, 'input.mp4') }),
        't-2'
      )
      expect(result.aborted).toBeFalsy()
      // Alice's staging dir is gone
      expect(await stat(aliceDir).catch(() => null)).toBeNull()
    })

    it('promotes only the first by role-band when multiple stagings hold the final path', async () => {
      const saveDir = pathJoin(tmp, 'sd')
      await mkdir(saveDir, { recursive: true })
      // Both alice (resolve, earlier role band) and bob (post-process, later)
      // pre-write the same relative path 'final.mp4' into their staging dirs.
      const aliceDir = pathJoin(tmp, 'alice', 'staging', 't-1')
      const bobDir = pathJoin(tmp, 'bob', 'staging', 't-1')
      await mkdir(aliceDir, { recursive: true })
      await mkdir(bobDir, { recursive: true })
      await writeFile(pathJoin(aliceDir, 'final.mp4'), 'alice-bytes')
      await writeFile(pathJoin(bobDir, 'final.mp4'), 'bob-bytes')

      // alice runs first (resolve band) and sets finalizePath.
      // bob runs later (post-process band) and ALSO sets finalizePath to the
      // same target — the orchestrator's setFinalizePath is last-writer-wins
      // for the path itself, but staging promotion is first-match-wins by
      // iteration order. We want to assert alice's bytes win.
      const { host } = makeMockHost([
        {
          id: 'alice',
          role: 'resolve',
          hooks: ['beforeFinalize'],
          handler: ({ bridge }) => {
            const ctx = bridge.setHookContext.mock.calls[0]?.[0]
            ctx.staged.setFinalizePath(pathJoin(saveDir, 'final.mp4'))
          },
        },
        {
          id: 'bob',
          role: 'post-process',
          hooks: ['beforeFinalize'],
          handler: ({ bridge }) => {
            const ctx = bridge.setHookContext.mock.calls[0]?.[0]
            ctx.staged.setFinalizePath(pathJoin(saveDir, 'final.mp4'))
          },
        },
      ])
      const orch = new HookOrchestrator({
        host,
        hookTimeoutMs: TIMEOUTS,
        pluginsDir: tmp,
        pluginStorageRootFor: (id) => pathJoin(tmp, id, 'storage'),
      })
      const result = await orch.runBeforeFinalize(
        makeBeforeFinalizeDto({ filePath: pathJoin(saveDir, 'input.mp4') }),
        't-1'
      )
      expect(result.aborted).toBeFalsy()
      // alice wins (first by role-band)
      expect(await readFile(pathJoin(saveDir, 'final.mp4'), 'utf8')).toBe(
        'alice-bytes'
      )
      // bob's staging dir was discarded
      expect(await stat(bobDir).catch(() => null)).toBeNull()
    })

    it('records staging fields in the chain.commit audit log', async () => {
      const auditLogs: unknown[] = []
      const saveDir = pathJoin(tmp, 'sd3')
      await mkdir(saveDir, { recursive: true })
      const aliceDir = pathJoin(tmp, 'alice', 'staging', 't-3')
      await mkdir(aliceDir, { recursive: true })
      await writeFile(pathJoin(aliceDir, 'out.mp4'), 'hello-world')

      const { host } = makeMockHost([
        {
          id: 'alice',
          role: 'resolve',
          hooks: ['beforeFinalize'],
          handler: ({ bridge }) => {
            const ctx = bridge.setHookContext.mock.calls[0]?.[0]
            ctx.staged.setFinalizePath(pathJoin(saveDir, 'out.mp4'))
          },
        },
      ])
      const orch = new HookOrchestrator({
        host,
        hookTimeoutMs: TIMEOUTS,
        pluginsDir: tmp,
        pluginStorageRootFor: (id) => pathJoin(tmp, id, 'storage'),
        auditLog: {
          log: async (entry: Record<string, unknown>) => {
            auditLogs.push(entry)
          },
        } as unknown as OrchestratorOptions['auditLog'],
      })
      await orch.runBeforeFinalize(
        makeBeforeFinalizeDto({ filePath: pathJoin(saveDir, 'input.mp4') }),
        't-3'
      )
      const commit = auditLogs.find(
        (e: unknown) =>
          (e as { type?: string; hook?: string }).type === 'chain.commit' &&
          (e as { type?: string; hook?: string }).hook === 'beforeFinalize'
      ) as {
        stagingPromoted?: boolean
        stagingPluginId?: string
        stagingBytesPromoted?: number
        stagingBytesDiscarded?: number
      }
      expect(commit).toBeDefined()
      expect(commit.stagingPromoted).toBe(true)
      expect(commit.stagingPluginId).toBe('alice')
      expect(commit.stagingBytesPromoted).toBe(11) // 'hello-world'.length
      expect(commit.stagingBytesDiscarded).toBe(0)
    })
  })

  describe('runBeforeFinalize — chain abort cleanup', () => {
    let tmp: string
    beforeEach(async () => {
      tmp = await mkdtemp(pathJoin(os.tmpdir(), 'orch-abort-'))
    })
    afterEach(async () => {
      await rm(tmp, { recursive: true, force: true })
    })

    it('chain abort discards every in-flight staging', async () => {
      const aliceDir = pathJoin(tmp, 'alice', 'staging', 't-3')
      const bobDir = pathJoin(tmp, 'bob', 'staging', 't-3')
      await mkdir(aliceDir, { recursive: true })
      await mkdir(bobDir, { recursive: true })
      await writeFile(pathJoin(aliceDir, 'x.mp4'), 'x')
      await writeFile(pathJoin(bobDir, 'y.mp4'), 'y')

      // alice runs first (resolve band) — succeeds, registers staging.
      // bob runs second (also resolve band — critical) — throws.
      // Chain aborts; both stagings must be discarded.
      const { host } = makeMockHost([
        {
          id: 'alice',
          role: 'resolve',
          hooks: ['beforeFinalize'],
          // alice does nothing — but the orchestrator still appends her staging
        },
        {
          id: 'bob',
          role: 'resolve', // critical role; throw → chain aborts
          hooks: ['beforeFinalize'],
          handler: () => {
            throw new Error('bob crash')
          },
        },
      ])
      const orch = new HookOrchestrator({
        host,
        hookTimeoutMs: TIMEOUTS,
        pluginsDir: tmp,
        pluginStorageRootFor: (id) => pathJoin(tmp, id, 'storage'),
      })
      const result = await orch.runBeforeFinalize(
        makeBeforeFinalizeDto({ filePath: pathJoin(tmp, 'sd', 'input.mp4') }),
        't-3'
      )
      expect(result.aborted).toBe(true)
      if (!result.aborted) throw new Error('unreachable')
      expect(result.reason).toContain('bob')
      expect(result.reason).toContain('bob crash')

      // Both staging dirs are removed
      expect(await stat(aliceDir).catch(() => null)).toBeNull()
      expect(await stat(bobDir).catch(() => null)).toBeNull()
    })
  })
})
