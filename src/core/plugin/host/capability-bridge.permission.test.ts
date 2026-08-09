// Exercises spec §I30 — the runtime permission gate at the top of
// dispatchCall(). When effectivePermissions is omitted, gating is off
// (back-compat). When provided, any capability call whose permission
// isn't in the set is rejected with `plugin.capability.unavailable`.
//
// Mirrors the lightweight bridge-with-stub-worker pattern used in the
// sibling phase.test, but without the heavy CapabilityHost setup since
// none of the dispatch handlers are reached.

import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { PluginManifest } from '@shared/types/plugin'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { CapabilityHost } from '../capabilities/interface'
import type { BridgeCallMessage } from './bridge-protocol'
import { CapabilityBridge } from './capability-bridge'

const PLUGIN_ID = 'test.perm.plugin'

const MANIFEST: PluginManifest = {
  manifestVersion: 1,
  id: PLUGIN_ID,
  name: 'Perm Test',
  version: '1.0.0',
  description: 'Permission gate test plugin',
  categories: [],
  engines: { motrix: '^1.0.0' },
  main: 'dist/plugin.js',
  permissions: ['storage'],
  optionalPermissions: ['notify', 'http'],
  activationEvents: [],
  contributes: {},
}

let _stubWorkerPath: string | undefined
function getStubWorkerPath(): string {
  if (_stubWorkerPath) return _stubWorkerPath
  const dir = mkdtempSync(path.join(tmpdir(), 'mbr-perm-worker-'))
  const file = path.join(dir, 'stub.cjs')
  writeFileSync(
    file,
    `const { parentPort } = require('worker_threads');
     parentPort && parentPort.on('message', () => {});`
  )
  _stubWorkerPath = file
  return file
}

function nullCapabilityHost(): CapabilityHost {
  const noop = vi.fn()
  return {
    createLog: () => ({
      trace: noop,
      debug: noop,
      info: noop,
      warn: noop,
      error: noop,
      fatal: noop,
    }),
    getTail: () => [],
    clearLog: noop,
    setLogVerbose: noop,
    isLogVerbose: () => false,
    subscribeLog: () => () => {},
    appSnapshot: () => ({
      version: '2.0.0',
      platform: 'darwin',
      runtime: 'electron',
      locale: 'en-US',
      arch: 'arm64',
    }),
    i18nSnapshot: () => ({
      language: 'en-US',
      dir: 'ltr',
      currentDict: {},
      fallbackDict: {},
    }),
    setLocale: () => {},
    onLocaleChange: () => () => {},
    flush: async () => {},
  } as unknown as CapabilityHost
}

interface BridgeWithSpy {
  bridge: CapabilityBridge
  posted: unknown[]
}

function makeBridge(
  effectivePermissions: ReadonlySet<string> | undefined
): BridgeWithSpy {
  const posted: unknown[] = []
  const bridge = new CapabilityBridge(
    {
      pluginId: PLUGIN_ID,
      manifest: MANIFEST,
      bundleSource: '',
      capabilityHost: nullCapabilityHost(),
      workerScriptPath: getStubWorkerPath(),
      heapMB: 32,
      appVersion: '2.0.0',
      runtime: 'server',
      hostLanguage: 'en-US',
      effectivePermissions,
    },
    {}
  )
  const w = (bridge as unknown as Record<string, any>).worker
  const origPost = w.postMessage.bind(w)
  w.postMessage = (m: unknown) => {
    posted.push(m)
    origPost(m)
  }
  return { bridge, posted }
}

function makeCall(capability: string, method: string): BridgeCallMessage {
  return { type: 'call', id: 1, capability, method, args: [] }
}

function lastError(posted: unknown[]): { code?: string; message?: string } {
  // Last posted msg should be a response with ok:false when the gate trips.
  // Skip the init message that gets queued at construction.
  for (let i = posted.length - 1; i >= 0; i--) {
    const m = posted[i] as { type?: string; ok?: boolean; error?: unknown }
    if (m.type === 'response' && m.ok === false) {
      return (m.error ?? {}) as { code?: string; message?: string }
    }
  }
  throw new Error('no error response posted')
}

describe('CapabilityBridge permission gate (spec §I30)', () => {
  let made: BridgeWithSpy
  afterEach(async () => {
    await made?.bridge.dispose()
  })

  it('denies a capability whose permission is not in effectivePermissions', async () => {
    made = makeBridge(new Set(['storage']))
    await made.bridge.dispatchCall(makeCall('notify', 'show'))
    const err = lastError(made.posted)
    expect(err.code).toBe('plugin.capability.unavailable')
    expect(err.message).toMatch(/permission/i)
  })

  it('permits a capability whose permission IS in effectivePermissions', async () => {
    made = makeBridge(new Set(['storage', 'notify']))
    await made.bridge.dispatchCall(makeCall('notify', 'show'))
    // No unavailable error should have been posted by the gate.
    // (A later dispatch error may occur — we only assert the gate didn't deny.)
    const denied = made.posted.some(
      (m) =>
        (m as { type?: string; error?: { code?: string } }).type ===
          'response' &&
        (m as { error?: { code?: string } }).error?.code ===
          'plugin.capability.unavailable' &&
        ((m as { error?: { message?: string } }).error?.message ?? '').includes(
          'permission'
        )
    )
    expect(denied).toBe(false)
  })

  it('permits auto-injected capabilities even with empty effective set', async () => {
    made = makeBridge(new Set())
    await made.bridge.dispatchCall(makeCall('crypto', 'randomBytes'))
    const denied = made.posted.some(
      (m) =>
        (m as { type?: string; error?: { code?: string } }).type ===
          'response' &&
        (m as { error?: { code?: string } }).error?.code ===
          'plugin.capability.unavailable' &&
        ((m as { error?: { message?: string } }).error?.message ?? '').includes(
          'permission'
        )
    )
    expect(denied).toBe(false)
  })

  it('skips gating entirely when effectivePermissions is omitted', async () => {
    made = makeBridge(undefined)
    await made.bridge.dispatchCall(makeCall('notify', 'show'))
    const denied = made.posted.some(
      (m) =>
        (m as { type?: string; error?: { code?: string } }).type ===
          'response' &&
        (m as { error?: { code?: string } }).error?.code ===
          'plugin.capability.unavailable' &&
        ((m as { error?: { message?: string } }).error?.message ?? '').includes(
          'permission'
        )
    )
    expect(denied).toBe(false)
  })
})
