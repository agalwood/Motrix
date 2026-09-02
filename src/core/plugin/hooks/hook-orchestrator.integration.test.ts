// src/core/plugin/hooks/hook-orchestrator.integration.test.ts
// End-to-end integration test for the PR-2 ffmpeg staging pipeline:
//   1. beforeFinalize chain runs a plugin that "transcodes" into saveDir
//      (we simulate ffmpeg via fs.writeFile to the staging-redirected path).
//   2. The orchestrator returns the explicit logical-to-private mapping but
//      performs no file mutation.
//   3. On chain abort, unjournaled bytes remain private for identity-aware
//      quarantine/cleanup instead of being recursively deleted.

import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { Worker } from 'node:worker_threads'
import type { PluginManifest } from '@shared/types/plugin'
import type { BeforeFinalizeContextDTO } from '@shared/types/plugin-hooks'
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  type Mock,
  vi,
} from 'vitest'
import type {
  CapabilityBridge,
  HookContextArgs,
} from '../host/capability-bridge'
import type { ActivePluginInfo, PluginHost } from '../host/plugin-host'
import { HookOrchestrator } from './hook-orchestrator'
import type { FfmpegStaging } from './staging-dir'

// ---------------------------------------------------------------------------
// Light-weight mock host (mirrors hook-orchestrator.test.ts pattern)
// ---------------------------------------------------------------------------

interface FixturePlugin {
  id: string
  role: 'resolve' | 'enrich' | 'post-process' | 'audit' | 'pre-resolve'
  handler: (args: {
    bridge: MockBridge
    saveDir: string
    pluginId: string
  }) => void | Promise<void>
}

interface MockBridge {
  setHookContext: Mock<(args: HookContextArgs) => void>
  clearHookContext: Mock<() => void>
  notifyAbort: Mock<() => void>
}

function makeManifest(p: FixturePlugin): PluginManifest {
  return {
    manifestVersion: 1,
    id: p.id,
    name: p.id,
    version: '1.0.0',
    description: '',
    main: 'dist/plugin.js',
    permissions: ['ffmpeg'],
    hostPermissions: ['<all_urls>'],
    activationEvents: [],
    engines: { motrix: '>=2.0.0 <3.0.0' },
    categories: [],
    contributes: { hooks: { beforeFinalize: { role: p.role } } },
  } as PluginManifest
}

function makeMockBridge(): MockBridge {
  return {
    setHookContext: vi.fn<(args: HookContextArgs) => void>(),
    clearHookContext: vi.fn<() => void>(),
    notifyAbort: vi.fn<() => void>(),
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

function makeMockHost(plugins: FixturePlugin[], saveDir: string): PluginHost {
  const bridges = new Map<string, MockBridge>()
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
    invokeHook: async (id, _hook, args) => {
      const plugin = plugins.find((p) => p.id === id)
      const bridge = bridges.get(id)
      if (!plugin || !bridge) return
      bridge.setHookContext(args.context)
      try {
        await plugin.handler({ bridge, saveDir, pluginId: id })
      } finally {
        bridge.clearHookContext()
      }
    },
    bridgeFor: (id: string) =>
      bridges.get(id) as unknown as CapabilityBridge | undefined,
    workerFor: () => undefined,
    disable: vi.fn(),
  }
  return host as PluginHost
}

function makeBeforeFinalizeDto(filePath: string): BeforeFinalizeContextDTO {
  return {
    sourceUrl: 'https://example.com/video',
    createdBy: 'user',
    requestedAt: 1_700_000_000_000,
    task: { id: 'task-1', saveDir: path.dirname(filePath) } as never,
    filePath,
  } as unknown as BeforeFinalizeContextDTO
}

// Simulate ffmpeg: writes input bytes to the staging-redirected output path
// and records the plugin's intended final filePath in the staged effects.
async function simulateFfmpegToStaging(args: {
  bridge: MockBridge
  inputPath: string
  outputPath: string
}): Promise<void> {
  const ctx = args.bridge.setHookContext.mock.calls[0]?.[0]
  if (!ctx || !('staging' in ctx) || !ctx.staging || !('staged' in ctx)) {
    throw new Error('beforeFinalize Hook context is incomplete')
  }
  const staging = ctx.staging as FfmpegStaging
  await staging.ensureDir()
  const redirected = staging.redirectOutput(args.outputPath)
  const bytes = await readFile(args.inputPath)
  await writeFile(redirected, bytes)
  // Plugin's ctx.update({ filePath }) equivalent — record final destination.
  ctx.staged.setFinalizePath(args.outputPath)
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

const TIMEOUTS = { series: 5_000, parallel: 5_000 }

describe('HookOrchestrator <-> FfmpegStaging — ffmpeg -> saveDir end-to-end', () => {
  let tmp: string
  beforeEach(async () => {
    tmp = await mkdtemp(path.join(os.tmpdir(), 'orch-int-'))
  })
  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true })
  })

  it('beforeFinalize returns a replacement mapping without promotion', async () => {
    const saveDir = path.join(tmp, 'sd')
    await mkdir(saveDir, { recursive: true })
    const inputPath = path.join(saveDir, 'input.webm')
    const finalPath = path.join(saveDir, 'final.mp4')
    await writeFile(inputPath, 'fake-input-bytes')

    const host = makeMockHost(
      [
        {
          id: 'alice',
          role: 'resolve',
          handler: async ({ bridge }) => {
            await simulateFfmpegToStaging({
              bridge,
              inputPath,
              outputPath: finalPath,
            })
          },
        },
      ],
      saveDir
    )

    const orch = new HookOrchestrator({
      host,
      hookTimeoutMs: TIMEOUTS,
      pluginsDir: tmp,
      pluginStorageRootFor: (id) => path.join(tmp, id, 'storage'),
    })

    const result = await orch.runBeforeFinalize(
      makeBeforeFinalizeDto(inputPath),
      'task-1'
    )

    expect(result.aborted).toBeFalsy()
    if (result.aborted) throw new Error('unreachable')
    expect(result.finalFilePath).toBe(finalPath)
    const stagingDir = path.join(tmp, 'alice', 'staging', 'task-1')
    expect(result.replacement).toEqual({
      pluginId: 'alice',
      stagedPath: path.join(stagingDir, 'final.mp4'),
    })
    expect(await readFile(result.replacement?.stagedPath ?? '', 'utf8')).toBe(
      'fake-input-bytes'
    )
    expect(await stat(finalPath).catch(() => null)).toBeNull()
  })

  it('beforeFinalize abort preserves private bytes for safe recovery', async () => {
    const saveDir = path.join(tmp, 'sd')
    await mkdir(saveDir, { recursive: true })
    const inputPath = path.join(saveDir, 'input.webm')
    const finalPath = path.join(saveDir, 'final.mp4')
    await writeFile(inputPath, 'fake-input-bytes')

    const host = makeMockHost(
      [
        {
          id: 'alice',
          // resolve = critical band; throwing aborts the entire chain.
          role: 'resolve',
          handler: async ({ bridge }) => {
            await simulateFfmpegToStaging({
              bridge,
              inputPath,
              outputPath: finalPath,
            })
            throw new Error('plugin rejects downstream')
          },
        },
      ],
      saveDir
    )

    const orch = new HookOrchestrator({
      host,
      hookTimeoutMs: TIMEOUTS,
      pluginsDir: tmp,
      pluginStorageRootFor: (id) => path.join(tmp, id, 'storage'),
    })

    const result = await orch.runBeforeFinalize(
      makeBeforeFinalizeDto(inputPath),
      'task-2'
    )

    expect(result.aborted).toBe(true)
    if (!result.aborted) throw new Error('unreachable')
    expect(result.reason).toContain('alice')
    // No file at the final saveDir location.
    expect(await stat(finalPath).catch(() => null)).toBeNull()
    const stagingDir = path.join(tmp, 'alice', 'staging', 'task-2')
    expect(await readFile(path.join(stagingDir, 'final.mp4'), 'utf8')).toBe(
      'fake-input-bytes'
    )
  })
})
