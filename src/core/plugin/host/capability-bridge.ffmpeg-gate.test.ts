// src/core/plugin/host/capability-bridge.ffmpeg-gate.test.ts
// Exercises CapabilityBridge.gateFfmpegOutput across all 5 ffmpeg launch
// methods (transcode, run, extractAudio, mergeStreams, generateThumbnail).

import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { PluginManifest } from '@shared/types/plugin'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { CommandsCapabilityHost } from '../capabilities/commands'
import { ConfigCapabilityHost } from '../capabilities/config'
import { CryptoCapabilityHost } from '../capabilities/crypto'
import type { FfmpegOpHandle } from '../capabilities/ffmpeg'
import { HttpCapabilityHost } from '../capabilities/http'
import type { CapabilityHost } from '../capabilities/interface'
import type { StorageCapabilityHost } from '../capabilities/storage'
import { StagedEffectStore } from '../hooks/staged-effects'
import type { FfmpegStaging } from '../hooks/staging-dir'
import type { BridgeCallMessage } from './bridge-protocol'
import { CapabilityBridge } from './capability-bridge'

// ---------------------------------------------------------------------------
// Constants / fixtures
// ---------------------------------------------------------------------------

const PLUGIN_ID = 'test.ffmpeg.gate'
const SAVE_DIR = '/var/data/downloads/t-1'
const PS_ROOT = '/var/data/plugins/alice/storage'

const MANIFEST: PluginManifest = {
  manifestVersion: 1,
  id: PLUGIN_ID,
  name: 'FFmpeg Gate Test Plugin',
  version: '1.0.0',
  description: '',
  categories: [],
  engines: { motrix: '^1.0.0' },
  main: 'dist/plugin.js',
  permissions: ['ffmpeg'], // gate requires the capability permission
  activationEvents: [],
  contributes: {},
}

// ---------------------------------------------------------------------------
// Fake ffmpeg host — records calls without spawning processes
// ---------------------------------------------------------------------------

interface TranscodeCall {
  input: string
  output: string
}

interface FakeFfmpegHost {
  transcodeArgs: TranscodeCall[]
  transcode(opts: { input: string; output: string }): FfmpegOpHandle<{
    outputPath: string
  }>
  // Other methods needed by the interface — no-ops
  run(opts: { argv: string[]; outputPath: string }): FfmpegOpHandle<{
    outputPath: string
  }>
  extractAudio(opts: { input: string; output: string }): FfmpegOpHandle<{
    outputPath: string
  }>
  mergeStreams(opts: {
    videoInput: string
    audioInput: string
    output: string
  }): FfmpegOpHandle<{ outputPath: string }>
  generateThumbnail(opts: { input: string; output: string }): FfmpegOpHandle<{
    outputPath: string
  }>
  probe(opts: { path: string }): Promise<unknown>
}

function makeNoopHandle(outputPath: string): FfmpegOpHandle<{
  outputPath: string
}> {
  const result = Promise.resolve({ outputPath })
  const progress = (async function* () {})() as AsyncIterable<never>
  return {
    id: 'fake-op-id',
    result,
    progress,
    abort() {},
  }
}

function makeFakeFfmpegHost(): FakeFfmpegHost {
  const fake: FakeFfmpegHost = {
    transcodeArgs: [],
    transcode(opts) {
      fake.transcodeArgs.push({ input: opts.input, output: opts.output })
      return makeNoopHandle(opts.output)
    },
    run(opts) {
      return makeNoopHandle(opts.outputPath)
    },
    extractAudio(opts) {
      return makeNoopHandle(opts.output)
    },
    mergeStreams(opts) {
      return makeNoopHandle(opts.output)
    },
    generateThumbnail(opts) {
      return makeNoopHandle(opts.output)
    },
    probe() {
      return Promise.resolve({ durationMs: 0, streams: [] })
    },
  }
  return fake
}

/**
 * A fake ffmpeg host where the four launch methods throw if called.
 * Used by the "gate applies to all launch methods" tests to prove the
 * gate rejects before the method is ever reached.
 */
function makeFfmpegHostThatMustNotBeCalled(): FakeFfmpegHost {
  function mustNotCall(name: string): never {
    throw new Error(
      `ffmpeg.${name} should not have been called — gate should have rejected`
    )
  }
  return {
    transcodeArgs: [],
    transcode() {
      return mustNotCall('transcode')
    },
    run() {
      return mustNotCall('run')
    },
    extractAudio() {
      return mustNotCall('extractAudio')
    },
    mergeStreams() {
      return mustNotCall('mergeStreams')
    },
    generateThumbnail() {
      return mustNotCall('generateThumbnail')
    },
    probe() {
      return Promise.resolve({ durationMs: 0, streams: [] })
    },
  }
}

// ---------------------------------------------------------------------------
// Fake staging — records calls without touching the filesystem
// ---------------------------------------------------------------------------

interface FakeStagingObservable {
  staging: FfmpegStaging
  redirectOutputCalls: string[]
  ensureDirCalls: number
  assertQuotaCalls: number
  redirectedTo: string
}

function makeFakeStaging(saveDir: string): FakeStagingObservable {
  const stagingDir = '/tmp/fake-staging'
  const obs: FakeStagingObservable = {
    staging: undefined as unknown as FfmpegStaging,
    redirectOutputCalls: [],
    ensureDirCalls: 0,
    assertQuotaCalls: 0,
    redirectedTo: '',
  }
  obs.staging = {
    redirectOutput(p: string) {
      obs.redirectOutputCalls.push(p)
      const rel = p.startsWith(saveDir)
        ? p.slice(saveDir.length).replace(/^[/\\]/, '')
        : p
      obs.redirectedTo = path.join(stagingDir, rel)
      return obs.redirectedTo
    },
    async ensureDir() {
      obs.ensureDirCalls++
    },
    async assertQuota() {
      obs.assertQuotaCalls++
    },
    get dir() {
      return stagingDir
    },
  } as unknown as FfmpegStaging
  return obs
}

// ---------------------------------------------------------------------------
// Minimal capability host factory
// ---------------------------------------------------------------------------

function buildMinimalCapabilityHost(
  fakeFfmpeg: FakeFfmpegHost
): CapabilityHost {
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

  const storageBaseDir = mkdtempSync(path.join(tmpdir(), 'mbr-ffgate-store-'))
  const fsStorage = {
    read: vi.fn(async () => new Uint8Array()),
    write: vi.fn(async () => {}),
    delete: vi.fn(async () => {}),
    rename: vi.fn(async () => {}),
    mkdir: vi.fn(async () => {}),
    list: vi.fn(async () => []),
    stat: vi.fn(async () => ({ size: 0, mtime: new Date() })),
    exists: vi.fn(async () => false),
    readText: vi.fn(async () => ''),
    writeText: vi.fn(async () => {}),
    baseDir: storageBaseDir,
  }

  const configHost = new ConfigCapabilityHost({
    pluginId: PLUGIN_ID,
    readValues: () => ({}),
    schemaDefaults: {},
    secretFields: new Set<string>(),
  })

  const cookieJarStub = {
    cookieHeader: () => '',
    captureFromResponseHeaders: () => {},
  }

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
      ({ saveDir, filePath }) as unknown as ReturnType<
        CapabilityHost['fsTaskFor']
      >,
    fsStorageFor: () =>
      fsStorage as unknown as ReturnType<CapabilityHost['fsStorageFor']>,
    storage: storage as unknown as CapabilityHost['storage'],
    metadata: metadataHost as unknown as CapabilityHost['metadata'],
    crypto,
    configFor: () => configHost,
    lifecycle: null as unknown as CapabilityHost['lifecycle'],
    commands,
    notify: notify as unknown as CapabilityHost['notify'],
    ffmpeg: fakeFfmpeg as unknown as CapabilityHost['ffmpeg'],
    secrets: null as unknown as CapabilityHost['secrets'],
    cookieJarFor: () =>
      cookieJarStub as unknown as ReturnType<CapabilityHost['cookieJarFor']>,
  }
}

// ---------------------------------------------------------------------------
// Bridge + worker helpers (mirror phase.test.ts pattern)
// ---------------------------------------------------------------------------

let _stubWorkerPath: string | undefined
function getStubWorkerPath(): string {
  if (_stubWorkerPath) return _stubWorkerPath
  const dir = mkdtempSync(path.join(tmpdir(), 'mbr-ffgate-worker-'))
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
  manifest: PluginManifest = MANIFEST
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

describe('CapabilityBridge ffmpeg gate — transcode', () => {
  let fakeHost: FakeFfmpegHost
  let capHost: CapabilityHost

  beforeEach(async () => {
    fakeHost = makeFakeFfmpegHost()
    capHost = buildMinimalCapabilityHost(fakeHost)
    // Give the worker a tick to initialise so posted captures only test msgs.
    await new Promise((r) => setTimeout(r, 5))
  })

  // ── 1. rejects saveDir output in beforeCreate ───────────────────────────
  it('beforeCreate: saveDir output → destination_phase_disallowed', async () => {
    const { bridge, posted } = makeBridge(capHost)
    await new Promise((r) => setTimeout(r, 5))
    posted.length = 0

    const staged = new StagedEffectStore()
    bridge.setHookContext({
      fsTaskHost: capHost.fsTaskFor(SAVE_DIR, `${SAVE_DIR}/file.bin`),
      taskId: 'task-gate-1',
      phase: 'beforeCreate',
      staged,
      role: 'enrich',
      saveDir: SAVE_DIR,
      pluginStorageRoot: PS_ROOT,
    })

    const outputPath = path.join(SAVE_DIR, 'out.mp4')
    await bridge.dispatchCall(
      makeCall('ffmpeg', 'transcode', [
        { input: '/tmp/source.mp4', output: outputPath },
      ])
    )

    const resp = lastPosted(posted) as { ok: boolean; error: { code: string } }
    expect(resp.ok).toBe(false)
    expect(resp.error.code).toBe('plugin.ffmpeg.destination_phase_disallowed')
    // ffmpeg.transcode must NOT have been invoked
    expect(fakeHost.transcodeArgs).toHaveLength(0)

    bridge.clearHookContext()
    await bridge.dispose()
  })

  // ── 2. rejects saveDir output in afterComplete ──────────────────────────
  it('afterComplete: saveDir output → destination_phase_disallowed', async () => {
    const { bridge, posted } = makeBridge(capHost)
    await new Promise((r) => setTimeout(r, 5))
    posted.length = 0

    const staged = new StagedEffectStore()
    bridge.setHookContext({
      fsTaskHost: capHost.fsTaskFor(SAVE_DIR, `${SAVE_DIR}/file.bin`),
      taskId: 'task-gate-2',
      phase: 'afterComplete',
      staged,
      role: 'enrich',
      saveDir: SAVE_DIR,
      pluginStorageRoot: PS_ROOT,
    })

    const outputPath = path.join(SAVE_DIR, 'out.mp4')
    await bridge.dispatchCall(
      makeCall('ffmpeg', 'transcode', [
        { input: '/tmp/source.mp4', output: outputPath },
      ])
    )

    const resp = lastPosted(posted) as { ok: boolean; error: { code: string } }
    expect(resp.ok).toBe(false)
    expect(resp.error.code).toBe('plugin.ffmpeg.destination_phase_disallowed')
    expect(fakeHost.transcodeArgs).toHaveLength(0)

    bridge.clearHookContext()
    await bridge.dispose()
  })

  // ── 3. rejects saveDir output in onError ───────────────────────────────
  it('onError: saveDir output → destination_phase_disallowed', async () => {
    const { bridge, posted } = makeBridge(capHost)
    await new Promise((r) => setTimeout(r, 5))
    posted.length = 0

    const staged = new StagedEffectStore()
    bridge.setHookContext({
      fsTaskHost: capHost.fsTaskFor(SAVE_DIR, `${SAVE_DIR}/file.bin`),
      taskId: 'task-gate-3',
      phase: 'onError',
      staged,
      role: 'enrich',
      saveDir: SAVE_DIR,
      pluginStorageRoot: PS_ROOT,
    })

    const outputPath = path.join(SAVE_DIR, 'out.mp4')
    await bridge.dispatchCall(
      makeCall('ffmpeg', 'transcode', [
        { input: '/tmp/source.mp4', output: outputPath },
      ])
    )

    const resp = lastPosted(posted) as { ok: boolean; error: { code: string } }
    expect(resp.ok).toBe(false)
    expect(resp.error.code).toBe('plugin.ffmpeg.destination_phase_disallowed')
    expect(fakeHost.transcodeArgs).toHaveLength(0)

    bridge.clearHookContext()
    await bridge.dispose()
  })

  // ── 4. redirects saveDir output to staging in beforeFinalize + calls assertQuota ─
  it('beforeFinalize + staging: saveDir output is redirected and assertQuota is called', async () => {
    const { bridge, posted } = makeBridge(capHost)
    await new Promise((r) => setTimeout(r, 5))
    posted.length = 0

    const staged = new StagedEffectStore()
    const stageObs = makeFakeStaging(SAVE_DIR)

    bridge.setHookContext({
      fsTaskHost: capHost.fsTaskFor(SAVE_DIR, `${SAVE_DIR}/file.bin`),
      taskId: 'task-gate-4',
      phase: 'beforeFinalize',
      staged,
      role: 'enrich',
      saveDir: SAVE_DIR,
      pluginStorageRoot: PS_ROOT,
      staging: stageObs.staging,
    })

    const outputPath = path.join(SAVE_DIR, 'out.mp4')
    await bridge.dispatchCall(
      makeCall('ffmpeg', 'transcode', [
        { input: '/tmp/source.mp4', output: outputPath },
      ])
    )

    const resp = lastPosted(posted) as { ok: boolean; result: { opId: string } }
    expect(resp.ok).toBe(true)
    expect(typeof resp.result.opId).toBe('string')

    // The staging redirectOutput was called
    expect(stageObs.redirectOutputCalls).toHaveLength(1)
    expect(stageObs.redirectOutputCalls[0]).toBe(outputPath)

    // ensureDir and assertQuota were both called
    expect(stageObs.ensureDirCalls).toBe(1)
    expect(stageObs.assertQuotaCalls).toBe(1)

    // transcode was called with the redirected (staged) output, not the original
    expect(fakeHost.transcodeArgs).toHaveLength(1)
    expect(fakeHost.transcodeArgs[0]?.output).toBe(stageObs.redirectedTo)
    expect(fakeHost.transcodeArgs[0]?.output).not.toBe(outputPath)

    bridge.clearHookContext()
    await bridge.dispose()
  })

  // ── 5. allows pluginStorage output in any phase without staging ─────────
  it('beforeCreate: pluginStorage output passes through immediately without staging', async () => {
    const { bridge, posted } = makeBridge(capHost)
    await new Promise((r) => setTimeout(r, 5))
    posted.length = 0

    const staged = new StagedEffectStore()
    const stageObs = makeFakeStaging(SAVE_DIR)

    bridge.setHookContext({
      fsTaskHost: capHost.fsTaskFor(SAVE_DIR, `${SAVE_DIR}/file.bin`),
      taskId: 'task-gate-5',
      phase: 'beforeCreate',
      staged,
      role: 'enrich',
      saveDir: SAVE_DIR,
      pluginStorageRoot: PS_ROOT,
      staging: stageObs.staging,
    })

    // Output goes to plugin storage root — allowed in any phase
    const outputPath = path.join(PS_ROOT, 'cache', 'out.mp4')
    await bridge.dispatchCall(
      makeCall('ffmpeg', 'transcode', [
        { input: '/tmp/source.mp4', output: outputPath },
      ])
    )

    const resp = lastPosted(posted) as { ok: boolean; result: { opId: string } }
    expect(resp.ok).toBe(true)
    expect(typeof resp.result.opId).toBe('string')

    // No staging should have occurred
    expect(stageObs.redirectOutputCalls).toHaveLength(0)
    expect(stageObs.ensureDirCalls).toBe(0)
    expect(stageObs.assertQuotaCalls).toBe(0)

    // transcode was called with the original output path unchanged
    expect(fakeHost.transcodeArgs).toHaveLength(1)
    expect(fakeHost.transcodeArgs[0]?.output).toBe(outputPath)

    bridge.clearHookContext()
    await bridge.dispose()
  })

  // ── 6. rejects "other" output paths with destination_phase_disallowed ──
  it('any phase: output outside saveDir and pluginStorage → destination_phase_disallowed', async () => {
    const { bridge, posted } = makeBridge(capHost)
    await new Promise((r) => setTimeout(r, 5))
    posted.length = 0

    const staged = new StagedEffectStore()
    bridge.setHookContext({
      fsTaskHost: capHost.fsTaskFor(SAVE_DIR, `${SAVE_DIR}/file.bin`),
      taskId: 'task-gate-6',
      phase: 'beforeFinalize',
      staged,
      role: 'enrich',
      saveDir: SAVE_DIR,
      pluginStorageRoot: PS_ROOT,
    })

    // Output goes to some unrelated directory — not saveDir, not pluginStorage
    const outputPath = '/etc/malicious/out.mp4'
    await bridge.dispatchCall(
      makeCall('ffmpeg', 'transcode', [
        { input: '/tmp/source.mp4', output: outputPath },
      ])
    )

    const resp = lastPosted(posted) as { ok: boolean; error: { code: string } }
    expect(resp.ok).toBe(false)
    expect(resp.error.code).toBe('plugin.ffmpeg.destination_phase_disallowed')
    expect(fakeHost.transcodeArgs).toHaveLength(0)

    bridge.clearHookContext()
    await bridge.dispose()
  })
})

// ---------------------------------------------------------------------------
// Gate applies identically to all launch methods — these tests prove the
// gate fires for each method by routing a saveDir-output call in
// afterComplete and asserting the must-not-call sentinel was never reached.
// ---------------------------------------------------------------------------

describe('CapabilityBridge ffmpeg gate — all launch methods', () => {
  let capHost: CapabilityHost

  beforeEach(async () => {
    // Use the "must not be called" fake so the tests fail loudly if the gate
    // passes control through to the ffmpeg host instead of rejecting.
    capHost = buildMinimalCapabilityHost(makeFfmpegHostThatMustNotBeCalled())
    await new Promise((r) => setTimeout(r, 5))
  })

  const otherMethods = [
    {
      method: 'run',
      argShape: { argv: [] as string[], outputPath: `${SAVE_DIR}/out.mp4` },
    },
    {
      method: 'extractAudio',
      argShape: { input: '/in.webm', output: `${SAVE_DIR}/out.aac` },
    },
    {
      method: 'mergeStreams',
      argShape: {
        videoInput: '/v.mp4',
        audioInput: '/a.aac',
        output: `${SAVE_DIR}/merged.mp4`,
      },
    },
    {
      method: 'generateThumbnail',
      argShape: { input: '/in.mp4', output: `${SAVE_DIR}/thumb.jpg` },
    },
  ] as const

  for (const { method, argShape } of otherMethods) {
    it(`${method}: saveDir output in afterComplete → destination_phase_disallowed`, async () => {
      const { bridge, posted } = makeBridge(capHost)
      await new Promise((r) => setTimeout(r, 5))
      posted.length = 0

      const staged = new StagedEffectStore()
      bridge.setHookContext({
        fsTaskHost: capHost.fsTaskFor(SAVE_DIR, `${SAVE_DIR}/file.bin`),
        taskId: `t-${method}`,
        phase: 'afterComplete',
        staged,
        role: 'enrich',
        saveDir: SAVE_DIR,
        pluginStorageRoot: PS_ROOT,
      })

      await bridge.dispatchCall(makeCall('ffmpeg', method, [argShape]))

      const resp = lastPosted(posted) as {
        ok: boolean
        error: { code: string }
      }
      expect(resp.ok).toBe(false)
      expect(resp.error.code).toBe('plugin.ffmpeg.destination_phase_disallowed')

      bridge.clearHookContext()
      await bridge.dispose()
    })
  }
})
