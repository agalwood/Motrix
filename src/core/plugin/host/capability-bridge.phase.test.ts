// src/core/plugin/host/capability-bridge.phase.test.ts
// Exercises the Phase × Capability matrix gate wired into dispatchCall().
// Uses the same lightweight mock-worker pattern as capability-bridge.dispatch.test.ts:
// a real CapabilityBridge is constructed with a no-op stub worker so no thread
// is actually used for computation, then dispatchCall() is called directly.

import { mkdtempSync, writeFileSync } from 'node:fs'
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
import { FsTaskCapabilityHost } from '../capabilities/fs-task'
import { HttpCapabilityHost } from '../capabilities/http'
import type { CapabilityHost } from '../capabilities/interface'
import type { StorageCapabilityHost } from '../capabilities/storage'
import { StagedEffectStore } from '../hooks/staged-effects'
import { FfmpegStaging } from '../hooks/staging-dir'
import type { BridgeCallMessage } from './bridge-protocol'
import { CapabilityBridge } from './capability-bridge'

// ---------------------------------------------------------------------------
// Constants / fixtures
// ---------------------------------------------------------------------------

const PLUGIN_ID = 'test.phase.plugin'

/** Manifest with fs.task.write permission so ctx.update(filename) is allowed. */
const MANIFEST_WITH_FS_WRITE: PluginManifest = {
  manifestVersion: 1,
  id: PLUGIN_ID,
  name: 'Phase Test Plugin',
  version: '1.0.0',
  description: 'Phase matrix test plugin',
  categories: [],
  engines: { motrix: '^1.0.0' },
  main: 'dist/plugin.js',
  permissions: ['fs.task.write'],
  activationEvents: [],
  contributes: {},
}

/** Manifest without fs.task.write permission. */
const MANIFEST_NO_PERMS: PluginManifest = {
  ...MANIFEST_WITH_FS_WRITE,
  permissions: [],
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Shared temp dir used for fs.task sandbox. */
let tmpDir: string
let testFilePath: string

function ensureTestFile(): void {
  if (!tmpDir) {
    tmpDir = mkdtempSync(path.join(tmpdir(), 'mbr-phase-'))
    testFilePath = path.join(tmpDir, 'test.bin')
    writeFileSync(testFilePath, 'hello phase')
  }
}

function buildCapabilityHost(): CapabilityHost {
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

  const notify = { available: true, show: vi.fn(async () => {}) }

  const metadataHost = {
    get: vi.fn(async () => null),
    has: vi.fn(async () => false),
    getAll: vi.fn(async () => ({})),
    keys: vi.fn(async () => []),
    set: vi.fn(async () => {}),
    delete: vi.fn(async () => {}),
  }

  const httpStub = new HttpCapabilityHost()

  const storageBaseDir = mkdtempSync(path.join(tmpdir(), 'mbr-phase-store-'))
  const fsStorage = new FsStorageCapabilityHost({
    pluginStorageRoot: path.join(storageBaseDir, 'storage'),
  })

  const configHost = new ConfigCapabilityHost({
    pluginId: PLUGIN_ID,
    readValues: () => ({}),
    schemaDefaults: {},
    secretFields: new Set<string>(),
  })

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

  ensureTestFile()

  return {
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
      currentDict: {},
      fallbackDict: {},
    }),
    setLocale: () => {},
    onLocaleChange: () => () => {},
    flush: async () => {},
    http: httpStub,
    fsTaskFor: (saveDir, filePath) =>
      new FsTaskCapabilityHost({ saveDir, filePath }),
    fsStorageFor: () => fsStorage,
    storage: storage as unknown as CapabilityHost['storage'],
    metadata: metadataHost as unknown as CapabilityHost['metadata'],
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
}

/** Create a stub worker file that does nothing (no thread computation). */
let _stubWorkerPath: string | undefined
function getStubWorkerPath(): string {
  if (_stubWorkerPath) return _stubWorkerPath
  const { mkdtempSync: mktemp } = require('node:fs')
  const { tmpdir: tmp } = require('node:os')
  const dir = mktemp(path.join(tmp(), 'mbr-phase-worker-'))
  const file = path.join(dir, 'stub.cjs')
  writeFileSync(
    file,
    `const { parentPort } = require('worker_threads');
     parentPort && parentPort.on('message', () => {});`
  )
  _stubWorkerPath = file
  return file
}

interface BridgeWithSpy {
  bridge: CapabilityBridge
  posted: unknown[]
}

function makeBridge(
  capHost: CapabilityHost,
  manifest: PluginManifest = MANIFEST_WITH_FS_WRITE
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
  const w = (bridge as unknown as Record<string, any>).worker
  const origPost = w.postMessage.bind(w)
  w.postMessage = (msg: unknown) => {
    posted.push(msg)
    origPost(msg)
  }
  return { bridge, posted }
}

function makeCall(
  capability: string,
  method: string,
  args: unknown[]
): BridgeCallMessage {
  return { type: 'call', id: 99, capability, method, args }
}

function lastPosted(posted: unknown[]): unknown {
  if (posted.length === 0) throw new Error('posted array is empty')
  return posted[posted.length - 1]
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('CapabilityBridge phase matrix gate', () => {
  let capHost: CapabilityHost

  beforeEach(async () => {
    capHost = buildCapabilityHost()
    // Give the worker a tick to initialise so posted captures only test msgs.
    await new Promise((r) => setTimeout(r, 5))
  })

  // ── 1. Idle phase passes through ────────────────────────────────────────
  it('idle phase: metadata.set reaches the underlying metadata host (immediate)', async () => {
    const { bridge, posted } = makeBridge(capHost)
    await new Promise((r) => setTimeout(r, 5))
    posted.length = 0

    // No setHookContext call → currentPhase === 'idle' → pass-through to
    // dispatchMetadata, which throws "not_available_outside_hook" because
    // there is no taskId. But importantly it does NOT hit the matrix gate.
    await bridge.dispatchCall(makeCall('metadata', 'set', ['k', 'v']))
    const resp = lastPosted(posted) as { ok: boolean; error: { code: string } }
    // Expect the "outside hook" error, not "disallowed_in_phase"
    expect(resp.ok).toBe(false)
    expect(resp.error.code).toBe('plugin.metadata.not_available_outside_hook')

    await bridge.dispose()
  })

  // ── 2. Disallowed verdict ────────────────────────────────────────────────
  it('beforeFinalize: fs.task.rename is disallowed → sendError with disallowed_in_phase', async () => {
    const { bridge, posted } = makeBridge(capHost)
    await new Promise((r) => setTimeout(r, 5))
    posted.length = 0

    const staged = new StagedEffectStore()
    const fsTaskHost = capHost.fsTaskFor(tmpDir, testFilePath)

    bridge.setHookContext({
      fsTaskHost,
      taskId: 'task-1',
      phase: 'beforeFinalize',
      staged,
      role: 'enrich',
      saveDir: tmpDir,
      pluginStorageRoot: '',
    })

    await bridge.dispatchCall(makeCall('fs.task', 'rename', ['new-name.bin']))
    const resp = lastPosted(posted) as { ok: boolean; error: { code: string } }
    expect(resp.ok).toBe(false)
    expect(resp.error.code).toBe('plugin.capability.disallowed_in_phase')

    // Confirm no staging side-effects occurred
    expect(staged.allHttpPatches()).toHaveLength(0)
    expect(staged.pendingFinalizePath).toBeUndefined()

    bridge.clearHookContext()
    await bridge.dispose()
  })

  // ── 3. Staged ctx.update beforeCreate ───────────────────────────────────
  it('beforeCreate: ctx.update({filename}) is staged and sendResponse returns undefined', async () => {
    const { bridge, posted } = makeBridge(capHost, MANIFEST_WITH_FS_WRITE)
    await new Promise((r) => setTimeout(r, 5))
    posted.length = 0

    const staged = new StagedEffectStore()
    const fsTaskHost = capHost.fsTaskFor(tmpDir, testFilePath)

    bridge.setHookContext({
      fsTaskHost,
      taskId: 'task-2',
      phase: 'beforeCreate',
      staged,
      role: 'enrich',
      saveDir: tmpDir,
      pluginStorageRoot: '',
    })

    await bridge.dispatchCall(
      makeCall('ctx', 'update', [{ filename: 'x.bin' }])
    )
    const resp = lastPosted(posted) as { ok: boolean; result: unknown }
    expect(resp.ok).toBe(true)
    expect(resp.result).toBeUndefined()

    // Confirm patch was appended
    const patches = staged.allHttpPatches()
    expect(patches).toHaveLength(1)
    expect(patches[0]?.patch.filename).toBe('x.bin')
    expect(patches[0]?.pluginId).toBe(PLUGIN_ID)

    bridge.clearHookContext()
    await bridge.dispose()
  })

  // ── 4. Staged metadata.set beforeCreate ─────────────────────────────────
  it('beforeCreate: metadata.set is staged → appendMeta called, sendResponse ok', async () => {
    const { bridge, posted } = makeBridge(capHost)
    await new Promise((r) => setTimeout(r, 5))
    posted.length = 0

    const staged = new StagedEffectStore()
    const appendMetaSpy = vi.spyOn(staged, 'appendMeta')
    const fsTaskHost = capHost.fsTaskFor(tmpDir, testFilePath)

    bridge.setHookContext({
      fsTaskHost,
      taskId: 'task-3',
      phase: 'beforeCreate',
      staged,
      role: 'enrich',
      saveDir: tmpDir,
      pluginStorageRoot: '',
    })

    await bridge.dispatchCall(makeCall('metadata', 'set', ['myKey', 'myVal']))
    const resp = lastPosted(posted) as { ok: boolean; result: unknown }
    expect(resp.ok).toBe(true)
    expect(resp.result).toBeUndefined()

    expect(appendMetaSpy).toHaveBeenCalledWith({
      pluginId: PLUGIN_ID,
      op: 'set',
      key: 'myKey',
      value: 'myVal',
    })

    bridge.clearHookContext()
    await bridge.dispose()
  })

  // ── 5. Audit role + ctx.update → fails with AuditRoleCannotMutate ───────
  it('beforeCreate: audit role + ctx.update → sendError with PLUGIN_RUNTIME_FAULT', async () => {
    const { bridge, posted } = makeBridge(capHost, MANIFEST_WITH_FS_WRITE)
    await new Promise((r) => setTimeout(r, 5))
    posted.length = 0

    const staged = new StagedEffectStore()
    const fsTaskHost = capHost.fsTaskFor(tmpDir, testFilePath)

    bridge.setHookContext({
      fsTaskHost,
      taskId: 'task-4',
      phase: 'beforeCreate',
      staged,
      role: 'audit', // audit role must not mutate
      saveDir: tmpDir,
      pluginStorageRoot: '',
    })

    await bridge.dispatchCall(
      makeCall('ctx', 'update', [{ filename: 'x.bin' }])
    )
    const resp = lastPosted(posted) as {
      ok: boolean
      error: { code: string; message: string }
    }
    expect(resp.ok).toBe(false)
    // AppError.code = ErrorCode.PluginRuntimeFault = 'PLUGIN_RUNTIME_FAULT'
    expect(resp.error.code).toBe('PLUGIN_RUNTIME_FAULT')
    expect(resp.error.message).toContain('AuditRoleCannotMutate')

    // No patches should have been staged
    expect(staged.allHttpPatches()).toHaveLength(0)

    bridge.clearHookContext()
    await bridge.dispose()
  })

  // ── 5b. ctx.update without fs.task.write permission → fails ─────────────
  it('beforeCreate: ctx.update({filename}) without fs.task.write perm → error', async () => {
    const { bridge, posted } = makeBridge(capHost, MANIFEST_NO_PERMS)
    await new Promise((r) => setTimeout(r, 5))
    posted.length = 0

    const staged = new StagedEffectStore()
    const fsTaskHost = capHost.fsTaskFor(tmpDir, testFilePath)

    bridge.setHookContext({
      fsTaskHost,
      taskId: 'task-5b',
      phase: 'beforeCreate',
      staged,
      role: 'enrich',
      saveDir: tmpDir,
      pluginStorageRoot: '',
    })

    await bridge.dispatchCall(
      makeCall('ctx', 'update', [{ filename: 'x.bin' }])
    )
    const resp = lastPosted(posted) as { ok: boolean; error: { code: string } }
    expect(resp.ok).toBe(false)
    expect(staged.allHttpPatches()).toHaveLength(0)

    bridge.clearHookContext()
    await bridge.dispose()
  })

  // ── 6. Staged metadata.delete beforeFinalize ────────────────────────────
  it('beforeFinalize: metadata.delete is staged correctly', async () => {
    const { bridge, posted } = makeBridge(capHost)
    await new Promise((r) => setTimeout(r, 5))
    posted.length = 0

    const staged = new StagedEffectStore()
    const appendMetaSpy = vi.spyOn(staged, 'appendMeta')
    const fsTaskHost = capHost.fsTaskFor(tmpDir, testFilePath)

    bridge.setHookContext({
      fsTaskHost,
      taskId: 'task-6',
      phase: 'beforeFinalize',
      staged,
      role: 'enrich',
      saveDir: tmpDir,
      pluginStorageRoot: '',
    })

    await bridge.dispatchCall(makeCall('metadata', 'delete', ['delKey']))
    const resp = lastPosted(posted) as { ok: boolean; result: unknown }
    expect(resp.ok).toBe(true)
    expect(appendMetaSpy).toHaveBeenCalledWith({
      pluginId: PLUGIN_ID,
      op: 'delete',
      key: 'delKey',
    })

    bridge.clearHookContext()
    await bridge.dispose()
  })

  // ── 7. clearHookContext resets phase to idle ─────────────────────────────
  it('clearHookContext resets phase: subsequent metadata.set goes through immediate path', async () => {
    const { bridge, posted } = makeBridge(capHost)
    await new Promise((r) => setTimeout(r, 5))
    posted.length = 0

    const staged = new StagedEffectStore()
    const fsTaskHost = capHost.fsTaskFor(tmpDir, testFilePath)

    bridge.setHookContext({
      fsTaskHost,
      taskId: 'task-7',
      phase: 'beforeCreate',
      staged,
      role: 'enrich',
      saveDir: tmpDir,
      pluginStorageRoot: '',
    })
    bridge.clearHookContext()

    // After clear, metadata.set must go through immediate path (outside hook) → error
    await bridge.dispatchCall(makeCall('metadata', 'set', ['k', 'v']))
    const resp = lastPosted(posted) as { ok: boolean; error: { code: string } }
    expect(resp.ok).toBe(false)
    expect(resp.error.code).toBe('plugin.metadata.not_available_outside_hook')

    // Staged store unchanged
    expect(staged.allHttpPatches()).toHaveLength(0)

    await bridge.dispose()
  })

  // ── 8. afterComplete: metadata.set is disallowed ─────────────────────────
  it('afterComplete: metadata.set is disallowed in phase', async () => {
    const { bridge, posted } = makeBridge(capHost)
    await new Promise((r) => setTimeout(r, 5))
    posted.length = 0

    const staged = new StagedEffectStore()
    const fsTaskHost = capHost.fsTaskFor(tmpDir, testFilePath)

    bridge.setHookContext({
      fsTaskHost,
      taskId: 'task-8',
      phase: 'afterComplete',
      staged,
      role: 'enrich',
      saveDir: tmpDir,
      pluginStorageRoot: '',
    })

    await bridge.dispatchCall(makeCall('metadata', 'set', ['k', 'v']))
    const resp = lastPosted(posted) as { ok: boolean; error: { code: string } }
    expect(resp.ok).toBe(false)
    expect(resp.error.code).toBe('plugin.capability.disallowed_in_phase')

    bridge.clearHookContext()
    await bridge.dispose()
  })

  // ── 9. beforeCreate: fs.task.stat is disallowed ──────────────────────────
  it('beforeCreate: fs.task.stat is disallowed (file not yet on disk)', async () => {
    const { bridge, posted } = makeBridge(capHost)
    await new Promise((r) => setTimeout(r, 5))
    posted.length = 0

    const staged = new StagedEffectStore()
    const fsTaskHost = capHost.fsTaskFor(tmpDir, testFilePath)

    bridge.setHookContext({
      fsTaskHost,
      taskId: 'task-9',
      phase: 'beforeCreate',
      staged,
      role: 'enrich',
      saveDir: tmpDir,
      pluginStorageRoot: '',
    })

    await bridge.dispatchCall(makeCall('fs.task', 'stat', []))
    const resp = lastPosted(posted) as { ok: boolean; error: { code: string } }
    expect(resp.ok).toBe(false)
    expect(resp.error.code).toBe('plugin.capability.disallowed_in_phase')

    bridge.clearHookContext()
    await bridge.dispose()
  })

  // ── 10. beforeFinalize: ctx.update filePath staged ───────────────────────
  it('beforeFinalize: ctx.update({filePath}) is staged as finalize path', async () => {
    const { bridge, posted } = makeBridge(capHost, MANIFEST_WITH_FS_WRITE)
    await new Promise((r) => setTimeout(r, 5))
    posted.length = 0

    const staged = new StagedEffectStore()
    const fsTaskHost = capHost.fsTaskFor(tmpDir, testFilePath)

    bridge.setHookContext({
      fsTaskHost,
      taskId: 'task-10',
      phase: 'beforeFinalize',
      staged,
      role: 'enrich',
      saveDir: tmpDir,
      pluginStorageRoot: '',
    })

    // filePath that stays within saveDir
    const validPath = path.join(tmpDir, 'renamed.bin')
    await bridge.dispatchCall(
      makeCall('ctx', 'update', [{ filePath: validPath }])
    )
    const resp = lastPosted(posted) as { ok: boolean; result: unknown }
    expect(resp.ok).toBe(true)
    expect(staged.pendingFinalizePath).toBe(validPath)

    bridge.clearHookContext()
    await bridge.dispose()
  })

  // ── 11. TODO: chain failure → no DB write (requires HookOrchestrator T12) ─
  // This test is deferred to Task 12. The full chain failure path (staged
  // effects not committed when a plugin throws) requires HookOrchestrator to
  // be present so we can verify commitMetadata is never called.
  // Marked as TODO so the gap is visible during review.

  // ── 12. FfmpegStaging wiring: beforeFinalize redirects outputPath ────────
  it('beforeFinalize + staging: ffmpeg.run outputPath is redirected to staging dir', async () => {
    const { bridge, posted } = makeBridge(capHost)
    await new Promise((r) => setTimeout(r, 5))
    posted.length = 0

    const saveDir = mkdtempSync(path.join(tmpdir(), 'mbr-staging-save-'))
    const pluginsDir = mkdtempSync(path.join(tmpdir(), 'mbr-staging-plugins-'))
    const staged = new StagedEffectStore()
    const fsTaskHost = capHost.fsTaskFor(tmpDir, testFilePath)
    const staging = new FfmpegStaging({
      pluginsDir,
      taskId: 'task-12',
      pluginId: PLUGIN_ID,
      saveDir,
      quotaBytes: 4 * 1024 ** 3,
    })

    // Spy on the ffmpeg.run call to capture what outputPath reaches the host
    const ffmpegRunSpy = vi.spyOn(
      capHost.ffmpeg as unknown as Record<string, any>,
      'run'
    )

    bridge.setHookContext({
      fsTaskHost,
      taskId: 'task-12',
      phase: 'beforeFinalize',
      staged,
      role: 'enrich',
      saveDir,
      pluginStorageRoot: path.join(pluginsDir, PLUGIN_ID, 'storage'),
      staging,
    })

    const outputPath = path.join(saveDir, 'out.mp4')
    await bridge.dispatchCall(
      makeCall('ffmpeg', 'run', [
        { argv: ['-i', 'in.mp4', outputPath], outputPath },
      ])
    )

    // The spy should have been called with the redirected path
    expect(ffmpegRunSpy).toHaveBeenCalledOnce()
    const callArg = ffmpegRunSpy.mock.calls[0]?.[0] as { outputPath: string }
    expect(callArg.outputPath).toBe(path.join(staging.dir, 'out.mp4'))
    // The redirected path starts with staging.dir, not saveDir
    expect(callArg.outputPath).not.toContain(saveDir)

    bridge.clearHookContext()
    await bridge.dispose()
  })

  // ── 13. FfmpegStaging wiring: beforeFinalize without staging → pass through ─
  it('beforeFinalize without staging: ffmpeg.run outputPath is NOT redirected', async () => {
    const { bridge, posted } = makeBridge(capHost)
    await new Promise((r) => setTimeout(r, 5))
    posted.length = 0

    const saveDir = mkdtempSync(path.join(tmpdir(), 'mbr-staging-nosave-'))
    const staged = new StagedEffectStore()
    const fsTaskHost = capHost.fsTaskFor(tmpDir, testFilePath)

    const ffmpegRunSpy = vi.spyOn(
      capHost.ffmpeg as unknown as Record<string, any>,
      'run'
    )

    // No staging supplied — staging field omitted
    bridge.setHookContext({
      fsTaskHost,
      taskId: 'task-13',
      phase: 'beforeFinalize',
      staged,
      role: 'enrich',
      saveDir,
      pluginStorageRoot: '',
    })

    const outputPath = path.join(saveDir, 'out.mp4')
    await bridge.dispatchCall(
      makeCall('ffmpeg', 'run', [
        { argv: ['-i', 'in.mp4', outputPath], outputPath },
      ])
    )

    expect(ffmpegRunSpy).toHaveBeenCalledOnce()
    const callArg = ffmpegRunSpy.mock.calls[0]?.[0] as { outputPath: string }
    // Must be the original path, not redirected
    expect(callArg.outputPath).toBe(outputPath)

    bridge.clearHookContext()
    await bridge.dispose()
  })

  // ── 14. FfmpegStaging wiring: beforeCreate does NOT redirect ────────────
  it('beforeCreate: ffmpeg.run outputPath is NOT redirected even with staging set', async () => {
    const { bridge, posted } = makeBridge(capHost)
    await new Promise((r) => setTimeout(r, 5))
    posted.length = 0

    const saveDir = mkdtempSync(path.join(tmpdir(), 'mbr-staging-bc-'))
    const pluginsDir = mkdtempSync(
      path.join(tmpdir(), 'mbr-staging-bc-plugins-')
    )
    const staged = new StagedEffectStore()
    const fsTaskHost = capHost.fsTaskFor(tmpDir, testFilePath)
    const staging = new FfmpegStaging({
      pluginsDir,
      taskId: 'task-14',
      pluginId: PLUGIN_ID,
      saveDir,
      quotaBytes: 4 * 1024 ** 3,
    })

    const ffmpegRunSpy = vi.spyOn(
      capHost.ffmpeg as unknown as Record<string, any>,
      'run'
    )

    bridge.setHookContext({
      fsTaskHost,
      taskId: 'task-14',
      phase: 'beforeCreate', // not beforeFinalize → no redirect
      staged,
      role: 'enrich',
      saveDir,
      pluginStorageRoot: '',
      staging,
    })

    const outputPath = path.join(saveDir, 'out.mp4')
    await bridge.dispatchCall(
      makeCall('ffmpeg', 'run', [
        { argv: ['-i', 'in.mp4', outputPath], outputPath },
      ])
    )

    expect(ffmpegRunSpy).toHaveBeenCalledOnce()
    const callArg = ffmpegRunSpy.mock.calls[0]?.[0] as { outputPath: string }
    expect(callArg.outputPath).toBe(outputPath)

    bridge.clearHookContext()
    await bridge.dispose()
  })
})
