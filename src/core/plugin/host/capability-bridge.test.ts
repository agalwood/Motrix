import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { SupportedLocale } from '@shared/constants/locales'
import type { PluginManifest } from '@shared/types/plugin'
import { describe, expect, it, vi } from 'vitest'
import { AppCapabilityHost } from '../capabilities/app'
import { I18nCapabilityHost } from '../capabilities/i18n'
import type { CapabilityHost } from '../capabilities/interface'
import { LogCapabilityHost } from '../capabilities/log'
import { StagedEffectStore } from '../hooks/staged-effects'
import { type BridgeEvents, CapabilityBridge } from './capability-bridge'

// Stub worker that posts `ready` and nothing else — lets us call setHookContext
// synchronously without waiting for a call dispatch cycle.
function writeReadyOnlyStubWorker(dir: string): string {
  const file = path.join(dir, 'StubWorkerReady.cjs')
  writeFileSync(
    file,
    `
const { parentPort } = require('worker_threads')
parentPort.on('message', (msg) => {
  if (msg.type === 'init') {
    parentPort.postMessage({ type: 'ready' })
  }
})
`
  )
  return file
}

function makeBridge(opts?: {
  workerPath?: string
  events?: BridgeEvents
  permissionGeneration?: number
}): {
  bridge: CapabilityBridge
  dir: string
} {
  const dir = mkdtempSync(path.join(tmpdir(), 'mbr-'))
  const workerPath = opts?.workerPath ?? writeReadyOnlyStubWorker(dir)
  const logsDir = path.join(dir, 'plugin-logs')
  const log = new LogCapabilityHost({ pluginLogsDir: logsDir })
  const app = new AppCapabilityHost({
    appVersion: '2.5.0',
    platform: 'linux',
    runtime: 'server',
    locale: 'en-US',
    arch: 'x64',
  })
  const i18n = new I18nCapabilityHost({ hostLanguage: 'en-US' })
  const capHost: CapabilityHost = {
    createLog: (id: string) => log.create(id),
    getTail: (id: string, n: number) => log.getTail(id, n),
    appSnapshot: () => app.snapshot(),
    i18nSnapshot: () => ({
      language: 'en-US',
      dir: 'ltr' as const,
      currentDict: {},
      fallbackDict: {},
    }),
    setLocale: (locale: SupportedLocale) => i18n.setLanguage(locale),
    onLocaleChange: (h: (lang: string) => void) => i18n.onChange(h),
    flush: () => log.flush(),
  } as unknown as CapabilityHost
  const manifest = { id: 'a.b' } as PluginManifest
  const bridge = new CapabilityBridge(
    {
      pluginId: 'a.b',
      manifest,
      bundleSource: '',
      capabilityHost: capHost,
      workerScriptPath: workerPath,
      heapMB: 32,
      appVersion: '2.5.0',
      runtime: 'server',
      hostLanguage: 'en-US',
      permissionGeneration: opts?.permissionGeneration,
    },
    opts?.events
  )
  return { bridge, dir }
}

// Placeholder satisfying the type — none of its methods are called in these tests.
const STUB_FS_TASK_HOST = {} as ReturnType<CapabilityHost['fsTaskFor']>

function writeStubWorker(dir: string): string {
  const file = path.join(dir, 'StubWorker.cjs')
  writeFileSync(
    file,
    `
const { parentPort } = require('worker_threads')
parentPort.on('message', (msg) => {
  if (msg.type === 'init') {
    parentPort.postMessage({ type: 'ready' })
    parentPort.postMessage({ type: 'register', kind: 'hook', key: 'beforeCreate' })
    parentPort.postMessage({ type: 'call', id: 1, capability: 'log', method: 'info', args: ['hello', { x: 1 }] })
  }
})
`
  )
  return file
}

function writeStaleExitStubWorker(dir: string): string {
  const file = path.join(dir, 'stale-exit-worker.cjs')
  writeFileSync(
    file,
    `
const { parentPort } = require('worker_threads')
parentPort.on('message', (msg) => {
  if (msg.type === 'init') parentPort.postMessage({ type: 'ready' })
  if (msg.type === 'event' && msg.event === 'hookEnter') {
    const effects = { schemaVersion: 1, contextPatches: [], metadataOperations: [] }
    parentPort.postMessage({
      type: 'event', event: 'hookExit', ok: true, effects,
      invocationId: 'stale', callChainId: msg.callChainId,
      permissionGeneration: msg.permissionGeneration,
    })
    parentPort.postMessage({
      type: 'event', event: 'hookExit', ok: true, effects,
      invocationId: msg.invocationId, callChainId: msg.callChainId,
      permissionGeneration: msg.permissionGeneration,
    })
  }
})
`
  )
  return file
}

function writeMismatchedCallStubWorker(dir: string): string {
  const file = path.join(dir, 'mismatched-call-worker.cjs')
  writeFileSync(
    file,
    `
const { parentPort } = require('worker_threads')
let active
parentPort.on('message', (msg) => {
  if (msg.type === 'init') parentPort.postMessage({ type: 'ready' })
  if (msg.type === 'event' && msg.event === 'hookEnter') {
    active = msg
    parentPort.postMessage({
      type: 'call', id: 1, capability: 'log', method: 'info', args: ['forged'],
      invocationId: 'wrong', callChainId: msg.callChainId,
      permissionGeneration: msg.permissionGeneration,
    })
  }
  if (msg.type === 'response' && msg.id === 1) {
    parentPort.postMessage({
      type: 'event', event: 'hookExit', ok: false,
      invocationId: active.invocationId, callChainId: active.callChainId,
      permissionGeneration: active.permissionGeneration,
      error: msg.error,
    })
  }
})
`
  )
  return file
}

function writeCrashingHookStubWorker(dir: string): string {
  const file = path.join(dir, 'crashing-hook-worker.cjs')
  writeFileSync(
    file,
    `
const { parentPort } = require('worker_threads')
parentPort.on('message', (msg) => {
  if (msg.type === 'init') parentPort.postMessage({ type: 'ready' })
  if (msg.type === 'event' && msg.event === 'hookEnter') process.exit(7)
})
`
  )
  return file
}

function validBeforeCreatePayload() {
  return {
    type: 'http',
    sourceUrl: 'https://example.test/file',
    createdBy: 'user',
    requestedAt: 1,
    uris: ['https://example.test/file'],
    saveDir: '/downloads',
    headers: [],
  }
}

describe('CapabilityBridge', () => {
  it('routes a worker log call to the LogCapabilityHost', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'mbr-'))
    const workerPath = writeStubWorker(dir)
    const logsDir = path.join(dir, 'plugin-logs')
    const log = new LogCapabilityHost({ pluginLogsDir: logsDir })
    const app = new AppCapabilityHost({
      appVersion: '2.5.0',
      platform: 'linux',
      runtime: 'server',
      locale: 'en-US',
      arch: 'x64',
    })
    const i18n = new I18nCapabilityHost({ hostLanguage: 'en-US' })

    // Cast: this test only exercises Plan A log routing; Plan B fields are unused.
    const capHost: CapabilityHost = {
      createLog: (id: string) => log.create(id),
      getTail: (id: string, n: number) => log.getTail(id, n),
      appSnapshot: () => app.snapshot(),
      i18nSnapshot: () => ({
        language: 'en-US',
        dir: 'ltr' as const,
        currentDict: {},
        fallbackDict: {},
      }),
      setLocale: (locale: SupportedLocale) => i18n.setLanguage(locale),
      onLocaleChange: (h: (lang: string) => void) => i18n.onChange(h),
      flush: () => log.flush(),
    } as unknown as CapabilityHost

    const manifest = { id: 'a.b' } as PluginManifest
    const onReady = vi.fn()
    const onRegister = vi.fn()

    const bridge = new CapabilityBridge(
      {
        pluginId: 'a.b',
        manifest,
        bundleSource: '',
        capabilityHost: capHost,
        workerScriptPath: workerPath,
        heapMB: 32,
        appVersion: '2.5.0',
        runtime: 'server',
        hostLanguage: 'en-US',
      },
      { onReady, onRegister }
    )

    await vi.waitFor(() => {
      expect(onReady).toHaveBeenCalled()
      expect(onRegister).toHaveBeenCalledWith('hook', 'beforeCreate')
      expect(log.getTail('a.b', 10)).toHaveLength(1)
    })

    await bridge.dispose()
  })

  it('exposes pluginStorageRoot on the Plan-C hook context', async () => {
    const { bridge } = makeBridge()
    bridge.setHookContext({
      fsTaskHost: STUB_FS_TASK_HOST,
      taskId: 't-1',
      phase: 'beforeFinalize',
      staged: new StagedEffectStore(),
      role: 'resolve',
      saveDir: '/var/data/downloads/t-1',
      pluginStorageRoot: '/var/data/plugins/alice/storage',
    })
    expect(bridge._debugPluginStorageRoot()).toBe(
      '/var/data/plugins/alice/storage'
    )
    bridge.clearHookContext()
    expect(bridge._debugPluginStorageRoot()).toBeNull()
    await bridge.dispose()
  })

  it('prepareBundle rewrites motrix:plugin-api imports', async () => {
    const { prepareBundle } = await import('./capability-bridge')
    const out = prepareBundle(
      `import { log, hooks } from 'motrix:plugin-api'\nlog.info('hi')`
    )
    expect(out).toContain('globalThis.__motrix_plugin_api__')
    expect(out).not.toContain("from 'motrix:plugin-api'")
  })

  it('prepareBundle converts `import { x as y }` renames into destructuring `x: y`', async () => {
    const { prepareBundle } = await import('./capability-bridge')
    // esbuild's minifySyntax produces this shape when it renames local
    // identifiers; without the rename->`:` conversion the resulting
    // `const { config as d } = …` is a QuickJS SyntaxError.
    const out = prepareBundle(
      `import{config as d,ffmpeg as g,hooks as S,http as b,log as u,notify as E}from"motrix:plugin-api";d.get('x')`
    )
    expect(out).toContain('globalThis.__motrix_plugin_api__')
    expect(out).toContain('config: d')
    expect(out).toContain('hooks: S')
    expect(out).not.toMatch(/\bas\b/)
  })

  it('prepareBundle handles a mix of plain and renamed members', async () => {
    const { prepareBundle } = await import('./capability-bridge')
    const out = prepareBundle(
      `import { log, hooks as h } from 'motrix:plugin-api';\nlog.info('x')`
    )
    expect(out).toContain('{ log, hooks: h }')
  })

  it('ignores a stale Hook exit and settles only the matching invocation', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'mbr-'))
    const onFatal = vi.fn()
    const { bridge } = makeBridge({
      workerPath: writeStaleExitStubWorker(dir),
      events: { onFatal },
    })
    bridge.setHookContext({
      fsTaskHost: STUB_FS_TASK_HOST,
      taskId: 'task-1',
      phase: 'beforeCreate',
      staged: new StagedEffectStore(),
      role: 'enrich',
      saveDir: '/downloads',
      pluginStorageRoot: '/plugins/a.b',
    })

    await expect(
      bridge.callHook(
        'beforeCreate',
        'task-1',
        new AbortController().signal,
        1_000,
        validBeforeCreatePayload(),
        {},
        {
          invocationId: 'current',
          callChainId: 'chain-current',
          permissionGeneration: 1,
        }
      )
    ).resolves.toEqual({
      schemaVersion: 1,
      contextPatches: [],
      metadataOperations: [],
    })
    expect(onFatal).toHaveBeenCalledWith(
      'plugin.hook.concurrent_protocol_violation',
      'stale or mismatched Hook exit ignored'
    )
    await bridge.dispose()
  })

  it('rejects a capability call forged for another Hook invocation', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'mbr-'))
    const { bridge } = makeBridge({
      workerPath: writeMismatchedCallStubWorker(dir),
    })
    bridge.setHookContext({
      fsTaskHost: STUB_FS_TASK_HOST,
      taskId: 'task-1',
      phase: 'beforeCreate',
      staged: new StagedEffectStore(),
      role: 'enrich',
      saveDir: '/downloads',
      pluginStorageRoot: '/plugins/a.b',
    })

    await expect(
      bridge.callHook(
        'beforeCreate',
        'task-1',
        new AbortController().signal,
        1_000,
        validBeforeCreatePayload(),
        {},
        {
          invocationId: 'current',
          callChainId: 'chain-current',
          permissionGeneration: 1,
        }
      )
    ).rejects.toMatchObject({
      code: 'plugin.hook.concurrent_protocol_violation',
    })
    await bridge.dispose()
  })

  it('rejects a stale permission generation before posting a Hook', async () => {
    const { bridge } = makeBridge({ permissionGeneration: 2 })
    bridge.setHookContext({
      fsTaskHost: STUB_FS_TASK_HOST,
      taskId: 'task-1',
      phase: 'beforeCreate',
      staged: new StagedEffectStore(),
      role: 'enrich',
      saveDir: '/downloads',
      pluginStorageRoot: '/plugins/a.b',
    })

    await expect(
      bridge.callHook(
        'beforeCreate',
        'task-1',
        new AbortController().signal,
        1_000,
        validBeforeCreatePayload(),
        {},
        {
          invocationId: 'current',
          callChainId: 'chain-current',
          permissionGeneration: 1,
        }
      )
    ).rejects.toMatchObject({
      code: 'plugin.runtime.permission_generation_stale',
    })
    await bridge.dispose()
  })

  it('rejects an active Hook promptly when its Worker crashes', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'mbr-'))
    const { bridge } = makeBridge({
      workerPath: writeCrashingHookStubWorker(dir),
    })
    bridge.setHookContext({
      fsTaskHost: STUB_FS_TASK_HOST,
      taskId: 'task-1',
      phase: 'beforeCreate',
      staged: new StagedEffectStore(),
      role: 'enrich',
      saveDir: '/downloads',
      pluginStorageRoot: '/plugins/a.b',
    })

    await expect(
      bridge.callHook(
        'beforeCreate',
        'task-1',
        new AbortController().signal,
        10_000,
        validBeforeCreatePayload()
      )
    ).rejects.toMatchObject({ code: 'plugin.hook.worker_crashed' })
    await bridge.dispose()
  })
})
