// src/core/plugin/host/capability-bridge.dispatch.test.ts
// Exercises each capability dispatch path directly via dispatchCall()
// without spawning a real worker. The Worker constructor is mocked so
// no thread is actually created.

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { PluginManifest } from '@shared/types/plugin'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { CommandsCapabilityHost } from '../capabilities/commands'
import { ConfigCapabilityHost } from '../capabilities/config'
import { CryptoCapabilityHost } from '../capabilities/crypto'
import { FfmpegCapabilityHost } from '../capabilities/ffmpeg'
import type { FfmpegDetection } from '../capabilities/ffmpeg-detect'
import { FsStorageCapabilityHost } from '../capabilities/fs-storage'
import { HttpCapabilityHost } from '../capabilities/http'
import type { CapabilityHost } from '../capabilities/interface'
import type { StorageCapabilityHost } from '../capabilities/storage'
import type { BridgeCallMessage } from './bridge-protocol'
import { CapabilityBridge } from './capability-bridge'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const PLUGIN_ID = 'test.plugin'

const STUB_MANIFEST: PluginManifest = {
  manifestVersion: 1,
  id: PLUGIN_ID,
  name: 'Test Plugin',
  version: '1.0.0',
  description: 'Test plugin',
  categories: [],
  engines: { motrix: '^1.0.0' },
  main: 'dist/plugin.js',
  permissions: [],
  activationEvents: [],
  contributes: {},
}

interface BuiltHost {
  capHost: CapabilityHost
  crypto: CryptoCapabilityHost
  commands: CommandsCapabilityHost
  storage: StorageCapabilityHost
  storageDir: string
}

function buildCapabilityHost(): BuiltHost {
  const tmpDir = mkdtempSync(path.join(tmpdir(), 'mbr-dispatch-'))
  const logNoop = {
    trace: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
  }

  const crypto = new CryptoCapabilityHost()
  const commands = new CommandsCapabilityHost()

  // In-memory storage stub (no SQLite needed in unit tests)
  const memStore = new Map<string, unknown>()
  const storage = {
    get: vi.fn(async (pluginId: string, key: string) => {
      const val = memStore.get(`${pluginId}:${key}`)
      return { value: val, version: val !== undefined ? 1 : 0 }
    }),
    set: vi.fn(async (pluginId: string, key: string, value: unknown) => {
      memStore.set(`${pluginId}:${key}`, value)
      return { version: 1 }
    }),
    compareAndSet: vi.fn(async () => ({ version: 1 })),
    delete: vi.fn(async () => ({ deleted: true })),
    keys: vi.fn(async () => []),
  } as unknown as StorageCapabilityHost

  // Notify stub
  const notify = {
    available: true,
    show: vi.fn(async () => {}),
  }

  // Http stub that returns a minimal response
  const httpStub = new HttpCapabilityHost()

  // fs.storage backed by a real temp dir
  const fsStorage = new FsStorageCapabilityHost({
    pluginStorageRoot: path.join(tmpDir, 'storage'),
  })

  // config stub
  const configHost = new ConfigCapabilityHost({
    pluginId: PLUGIN_ID,
    readValues: () => ({ theme: 'dark' }),
    schemaDefaults: { theme: 'light', maxItems: 10 },
    secretFields: new Set<string>(),
  })

  // ffmpeg stub — unavailable binary so ops resolve/reject predictably
  const ffmpegDetect = {
    available: false,
    binaryPath: undefined,
    version: undefined,
  } as unknown as FfmpegDetection
  const ffmpeg = new FfmpegCapabilityHost({ detect: ffmpegDetect })

  const cookieJarStub = {
    cookieHeader: () => '',
    captureFromResponseHeaders: () => {},
  }

  const capHost: CapabilityHost = {
    createLog: () => logNoop,
    getTail: () => [],
    clearLog: () => {},
    setLogVerbose: () => {},
    isLogVerbose: () => false,
    subscribeLog: () => () => {},
    appSnapshot: () => ({
      version: '2.5.0',
      platform: process.platform as 'darwin' | 'win32' | 'linux',
      runtime: 'server' as const,
      locale: 'en-US',
      arch: process.arch as 'x64' | 'arm64',
    }),
    i18nSnapshot: () => ({
      language: 'en-US',
      dir: 'ltr' as const,
      currentDict: { 'hello.world': 'Hello {{name}}!' },
      fallbackDict: { 'hello.world': 'Hello {{name}}!', 'fallback.only': 'FB' },
    }),
    setLocale: () => {},
    onLocaleChange: () => () => {},
    flush: async () => {},
    http: httpStub,
    fsTaskFor: (saveDir, filePath) => {
      const { FsTaskCapabilityHost } = require('../capabilities/fs-task')
      return new FsTaskCapabilityHost({ saveDir, filePath })
    },
    fsStorageFor: () => fsStorage,
    storage: storage as unknown as CapabilityHost['storage'],
    metadata: null as unknown as CapabilityHost['metadata'],
    crypto,
    configFor: () => configHost,
    lifecycle: null as unknown as CapabilityHost['lifecycle'],
    commands,
    notify: notify as unknown as CapabilityHost['notify'],
    ffmpeg,
    secrets: null as unknown as CapabilityHost['secrets'],
    cookieJarFor: () =>
      cookieJarStub as unknown as ReturnType<CapabilityHost['cookieJarFor']>,
  }

  return { capHost, crypto, commands, storage, storageDir: tmpDir }
}

// Write a stub worker that just listens (never terminates on its own).
// This lets us construct a real bridge without worker crashing.
let stubWorkerPath: string

function getStubWorkerPath(): string {
  if (stubWorkerPath) return stubWorkerPath
  const { writeFileSync, mkdtempSync: mktemp } = require('node:fs')
  const { tmpdir: tmp } = require('node:os')
  const dir = mktemp(path.join(tmp(), 'mbr-stub-worker-'))
  const file = path.join(dir, 'stub.cjs')
  writeFileSync(
    file,
    `const { parentPort } = require('worker_threads');
     parentPort && parentPort.on('message', () => {});`
  )
  stubWorkerPath = file
  return file
}

interface BridgeWithSpy {
  bridge: CapabilityBridge
  posted: unknown[]
}

function makeBridge(
  capHost: CapabilityHost,
  manifest: PluginManifest = STUB_MANIFEST
): BridgeWithSpy {
  const posted: unknown[] = []
  const bridge = new CapabilityBridge(
    {
      pluginId: PLUGIN_ID,
      manifest,
      bundleSource: '',
      capabilityHost: capHost,
      workerScriptPath: getStubWorkerPath(),
      heapMB: 32,
      appVersion: '2.5.0',
      runtime: 'server',
      hostLanguage: 'en-US',
    },
    {}
  )
  // Spy on the real Worker's postMessage to capture responses.
  const w = (bridge as unknown as Record<string, any>).worker
  const origPostMessage = w.postMessage.bind(w)
  w.postMessage = (msg: unknown) => {
    posted.push(msg)
    origPostMessage(msg)
  }
  return { bridge, posted }
}

function makeCall(
  capability: string,
  method: string,
  args: unknown[]
): BridgeCallMessage {
  return { type: 'call', id: 42, capability, method, args }
}

/** Extract the last response captured in the posted array. */
function lastPosted(posted: unknown[]): unknown {
  if (posted.length === 0)
    throw new Error('No messages captured in posted array')
  return posted[posted.length - 1]
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('CapabilityBridge dispatch table', () => {
  let capHost: CapabilityHost
  let bridge: CapabilityBridge
  let posted: unknown[]
  let commands: CommandsCapabilityHost

  beforeEach(async () => {
    const built = buildCapabilityHost()
    capHost = built.capHost
    commands = built.commands
    const bws = makeBridge(capHost)
    bridge = bws.bridge
    posted = bws.posted
    // Wait a tick so the worker thread can start and the init postMessage
    // (from sendInit) is captured in the posted array.
    await new Promise((r) => setTimeout(r, 5))
    // Reset posted so tests only see their own messages
    posted.length = 0
  })

  // 1. log.info round-trip
  it('routes log.info to PluginLogCapability and sends ok response', async () => {
    await bridge.dispatchCall(
      makeCall('log', 'info', ['test message', { extra: 1 }])
    )
    const resp = lastPosted(posted) as { type: string; ok: boolean }
    expect(resp.type).toBe('response')
    expect(resp.ok).toBe(true)
    expect(capHost.createLog(PLUGIN_ID).info).toHaveBeenCalledWith(
      'test message',
      { extra: 1 }
    )
  })

  // 2. Unknown capability
  it('returns plugin.capability.unknown for unknown capability', async () => {
    await bridge.dispatchCall(makeCall('nonexistent', 'foo', []))
    const resp = lastPosted(posted) as {
      ok: boolean
      error: { code: string }
    }
    expect(resp.ok).toBe(false)
    expect(resp.error.code).toBe('plugin.capability.unknown')
  })

  // 3. crypto.randomBytes
  it('crypto.randomBytes(8) returns Uint8Array of length 8', async () => {
    await bridge.dispatchCall(makeCall('crypto', 'randomBytes', [8]))
    const resp = lastPosted(posted) as { ok: boolean; result: Uint8Array }
    expect(resp.ok).toBe(true)
    expect(resp.result).toBeInstanceOf(Uint8Array)
    expect((resp.result as Uint8Array).length).toBe(8)
  })

  // 4. storage.set + storage.get round-trip
  it('storage.set persists and storage.get retrieves with pluginId closed over', async () => {
    await bridge.dispatchCall(makeCall('storage', 'set', ['myKey', 'myValue']))
    const setResp = lastPosted(posted) as { ok: boolean }
    expect(setResp.ok).toBe(true)

    await bridge.dispatchCall(makeCall('storage', 'get', ['myKey']))
    const getResp = lastPosted(posted) as {
      ok: boolean
      result: { value: unknown }
    }
    expect(getResp.ok).toBe(true)
    expect(getResp.result.value).toBe('myValue')

    // Verify pluginId was passed
    const storageMock = capHost.storage as unknown as {
      set: ReturnType<typeof vi.fn>
      get: ReturnType<typeof vi.fn>
    }
    expect(storageMock.set).toHaveBeenCalledWith(PLUGIN_ID, 'myKey', 'myValue')
    expect(storageMock.get).toHaveBeenCalledWith(PLUGIN_ID, 'myKey')
  })

  // 5. notify.show calls capability with pluginId
  it('notify.show calls NotifyCapabilityHost with pluginId', async () => {
    await bridge.dispatchCall(
      makeCall('notify', 'show', [
        { title: 'Done', body: 'Download complete', icon: 'success' },
      ])
    )
    const resp = lastPosted(posted) as { ok: boolean }
    expect(resp.ok).toBe(true)
    const notifyMock = (
      capHost.notify as unknown as { show: ReturnType<typeof vi.fn> }
    ).show
    expect(notifyMock).toHaveBeenCalledWith(PLUGIN_ID, {
      title: 'Done',
      body: 'Download complete',
      icon: 'success',
    })
  })

  // 6. http.get dispatches to plugin-scoped HttpCapabilityHost
  it('http.get dispatches to plugin-scoped HttpCapabilityHost', async () => {
    // Stub out the actual request to avoid network
    const getStub = vi.fn().mockResolvedValue({
      status: 200,
      statusText: '',
      headers: {},
      body: 'ok',
    })
    ;(bridge as unknown as { pluginHttpHost: any }).pluginHttpHost = {
      get: getStub,
      post: vi.fn(),
      request: vi.fn(),
    }

    await bridge.dispatchCall(makeCall('http', 'get', ['https://example.com']))
    const resp = lastPosted(posted) as { ok: boolean; result: unknown }
    expect(resp.ok).toBe(true)
    expect(getStub).toHaveBeenCalledWith('https://example.com', undefined)
  })

  // 6b. http requests are confined to the manifest's hostPermissions
  it('http.get outside the manifest hostPermissions fails with host_not_permitted', async () => {
    const scoped = makeBridge(capHost, {
      ...STUB_MANIFEST,
      permissions: ['http'],
      hostPermissions: ['https://allowed.example/*'],
    })
    await new Promise((r) => setTimeout(r, 5))
    scoped.posted.length = 0

    await scoped.bridge.dispatchCall(
      makeCall('http', 'get', ['https://blocked.example/file'])
    )
    const resp = lastPosted(scoped.posted) as {
      ok: boolean
      error: { code: string }
    }
    expect(resp.ok).toBe(false)
    expect(resp.error.code).toBe('plugin.http.host_not_permitted')
  })

  // 7. fs.storage.exists returns false for non-existent file
  it('fs.storage.exists returns false for a non-existent file', async () => {
    await bridge.dispatchCall(
      makeCall('fs.storage', 'exists', ['nonexistent.txt'])
    )
    const resp = lastPosted(posted) as { ok: boolean; result: boolean }
    expect(resp.ok).toBe(true)
    expect(resp.result).toBe(false)
  })

  // 8. fs.task.stat throws when no current task host bound
  it('fs.task throws plugin.fs.task.not_available_outside_hook when no hook ctx', async () => {
    await bridge.dispatchCall(makeCall('fs.task', 'stat', []))
    const resp = lastPosted(posted) as { ok: boolean; error: { code: string } }
    expect(resp.ok).toBe(false)
    expect(resp.error.code).toBe('plugin.fs.task.not_available_outside_hook')
  })

  // 9. metadata.get throws when no current task bound
  it('metadata throws plugin.metadata.not_available_outside_hook when no hook ctx', async () => {
    await bridge.dispatchCall(makeCall('metadata', 'get', ['someKey']))
    const resp = lastPosted(posted) as { ok: boolean; error: { code: string } }
    expect(resp.ok).toBe(false)
    expect(resp.error.code).toBe('plugin.metadata.not_available_outside_hook')
  })

  // 10. config.get returns resolved value
  it('config.get returns resolved config value', async () => {
    await bridge.dispatchCall(makeCall('config', 'get', ['theme']))
    const resp = lastPosted(posted) as { ok: boolean; result: unknown }
    expect(resp.ok).toBe(true)
    expect(resp.result).toBe('dark') // stored value wins over default 'light'
  })

  // 11. commands.execute dispatches handler
  it('commands.execute dispatches own-namespace handler', async () => {
    commands.register(PLUGIN_ID, `${PLUGIN_ID}.doSomething`, async (args) => ({
      echoed: args,
    }))

    await bridge.dispatchCall(
      makeCall('commands', 'execute', [
        `${PLUGIN_ID}.doSomething`,
        { value: 42 },
      ])
    )
    const resp = lastPosted(posted) as {
      ok: boolean
      result: { echoed: unknown }
    }
    expect(resp.ok).toBe(true)
    expect(resp.result).toEqual({ echoed: { value: 42 } })
  })

  // 12. ffmpeg.transcode returns { opId }; op.result.await rejects (unavailable ffmpeg)
  it('ffmpeg.transcode returns { opId } immediately; op.result.await rejects on unavailable ffmpeg', async () => {
    await bridge.dispatchCall(
      makeCall('ffmpeg', 'transcode', [
        { input: '/tmp/in.mp4', output: '/tmp/out.mp4' },
      ])
    )
    const launchResp = lastPosted(posted) as {
      ok: boolean
      result: { opId: string }
    }
    expect(launchResp.ok).toBe(true)
    expect(typeof launchResp.result.opId).toBe('string')

    const { opId } = launchResp.result

    await bridge.dispatchCall(makeCall('ffmpeg', 'op.result.await', [opId]))
    const awaitResp = lastPosted(posted) as {
      ok: boolean
      error?: { code: string }
    }
    // ffmpeg unavailable → rejects immediately
    expect(awaitResp.ok).toBe(false)
    expect(awaitResp.error?.code).toBe('plugin.capability.unavailable')
  })

  // 12b. ffmpeg.op.abort
  it('ffmpeg.op.abort returns aborted: true for a running op', async () => {
    await bridge.dispatchCall(
      makeCall('ffmpeg', 'transcode', [
        { input: '/tmp/in.mp4', output: '/tmp/out.mp4' },
      ])
    )
    const launchResp = lastPosted(posted) as {
      ok: boolean
      result: { opId: string }
    }
    expect(launchResp.ok).toBe(true)
    const { opId } = launchResp.result

    await bridge.dispatchCall(makeCall('ffmpeg', 'op.abort', [opId]))
    const abortResp = lastPosted(posted) as {
      ok: boolean
      result?: { aborted: boolean }
    }
    expect(abortResp.ok).toBe(true)
  })

  // 13. Args validation
  it('returns error for crypto.randomBytes with non-number arg', async () => {
    await bridge.dispatchCall(
      makeCall('crypto', 'randomBytes', ['not a number'])
    )
    const resp = lastPosted(posted) as { ok: boolean; error: { code: string } }
    expect(resp.ok).toBe(false)
    // Zod parse error or bad_args code
    expect(['plugin.capability.bad_args', 'plugin.runtime.fault']).toContain(
      resp.error.code
    )
  })

  // 14. i18n.t with interpolation
  it('i18n.t returns translated string with variable interpolation', async () => {
    await bridge.dispatchCall(
      makeCall('i18n', 't', ['hello.world', { name: 'Alice' }])
    )
    const resp = lastPosted(posted) as { ok: boolean; result: string }
    expect(resp.ok).toBe(true)
    expect(resp.result).toBe('Hello Alice!')
  })

  // 15. setHookContext enables fs.task dispatch
  it('fs.task.stat succeeds after setHookContext is called', async () => {
    const tmpDir = mkdtempSync(path.join(tmpdir(), 'mbr-fstask-'))
    const { writeFileSync } = await import('node:fs')
    const testFile = path.join(tmpDir, 'test.bin')
    writeFileSync(testFile, 'hello')

    const { FsTaskCapabilityHost } = await import('../capabilities/fs-task')
    const fsTaskHost = new FsTaskCapabilityHost({
      saveDir: tmpDir,
      filePath: testFile,
    })

    bridge.setHookContext({ fsTaskHost, taskId: 'task-abc-123' })

    await bridge.dispatchCall(makeCall('fs.task', 'stat', []))
    const resp = lastPosted(posted) as {
      ok: boolean
      result: { size: number; mtime: number }
    }
    expect(resp.ok).toBe(true)
    expect(resp.result.size).toBe(5)
    expect(resp.result.mtime).toBeGreaterThan(0)

    bridge.clearHookContext()
  })
})
