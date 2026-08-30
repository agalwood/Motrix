import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { Worker } from 'node:worker_threads'
import { migrate } from '@core/session/migrations'
import type { SupportedLocale } from '@shared/constants/locales'
import { ErrorCode } from '@shared/errors'
import { keypair, makeZip } from '@test-utils/moext'
import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AppCapabilityHost } from '../capabilities/app'
import { I18nCapabilityHost } from '../capabilities/i18n'
import type { CapabilityHost } from '../capabilities/interface'
import { LogCapabilityHost } from '../capabilities/log'
import { PluginRegistry } from '../plugin-registry'
import { PluginStateStore } from '../state/plugin-state-store'
import { PluginHost, parsePluginIdleDisposeMs } from './plugin-host'

describe('parsePluginIdleDisposeMs', () => {
  it.each([
    [undefined, undefined],
    ['', undefined],
    ['0', undefined],
    ['-1', undefined],
    ['invalid', undefined],
    ['1234', 1234],
  ])('maps %j to %j', (input, expected) => {
    expect(parsePluginIdleDisposeMs(input)).toBe(expected)
  })
})

function writeStubWorker(dir: string): string {
  const file = path.join(dir, 'StubWorker.cjs')
  writeFileSync(
    file,
    `
const { parentPort } = require('worker_threads')
parentPort.on('message', (msg) => {
  if (msg.type === 'init') {
    parentPort.postMessage({ type: 'ready' })
  } else if (msg.type === 'event' && msg.event === 'deactivate') {
    parentPort.postMessage({ type: 'event', event: 'deactivateComplete', ok: true })
  }
})
`
  )
  return file
}

function writeStubWorkerDeactivateError(dir: string): string {
  const file = path.join(dir, 'StubWorkerDeactivateError.cjs')
  writeFileSync(
    file,
    `
const { parentPort } = require('worker_threads')
parentPort.on('message', (msg) => {
  if (msg.type === 'init') {
    parentPort.postMessage({ type: 'ready' })
  } else if (msg.type === 'event' && msg.event === 'deactivate') {
    parentPort.postMessage({ type: 'event', event: 'deactivateComplete', ok: false, errorCode: 'plugin.runtime.fault' })
  }
})
`
  )
  return file
}

function writeStubWorkerDeactivateHang(dir: string): string {
  const file = path.join(dir, 'StubWorkerDeactivateHang.cjs')
  writeFileSync(
    file,
    `
const { parentPort } = require('worker_threads')
parentPort.on('message', (msg) => {
  if (msg.type === 'init') {
    parentPort.postMessage({ type: 'ready' })
  } else if (msg.type === 'event' && msg.event === 'deactivate') {
    // Never responds — simulates a hanging handler
  } else if (msg.type === 'event' && msg.event === 'shutdown') {
    process.exit(0)
  }
})
`
  )
  return file
}

function writeStubWorkerNeverReady(dir: string): string {
  const file = path.join(dir, 'StubWorkerNeverReady.cjs')
  writeFileSync(
    file,
    `
const { parentPort } = require('worker_threads')
parentPort.on('message', (msg) => {
  if (msg.type === 'event' && msg.event === 'deactivate') {
    parentPort.postMessage({ type: 'event', event: 'deactivateComplete', ok: true })
  }
})
`
  )
  return file
}

function plantPlugin(
  parent: string,
  id: string,
  manifestOver: Record<string, unknown> = {}
): void {
  const dirPath = path.join(parent, id)
  mkdirSync(path.join(dirPath, 'dist'), { recursive: true })
  writeFileSync(
    path.join(dirPath, 'motrix-plugin.json'),
    JSON.stringify({
      manifestVersion: 1,
      id,
      name: id,
      version: '1.0.0',
      description: 'd',
      categories: ['integration'],
      engines: { motrix: '>=2.0.0' },
      main: 'dist/plugin.js',
      permissions: [],
      activationEvents: ['onStartup'],
      contributes: {},
      ...manifestOver,
    })
  )
  writeFileSync(path.join(dirPath, 'dist', 'plugin.js'), 'export default {}')
}

describe('PluginHost', () => {
  let root: string
  let stateStore: PluginStateStore
  let registry: PluginRegistry
  let capHost: CapabilityHost
  let workerPath: string

  beforeEach(async () => {
    root = mkdtempSync(path.join(tmpdir(), 'mph-'))
    workerPath = writeStubWorker(root)
    const db = new Database(':memory:')
    migrate(db)
    stateStore = new PluginStateStore(db)
    plantPlugin(path.join(root, 'plugins'), 'alice.demo')
    plantPlugin(path.join(root, 'plugins'), 'bob.demo')
    registry = new PluginRegistry({
      pluginsDir: path.join(root, 'plugins'),
      builtinDir: path.join(root, 'builtin'),
      stateStore,
      hostVersion: '2.5.0',
    })
    await registry.discover()
    const log = new LogCapabilityHost({
      pluginLogsDir: path.join(root, 'logs'),
    })
    const app = new AppCapabilityHost({
      appVersion: '2.5.0',
      platform: 'linux',
      runtime: 'server',
      locale: 'en-US',
      arch: 'x64',
    })
    const i18n = new I18nCapabilityHost({ hostLanguage: 'en-US' })
    // Cast: these tests only exercise Plan A surfaces; Plan B fields are unused.
    capHost = {
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
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it('activates a plugin and marks it active', async () => {
    const host = new PluginHost({
      registry,
      stateStore,
      capabilityHost: capHost,
      workerScriptPath: workerPath,
      appVersion: '2.5.0',
      runtime: 'server',
      hostLanguage: 'en-US',
    })
    await host.activate('alice.demo')
    expect(host.isActive('alice.demo')).toBe(true)
    // Both persisted row and in-memory cache must agree on status='active'.
    expect(stateStore.get('alice.demo')?.status).toBe('active')
    expect(registry.get('alice.demo')?.state.status).toBe('active')
    await host.shutdown()
  })

  it('uses an injected bundle reader for a community plugin', async () => {
    const readBundleSource = vi.fn(async () => 'export default {}')
    const host = new PluginHost({
      registry,
      stateStore,
      capabilityHost: capHost,
      workerScriptPath: workerPath,
      appVersion: '2.5.0',
      runtime: 'server',
      hostLanguage: 'en-US',
      readBundleSource,
    })

    await host.activate('alice.demo')

    expect(readBundleSource).toHaveBeenCalledWith(
      path.join(root, 'plugins', 'alice.demo', 'dist', 'plugin.js')
    )
    await host.shutdown()
  })

  it('throws PluginActivationCapExceeded when over soft cap', async () => {
    const host = new PluginHost({
      registry,
      stateStore,
      capabilityHost: capHost,
      workerScriptPath: workerPath,
      maxActivePlugins: 1,
      appVersion: '2.5.0',
      runtime: 'server',
      hostLanguage: 'en-US',
    })
    await host.activate('alice.demo')
    await expect(host.activate('bob.demo')).rejects.toThrow(/active plugin cap/)
    await host.shutdown()
  })

  it('rejects activation when manifest.main escapes the plugin dir', async () => {
    plantPlugin(path.join(root, 'plugins'), 'evil.demo', {
      main: '../../escape.js',
    })
    await registry.discover()
    const host = new PluginHost({
      registry,
      stateStore,
      capabilityHost: capHost,
      workerScriptPath: workerPath,
      appVersion: '2.5.0',
      runtime: 'server',
      hostLanguage: 'en-US',
    })
    await expect(host.activate('evil.demo')).rejects.toThrow(/main_escapes_dir/)
    await host.shutdown()
  })

  it('shutdown deactivates all active plugins', async () => {
    const host = new PluginHost({
      registry,
      stateStore,
      capabilityHost: capHost,
      workerScriptPath: workerPath,
      appVersion: '2.5.0',
      runtime: 'server',
      hostLanguage: 'en-US',
    })
    await host.activate('alice.demo')
    await host.activate('bob.demo')
    expect(host.activeIds().sort()).toEqual(['alice.demo', 'bob.demo'])
    await host.shutdown()
    expect(host.activeIds()).toEqual([])
  })

  it('activate is idempotent on already-active plugin', async () => {
    const host = new PluginHost({
      registry,
      stateStore,
      capabilityHost: capHost,
      workerScriptPath: workerPath,
      appVersion: '2.5.0',
      runtime: 'server',
      hostLanguage: 'en-US',
    })
    await host.activate('alice.demo')
    await host.activate('alice.demo')
    expect(host.activeIds()).toEqual(['alice.demo'])
    await host.shutdown()
  })

  it('coalesces concurrent activations of the same plugin', async () => {
    const host = new PluginHost({
      registry,
      stateStore,
      capabilityHost: capHost,
      workerScriptPath: workerPath,
      appVersion: '2.5.0',
      runtime: 'server',
      hostLanguage: 'en-US',
    })
    // doActivate calls registry.get exactly once at its top. Two overlapping
    // activations must share a single doActivate run (one worker spawn), not
    // race past the active-map guard and both spawn — which would orphan the
    // first bridge when the second active.set() overwrote it.
    const getSpy = vi.spyOn(registry, 'get')
    await Promise.all([
      host.activate('alice.demo'),
      host.activate('alice.demo'),
    ])
    const getCallsForAlice = getSpy.mock.calls.filter(
      (c) => c[0] === 'alice.demo'
    ).length
    expect(getCallsForAlice).toBe(1)
    expect(host.activeIds()).toEqual(['alice.demo'])
    getSpy.mockRestore()
    await host.shutdown()
  })

  it('cancels activation blocked on bundle read without a late worker', async () => {
    let markReadStarted!: () => void
    const readStarted = new Promise<void>((resolve) => {
      markReadStarted = resolve
    })
    let releaseRead!: (source: string) => void
    const blockedRead = new Promise<string>((resolve) => {
      releaseRead = resolve
    })
    const host = new PluginHost({
      registry,
      stateStore,
      capabilityHost: capHost,
      workerScriptPath: workerPath,
      appVersion: '2.5.0',
      runtime: 'server',
      hostLanguage: 'en-US',
      readBundleSource: () => {
        markReadStarted()
        return blockedRead
      },
    })

    const activation = host.activate('alice.demo')
    const activationRejected = expect(activation).rejects.toThrow(
      /plugin\.activation\.superseded/
    )
    await readStarted
    await host.deactivate('alice.demo')
    await activationRejected

    expect(host.isQuiescent('alice.demo')).toBe(true)
    expect(host.bridgeFor('alice.demo')).toBeUndefined()
    expect(host.workerFor('alice.demo')).toBeUndefined()

    // Completing the underlying filesystem operation after deactivate() has
    // returned must not resume the superseded activation continuation.
    releaseRead('export default {}')
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(host.isQuiescent('alice.demo')).toBe(true)
    expect(host.workerFor('alice.demo')).toBeUndefined()
    await host.shutdown()
  })

  it('deactivate terminates a not-ready worker and rejects replacement activation', async () => {
    const neverReadyWorker = writeStubWorkerNeverReady(root)
    const host = new PluginHost({
      registry,
      stateStore,
      capabilityHost: capHost,
      workerScriptPath: neverReadyWorker,
      activationTimeoutMs: 10_000,
      deactivateBudgetMs: 200,
      appVersion: '2.5.0',
      runtime: 'server',
      hostLanguage: 'en-US',
    })

    const activation = host.activate('alice.demo')
    const activationRejected = expect(activation).rejects.toThrow(
      /plugin\.activation\.superseded/
    )
    await vi.waitFor(() => expect(host.workerFor('alice.demo')).toBeDefined())
    const oldWorker = host.workerFor('alice.demo')!
    const terminate = vi.spyOn(oldWorker, 'terminate')

    const deactivation = host.deactivate('alice.demo')
    await expect(host.activate('alice.demo')).rejects.toThrow(
      /plugin\.activation\.superseded/
    )
    await deactivation
    await activationRejected

    expect(terminate).toHaveBeenCalledOnce()
    expect(host.isQuiescent('alice.demo')).toBe(true)
    expect(host.isActive('alice.demo')).toBe(false)
    expect(host.allActive()).toEqual([])
    expect(host.bridgeFor('alice.demo')).toBeUndefined()
    expect(host.workerFor('alice.demo')).toBeUndefined()
    await host.shutdown()
  })

  it('invokeCommand rejects with not_available when plugin is inactive', async () => {
    const host = new PluginHost({
      registry,
      stateStore,
      capabilityHost: capHost,
      workerScriptPath: workerPath,
      appVersion: '2.5.0',
      runtime: 'server',
      hostLanguage: 'en-US',
    })
    await expect(
      host.invokeCommand('alice.demo', 'alice.demo.run', {})
    ).rejects.toMatchObject({ message: 'plugin.command.not_available' })
    await host.shutdown()
  })

  it('invokeCommand refreshes lastActivityAt on the active plugin', async () => {
    const host = new PluginHost({
      registry,
      stateStore,
      capabilityHost: capHost,
      workerScriptPath: workerPath,
      appVersion: '2.5.0',
      runtime: 'server',
      hostLanguage: 'en-US',
    })
    await host.activate('alice.demo')
    // Stub worker does not respond to executeCommand, so this call would hang
    // forever. We assert only that the active map entry persists — i.e. the
    // pre-check + bridge dispatch happen synchronously without throwing.
    // The actual round-trip is covered by the bridge-level callPlugin tests.
    void host.invokeCommand('alice.demo', 'alice.demo.run', {}).catch(() => {})
    expect(host.isActive('alice.demo')).toBe(true)
    await host.shutdown()
  })

  // -------------------------------------------------------------------------
  // M5 — idle disposal (spec §7 L2149)
  // -------------------------------------------------------------------------
  describe('idle disposal', () => {
    it('default idleDisposeMs is 5 minutes when no override', () => {
      const host = new PluginHost({
        registry,
        stateStore,
        capabilityHost: capHost,
        workerScriptPath: workerPath,
        appVersion: '2.5.0',
        runtime: 'server',
        hostLanguage: 'en-US',
      })
      expect(host.idleDisposeMsForTest).toBe(5 * 60_000)
      host.shutdown()
    })

    it('opts.idleDisposeMs overrides the default', () => {
      const host = new PluginHost({
        registry,
        stateStore,
        capabilityHost: capHost,
        workerScriptPath: workerPath,
        idleDisposeMs: 1234,
        appVersion: '2.5.0',
        runtime: 'server',
        hostLanguage: 'en-US',
      })
      expect(host.idleDisposeMsForTest).toBe(1234)
      host.shutdown()
    })

    it('disposes an Active plugin once idleDisposeMs has elapsed', async () => {
      const host = new PluginHost({
        registry,
        stateStore,
        capabilityHost: capHost,
        workerScriptPath: workerPath,
        idleDisposeMs: 50,
        appVersion: '2.5.0',
        runtime: 'server',
        hostLanguage: 'en-US',
      })
      await host.activate('alice.demo')
      expect(host.isActive('alice.demo')).toBe(true)
      await new Promise((r) => setTimeout(r, 80))
      host.__sweepIdleForTest()
      // Deactivate is async; let it settle.
      await new Promise((r) => setTimeout(r, 50))
      expect(host.isActive('alice.demo')).toBe(false)
      await host.shutdown()
    })

    it('does NOT dispose a recently active plugin', async () => {
      const host = new PluginHost({
        registry,
        stateStore,
        capabilityHost: capHost,
        workerScriptPath: workerPath,
        idleDisposeMs: 60_000,
        appVersion: '2.5.0',
        runtime: 'server',
        hostLanguage: 'en-US',
      })
      await host.activate('alice.demo')
      host.__sweepIdleForTest()
      expect(host.isActive('alice.demo')).toBe(true)
      await host.shutdown()
    })
  })
})

describe('PluginHost.deactivate — lifecycle wiring', () => {
  let root: string
  let stateStore: PluginStateStore
  let registry: PluginRegistry
  let capHost: CapabilityHost

  beforeEach(async () => {
    root = mkdtempSync(path.join(tmpdir(), 'mph-lifecycle-'))
    const db = new Database(':memory:')
    migrate(db)
    stateStore = new PluginStateStore(db)
    plantPlugin(path.join(root, 'plugins'), 'alice.demo')
    registry = new PluginRegistry({
      pluginsDir: path.join(root, 'plugins'),
      builtinDir: path.join(root, 'builtin'),
      stateStore,
      hostVersion: '2.5.0',
    })
    await registry.discover()
    const log = new LogCapabilityHost({
      pluginLogsDir: path.join(root, 'logs'),
    })
    const app = new AppCapabilityHost({
      appVersion: '2.5.0',
      platform: 'linux',
      runtime: 'server',
      locale: 'en-US',
      arch: 'x64',
    })
    const i18n = new I18nCapabilityHost({ hostLanguage: 'en-US' })
    capHost = {
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
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it('deactivate completes cleanly when worker responds ok', async () => {
    const workerPath = writeStubWorker(root)
    const host = new PluginHost({
      registry,
      stateStore,
      capabilityHost: capHost,
      workerScriptPath: workerPath,
      appVersion: '2.5.0',
      runtime: 'server',
      hostLanguage: 'en-US',
    })
    await host.activate('alice.demo')
    expect(host.isActive('alice.demo')).toBe(true)
    await host.deactivate('alice.demo')
    expect(host.isActive('alice.demo')).toBe(false)
  })

  it('falls back to direct worker termination when bridge disposal fails', async () => {
    const workerPath = writeStubWorker(root)
    const host = new PluginHost({
      registry,
      stateStore,
      capabilityHost: capHost,
      workerScriptPath: workerPath,
      appVersion: '2.5.0',
      runtime: 'server',
      hostLanguage: 'en-US',
    })
    await host.activate('alice.demo')
    const bridge = host.bridgeFor('alice.demo')!
    const worker = bridge.getWorker()
    const realTerminate = worker.terminate.bind(worker)
    const dispose = vi.spyOn(bridge, 'dispose')
    const terminate = vi
      .spyOn(worker, 'terminate')
      .mockRejectedValueOnce(new Error('dispose terminate failed'))
      .mockImplementation(realTerminate)

    await host.deactivate('alice.demo')

    expect(dispose).toHaveBeenCalledOnce()
    expect(terminate).toHaveBeenCalledTimes(2)
    expect(host.isQuiescent('alice.demo')).toBe(true)
    expect(stateStore.get('alice.demo')?.status).toBe('inactive')
  })

  it('does not cache a rejected teardown and retries the terminate backstop', async () => {
    const workerPath = writeStubWorker(root)
    const host = new PluginHost({
      registry,
      stateStore,
      capabilityHost: capHost,
      workerScriptPath: workerPath,
      appVersion: '2.5.0',
      runtime: 'server',
      hostLanguage: 'en-US',
    })
    await host.activate('alice.demo')
    const bridge = host.bridgeFor('alice.demo')!
    const worker = bridge.getWorker()
    const realTerminate = worker.terminate.bind(worker)
    const dispose = vi.spyOn(bridge, 'dispose')
    const terminate = vi
      .spyOn(worker, 'terminate')
      .mockRejectedValueOnce(new Error('dispose terminate failed'))
      .mockRejectedValueOnce(new Error('terminate failed'))
      .mockImplementation(realTerminate)

    await expect(host.deactivate('alice.demo')).rejects.toThrow(
      'terminate failed'
    )
    expect(host.isQuiescent('alice.demo')).toBe(false)

    await host.deactivate('alice.demo')

    expect(dispose).toHaveBeenCalledOnce()
    expect(terminate).toHaveBeenCalledTimes(3)
    expect(host.isQuiescent('alice.demo')).toBe(true)
    expect(stateStore.get('alice.demo')?.status).toBe('inactive')
  })

  it('deactivate completes (with logged warning) when worker reports error', async () => {
    const workerPath = writeStubWorkerDeactivateError(root)
    const warnMessages: string[] = []
    const log = {
      trace: () => {},
      debug: () => {},
      info: () => {},
      warn: (msg: string) => {
        warnMessages.push(msg)
      },
      error: () => {},
      fatal: () => {},
    }
    const hostWithWarnLog = {
      ...capHost,
      createLog: () => log,
    } as unknown as CapabilityHost
    const host = new PluginHost({
      registry,
      stateStore,
      capabilityHost: hostWithWarnLog,
      workerScriptPath: workerPath,
      appVersion: '2.5.0',
      runtime: 'server',
      hostLanguage: 'en-US',
    })
    await host.activate('alice.demo')
    await host.deactivate('alice.demo')
    expect(host.isActive('alice.demo')).toBe(false)
    expect(warnMessages.some((m) => m.includes('deactivate'))).toBe(true)
  })

  it('deactivate completes (with logged warning) when worker handler hangs past budget', async () => {
    const workerPath = writeStubWorkerDeactivateHang(root)
    const warnMessages: string[] = []
    const log = {
      trace: () => {},
      debug: () => {},
      info: () => {},
      warn: (msg: string) => {
        warnMessages.push(msg)
      },
      error: () => {},
      fatal: () => {},
    }
    const hostWithWarnLog = {
      ...capHost,
      createLog: () => log,
    } as unknown as CapabilityHost
    const host = new PluginHost({
      registry,
      stateStore,
      capabilityHost: hostWithWarnLog,
      workerScriptPath: workerPath,
      deactivateBudgetMs: 150, // short budget for test speed
      appVersion: '2.5.0',
      runtime: 'server',
      hostLanguage: 'en-US',
    })
    await host.activate('alice.demo')
    const start = Date.now()
    await host.deactivate('alice.demo')
    const elapsed = Date.now() - start
    expect(host.isActive('alice.demo')).toBe(false)
    // Timeout fired after ~150ms
    expect(elapsed).toBeGreaterThanOrEqual(100)
    expect(warnMessages.some((m) => m.includes('deactivate'))).toBe(true)
  }, 5_000)

  it('deactivate is a no-op for unknown pluginId', async () => {
    const workerPath = writeStubWorker(root)
    const host = new PluginHost({
      registry,
      stateStore,
      capabilityHost: capHost,
      workerScriptPath: workerPath,
      appVersion: '2.5.0',
      runtime: 'server',
      hostLanguage: 'en-US',
    })
    // Should not throw
    await host.deactivate('nonexistent.plugin')
    expect(host.activeIds()).toEqual([])
  })

  it('deactivate syncs in-memory state.status with stateStore', async () => {
    const workerPath = writeStubWorker(root)
    const host = new PluginHost({
      registry,
      stateStore,
      capabilityHost: capHost,
      workerScriptPath: workerPath,
      appVersion: '2.5.0',
      runtime: 'server',
      hostLanguage: 'en-US',
    })
    await host.activate('alice.demo')
    await host.deactivate('alice.demo')
    // After deactivate, both the persisted row and the in-memory cache
    // must agree on status='inactive' — otherwise downstream readers
    // (Queries.ListPlugins, ActivationDispatcher, CrossPluginInvoker) see
    // a stale value.
    expect(stateStore.get('alice.demo')?.status).toBe('inactive')
    expect(registry.get('alice.demo')?.state.status).toBe('inactive')
  })

  it('disable syncs in-memory state.enabled with stateStore', async () => {
    const workerPath = writeStubWorker(root)
    const host = new PluginHost({
      registry,
      stateStore,
      capabilityHost: capHost,
      workerScriptPath: workerPath,
      appVersion: '2.5.0',
      runtime: 'server',
      hostLanguage: 'en-US',
    })
    // Disable without activating — covers the circuit-breaker path.
    await host.disable('alice.demo', 'circuit tripped')
    expect(stateStore.get('alice.demo')?.enabled).toBe(false)
    // BUG: PluginHost.activate() gates on indexed.state.enabled, so the
    // in-memory cache must reflect the disable.
    expect(registry.get('alice.demo')?.state.enabled).toBe(false)
    expect(registry.get('alice.demo')?.state.status).toBe('disabled')
  })
})

describe('PluginHost locale change propagation', () => {
  let root: string
  let stateStore: PluginStateStore
  let registry: PluginRegistry
  let workerPath: string

  beforeEach(async () => {
    root = mkdtempSync(path.join(tmpdir(), 'mph-locale-'))
    workerPath = writeStubWorker(root)
    const db = new Database(':memory:')
    migrate(db)
    stateStore = new PluginStateStore(db)
    for (const [pluginId, displayName, greeting] of [
      ['alice.demo', 'Alice Demo', '你好'],
      ['bob.demo', 'Bob Demo', '你好 Bob'],
    ] as const) {
      const pluginDir = path.join(root, 'plugins', pluginId)
      plantPlugin(path.join(root, 'plugins'), pluginId, {
        name: '%name%',
        description: '%description%',
        l10n: 'l10n',
      })
      mkdirSync(path.join(pluginDir, 'l10n'), { recursive: true })
      writeFileSync(
        path.join(pluginDir, 'l10n', 'en-US.json'),
        JSON.stringify({
          name: displayName,
          description: 'English description',
          greeting: 'Hello',
        })
      )
      writeFileSync(
        path.join(pluginDir, 'l10n', 'zh-CN.json'),
        JSON.stringify({
          name: `${displayName} ZH`,
          description: 'Chinese description',
          greeting,
        })
      )
    }
    registry = new PluginRegistry({
      pluginsDir: path.join(root, 'plugins'),
      builtinDir: path.join(root, 'builtin'),
      stateStore,
      hostVersion: '2.5.0',
    })
    await registry.discover()
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it('continues locale fan-out when one active bridge throws', async () => {
    const pluginLog = {
      trace: vi.fn(),
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      fatal: vi.fn(),
    }
    const app = new AppCapabilityHost({
      appVersion: '2.5.0',
      platform: 'linux',
      runtime: 'server',
      locale: 'en-US',
      arch: 'x64',
    })
    const i18n = new I18nCapabilityHost({ hostLanguage: 'en-US' })
    const capHost = {
      createLog: () => pluginLog,
      getTail: () => [],
      appSnapshot: () => ({ ...app.snapshot(), locale: i18n.language }),
      i18nSnapshot: (pluginId: string) => ({
        language: i18n.language,
        dir: i18n.direction,
        ...registry.getLocaleDictionaries(pluginId),
      }),
      setLocale: (locale: SupportedLocale) => i18n.setLanguage(locale),
      onLocaleChange: (h: (lang: string) => void) => i18n.onChange(h),
      flush: async () => {},
    } as unknown as CapabilityHost

    const host = new PluginHost({
      registry,
      stateStore,
      capabilityHost: capHost,
      workerScriptPath: workerPath,
      appVersion: '2.5.0',
      runtime: 'server',
      hostLanguage: 'en-US',
    })

    await host.activate('alice.demo')
    await host.activate('bob.demo')

    const aliceBridge = host.bridgeFor('alice.demo')
    const bobBridge = host.bridgeFor('bob.demo')
    if (!aliceBridge || !bobBridge) throw new Error('bridge not found')
    const aliceSpy = vi
      .spyOn(aliceBridge, 'postLocaleChange')
      .mockImplementation(() => {
        throw new Error('worker unavailable')
      })
    const bobSpy = vi.spyOn(bobBridge, 'postLocaleChange')

    await expect(
      registry.setHostLanguageTransaction('zh-CN', {
        commitHostLocale: () => capHost.setLocale('zh-CN'),
        rollbackHostLocale: (previousLanguage) =>
          capHost.setLocale(previousLanguage),
      })
    ).resolves.toBe(true)

    expect(aliceSpy).toHaveBeenCalledTimes(1)
    expect(bobSpy).toHaveBeenCalledTimes(1)
    expect(bobSpy).toHaveBeenCalledWith(
      'zh-CN',
      'ltr',
      expect.objectContaining({ greeting: '你好 Bob' })
    )
    expect(pluginLog.warn).toHaveBeenCalledWith(
      'plugin locale broadcast failed',
      { error: 'worker unavailable' }
    )

    await host.shutdown()
  })

  it('shutdown unsubscribes from locale changes', async () => {
    const unsubscribe = vi.fn()
    const log = new LogCapabilityHost({
      pluginLogsDir: path.join(root, 'logs'),
    })
    const app = new AppCapabilityHost({
      appVersion: '2.5.0',
      platform: 'linux',
      runtime: 'server',
      locale: 'en-US',
      arch: 'x64',
    })
    const capHost = {
      createLog: (id: string) => log.create(id),
      getTail: (id: string, n: number) => log.getTail(id, n),
      appSnapshot: () => app.snapshot(),
      i18nSnapshot: () => ({
        language: 'en-US',
        dir: 'ltr' as const,
        currentDict: {},
        fallbackDict: {},
      }),
      setLocale: () => {},
      onLocaleChange: (_h: (lang: string) => void) => unsubscribe,
      flush: () => log.flush(),
    } as unknown as CapabilityHost

    const host = new PluginHost({
      registry,
      stateStore,
      capabilityHost: capHost,
      workerScriptPath: workerPath,
      appVersion: '2.5.0',
      runtime: 'server',
      hostLanguage: 'en-US',
    })

    await host.shutdown()
    expect(unsubscribe).toHaveBeenCalledOnce()
  })
})

// ---------------------------------------------------------------------------
// PluginHost.activate — ffmpeg snapshot (Task 6)
// ---------------------------------------------------------------------------
describe('PluginHost.activate — ffmpeg snapshot', () => {
  let root: string
  let stateStore: PluginStateStore
  let registry: PluginRegistry
  let capHost: CapabilityHost
  let workerPath: string

  beforeEach(async () => {
    root = mkdtempSync(path.join(tmpdir(), 'mph-ffmpeg-'))
    workerPath = writeStubWorker(root)
    const db = new Database(':memory:')
    migrate(db)
    stateStore = new PluginStateStore(db)
    const log = new LogCapabilityHost({
      pluginLogsDir: path.join(root, 'logs'),
    })
    const app = new AppCapabilityHost({
      appVersion: '2.5.0',
      platform: 'linux',
      runtime: 'server',
      locale: 'en-US',
      arch: 'x64',
    })
    const i18n = new I18nCapabilityHost({ hostLanguage: 'en-US' })
    capHost = {
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
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it('required + missing → throws ffmpeg_too_old; plugin stays inactive', async () => {
    plantPlugin(path.join(root, 'plugins'), 'req.miss', {
      permissions: ['ffmpeg'],
    })
    registry = new PluginRegistry({
      pluginsDir: path.join(root, 'plugins'),
      builtinDir: path.join(root, 'builtin'),
      stateStore,
      hostVersion: '2.5.0',
    })
    await registry.discover()
    const host = new PluginHost({
      registry,
      stateStore,
      capabilityHost: capHost,
      workerScriptPath: workerPath,
      appVersion: '2.5.0',
      runtime: 'server',
      hostLanguage: 'en-US',
      ffmpegDetect: async () => ({ available: false }),
    })
    await expect(host.activate('req.miss')).rejects.toMatchObject({
      message: 'plugin.manifest.engines.ffmpeg_too_old',
    })
    expect(host.isActive('req.miss')).toBe(false)
    expect(stateStore.get('req.miss')?.lastError).toContain(
      'plugin.manifest.engines.ffmpeg_too_old'
    )
    await host.shutdown()
  })

  it('required + version below range → throws ffmpeg_too_old', async () => {
    plantPlugin(path.join(root, 'plugins'), 'req.below', {
      permissions: ['ffmpeg'],
      engines: { motrix: '>=2.0.0', ffmpeg: '>=4.4' },
    })
    registry = new PluginRegistry({
      pluginsDir: path.join(root, 'plugins'),
      builtinDir: path.join(root, 'builtin'),
      stateStore,
      hostVersion: '2.5.0',
    })
    await registry.discover()
    const host = new PluginHost({
      registry,
      stateStore,
      capabilityHost: capHost,
      workerScriptPath: workerPath,
      appVersion: '2.5.0',
      runtime: 'server',
      hostLanguage: 'en-US',
      ffmpegDetect: async () => ({
        available: true,
        version: '3.4.2',
        binaryPath: '/x',
      }),
    })
    await expect(host.activate('req.below')).rejects.toMatchObject({
      message: 'plugin.manifest.engines.ffmpeg_too_old',
    })
    await host.shutdown()
  })

  it('optional + missing → activate succeeds; getFfmpegAdvertised === false', async () => {
    plantPlugin(path.join(root, 'plugins'), 'opt.miss', {
      optionalPermissions: ['ffmpeg'],
    })
    registry = new PluginRegistry({
      pluginsDir: path.join(root, 'plugins'),
      builtinDir: path.join(root, 'builtin'),
      stateStore,
      hostVersion: '2.5.0',
    })
    await registry.discover()
    const host = new PluginHost({
      registry,
      stateStore,
      capabilityHost: capHost,
      workerScriptPath: workerPath,
      appVersion: '2.5.0',
      runtime: 'server',
      hostLanguage: 'en-US',
      ffmpegDetect: async () => ({ available: false }),
    })
    await host.activate('opt.miss')
    expect(host.isActive('opt.miss')).toBe(true)
    expect(host.getFfmpegAdvertised('opt.miss')).toBe(false)
    await host.shutdown()
  })

  it('required + satisfies → activate succeeds; getFfmpegAdvertised === true', async () => {
    plantPlugin(path.join(root, 'plugins'), 'req.ok', {
      permissions: ['ffmpeg'],
      engines: { motrix: '>=2.0.0', ffmpeg: '>=4.4' },
    })
    registry = new PluginRegistry({
      pluginsDir: path.join(root, 'plugins'),
      builtinDir: path.join(root, 'builtin'),
      stateStore,
      hostVersion: '2.5.0',
    })
    await registry.discover()
    const host = new PluginHost({
      registry,
      stateStore,
      capabilityHost: capHost,
      workerScriptPath: workerPath,
      appVersion: '2.5.0',
      runtime: 'server',
      hostLanguage: 'en-US',
      ffmpegDetect: async () => ({
        available: true,
        version: '6.0.1',
        binaryPath: '/x',
      }),
    })
    await host.activate('req.ok')
    expect(host.getFfmpegAdvertised('req.ok')).toBe(true)
    await host.shutdown()
  })
})

// ---------------------------------------------------------------------------
// Task 6 — Firefox packed-XPI read path (2026-07-18 design §4): a builtin
// hot-update overlay's EXECUTED CODE must come from the signature-verified
// bundle.moext, never the separately-tamperable extracted tree. Plants a
// tree whose dist/plugin.js diverges from the bundle's dist/plugin.js entry
// — the scenario a userData-write attacker (or plain corruption) produces —
// and asserts the worker receives the BUNDLE's code.
// ---------------------------------------------------------------------------
describe('PluginHost.activate — builtin overlay bundle read path', () => {
  let root: string
  let stateStore: PluginStateStore
  let capHost: CapabilityHost
  let workerPath: string

  const OVERLAY_ID = 'motrix.overlay-demo'

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), 'mph-overlay-'))
    workerPath = writeStubWorker(root)
    const db = new Database(':memory:')
    migrate(db)
    stateStore = new PluginStateStore(db)
    const log = new LogCapabilityHost({
      pluginLogsDir: path.join(root, 'logs'),
    })
    const app = new AppCapabilityHost({
      appVersion: '2.5.0',
      platform: 'linux',
      runtime: 'server',
      locale: 'en-US',
      arch: 'x64',
    })
    const i18n = new I18nCapabilityHost({ hostLanguage: 'en-US' })
    capHost = {
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
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it('sends the BUNDLE dist/plugin.js to the worker, not the tampered tree copy', async () => {
    const builtinDir = path.join(root, 'builtin')
    const overlayDir = path.join(root, 'builtin-updates')

    // Seed at v1.0.0 (read-only app resources, in this fixture just a plain
    // dir). The overlay below is v1.1.0, so arbitration picks the overlay.
    plantPlugin(builtinDir, OVERLAY_ID)

    const { pem, sign: signFn } = keypair()
    const overlayEntryDir = path.join(overlayDir, OVERLAY_ID)
    mkdirSync(path.join(overlayEntryDir, 'dist'), { recursive: true })
    const manifestJSON = JSON.stringify({
      manifestVersion: 1,
      id: OVERLAY_ID,
      name: OVERLAY_ID,
      version: '1.1.0',
      description: 'd',
      categories: ['integration'],
      engines: { motrix: '>=2.0.0' },
      main: 'dist/plugin.js',
      permissions: [],
      activationEvents: ['onStartup'],
      contributes: {},
    })
    writeFileSync(
      path.join(overlayEntryDir, 'motrix-plugin.json'),
      manifestJSON
    )
    // Tree copy carries a TAMPERED marker — must never reach the worker once
    // the overlay's signature is verified.
    writeFileSync(
      path.join(overlayEntryDir, 'dist', 'plugin.js'),
      'globalThis.__MOTRIX_TEST_SOURCE__ = "TREE_TAMPERED"'
    )

    const bundleBytes = makeZip([
      { name: 'motrix-plugin.json', data: Buffer.from(manifestJSON) },
      {
        name: 'dist/plugin.js',
        data: Buffer.from(
          'globalThis.__MOTRIX_TEST_SOURCE__ = "BUNDLE_VERIFIED"'
        ),
      },
    ])
    writeFileSync(path.join(overlayEntryDir, 'bundle.moext'), bundleBytes)
    writeFileSync(
      path.join(overlayEntryDir, '_overlay.json'),
      JSON.stringify({
        version: 1,
        packageUrl: 'https://dl.motrix.app/p/overlay-demo.moext',
        sha256: createHash('sha256').update(bundleBytes).digest('hex'),
        signature: signFn(bundleBytes),
        recordedAt: 1700000000000,
      })
    )

    const registry = new PluginRegistry({
      pluginsDir: path.join(root, 'plugins'),
      builtinDir,
      overlayDir,
      stateStore,
      hostVersion: '2.5.0',
      signingPubkeys: [pem],
    })
    await registry.discover()
    // Sanity: the entry really is overlay-backed before we assert on it.
    expect(registry.get(OVERLAY_ID)?.overlay).toBeDefined()
    expect(registry.get(OVERLAY_ID)?.manifest.version).toBe('1.1.0')

    const host = new PluginHost({
      registry,
      stateStore,
      capabilityHost: capHost,
      workerScriptPath: workerPath,
      appVersion: '2.5.0',
      runtime: 'server',
      hostLanguage: 'en-US',
      // Same ephemeral test key the registry above verified the overlay
      // against — production omits this and falls back to the pinned
      // build-time key, same as PluginRegistryOptions.signingPubkeys.
      signingPubkeys: [pem],
    })

    // Seam: CapabilityBridge sends the manifest+bundleSource to the worker
    // via `this.worker.postMessage({ type: 'init', ..., bundleSource })`.
    // Spying on the real Worker class's prototype (both this file and
    // CapabilityBridge import the same 'node:worker_threads' module) lets us
    // observe the exact string handed to the sandbox without needing the
    // stub worker to echo anything back.
    const postSpy = vi.spyOn(Worker.prototype, 'postMessage')
    try {
      await host.activate(OVERLAY_ID)

      const initCall = postSpy.mock.calls.find(
        ([msg]) => (msg as { type?: string } | undefined)?.type === 'init'
      )
      expect(initCall).toBeDefined()
      const bundleSource = (initCall as [{ bundleSource: string }])[0]
        .bundleSource
      expect(bundleSource).toContain('BUNDLE_VERIFIED')
      expect(bundleSource).not.toContain('TREE_TAMPERED')
    } finally {
      postSpy.mockRestore()
      await host.shutdown()
    }
  })

  // Negative counterpart to the read-path test above: the overlay's
  // bundle.moext bytes are tampered with AFTER the signature was computed
  // (e.g. a userData-write attacker, or post-scan corruption) — modeling
  // scan-time verification having already passed and the file changing
  // before activation. verifyBuiltinSignature must fail against the
  // signature recorded in _overlay.json, activation must reject with
  // builtin_bad_signature, and the worker must never be handed the code.
  it('rejects activation when bundle.moext is tampered after signing', async () => {
    const builtinDir = path.join(root, 'builtin')
    const overlayDir = path.join(root, 'builtin-updates')

    plantPlugin(builtinDir, OVERLAY_ID)

    const { pem, sign: signFn } = keypair()
    const overlayEntryDir = path.join(overlayDir, OVERLAY_ID)
    mkdirSync(path.join(overlayEntryDir, 'dist'), { recursive: true })
    const manifestJSON = JSON.stringify({
      manifestVersion: 1,
      id: OVERLAY_ID,
      name: OVERLAY_ID,
      version: '1.1.0',
      description: 'd',
      categories: ['integration'],
      engines: { motrix: '>=2.0.0' },
      main: 'dist/plugin.js',
      permissions: [],
      activationEvents: ['onStartup'],
      contributes: {},
    })
    writeFileSync(
      path.join(overlayEntryDir, 'motrix-plugin.json'),
      manifestJSON
    )
    writeFileSync(
      path.join(overlayEntryDir, 'dist', 'plugin.js'),
      'globalThis.__MOTRIX_TEST_SOURCE__ = "TREE_COPY"'
    )

    const bundleBytes = makeZip([
      { name: 'motrix-plugin.json', data: Buffer.from(manifestJSON) },
      {
        name: 'dist/plugin.js',
        data: Buffer.from(
          'globalThis.__MOTRIX_TEST_SOURCE__ = "BUNDLE_ORIGINAL"'
        ),
      },
    ])
    const signature = signFn(bundleBytes)
    writeFileSync(path.join(overlayEntryDir, 'bundle.moext'), bundleBytes)
    writeFileSync(
      path.join(overlayEntryDir, '_overlay.json'),
      JSON.stringify({
        version: 1,
        packageUrl: 'https://dl.motrix.app/p/overlay-demo.moext',
        sha256: createHash('sha256').update(bundleBytes).digest('hex'),
        signature,
        recordedAt: 1700000000000,
      })
    )

    const registry = new PluginRegistry({
      pluginsDir: path.join(root, 'plugins'),
      builtinDir,
      overlayDir,
      stateStore,
      hostVersion: '2.5.0',
      signingPubkeys: [pem],
    })
    await registry.discover()
    // Sanity: scan-time verification passed and picked the overlay as
    // effective — the tamper below happens strictly AFTER this point, so
    // this test exercises PluginHost's own re-verification at activate time,
    // not PluginRegistry's scan-time check.
    expect(registry.get(OVERLAY_ID)?.overlay).toBeDefined()

    // Tamper bundle.moext on disk — the signature in _overlay.json still
    // describes the ORIGINAL bytes above.
    writeFileSync(
      path.join(overlayEntryDir, 'bundle.moext'),
      Buffer.concat([bundleBytes, Buffer.from('TAMPERED')])
    )

    const host = new PluginHost({
      registry,
      stateStore,
      capabilityHost: capHost,
      workerScriptPath: workerPath,
      appVersion: '2.5.0',
      runtime: 'server',
      hostLanguage: 'en-US',
      signingPubkeys: [pem],
    })

    const postSpy = vi.spyOn(Worker.prototype, 'postMessage')
    try {
      await expect(host.activate(OVERLAY_ID)).rejects.toMatchObject({
        code: ErrorCode.PluginManifestInvalid,
        message: 'plugin.update.builtin_bad_signature',
      })
      // Rejection happens before any worker is spun up / handed code.
      expect(postSpy).not.toHaveBeenCalled()
    } finally {
      postSpy.mockRestore()
      await host.shutdown()
    }
  })
})
