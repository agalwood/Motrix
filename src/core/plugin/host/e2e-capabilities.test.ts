// src/core/plugin/host/e2e-capabilities.test.ts
// End-to-end test: boots the test.allcaps fixture plugin and exercises every
// Phase 1A capability via the real QuickJS VM + worker bridge.
//
// Capability coverage:
//   log.info        — fire-and-forget, activation-exempt
//   app.runtime     — read from init snapshot (no bridge call)
//   crypto.hash     — effectful, exercised inside registered command
//   crypto.randomBytes — effectful, exercised inside registered command
//   storage.set     — effectful, exercised inside registered command
//   notify.show     — effectful, expected to throw (server runtime, unavailable)
//   ffmpeg.probe    — effectful, expected to throw (no binary in test env)
//   hooks.beforeCreate — registration during activation
//   commands.register  — registration during activation
//   lifecycle.onDeactivate — registration during activation

import path from 'node:path'
import Database from 'better-sqlite3'
import { describe, expect, it } from 'vitest'
import { CryptoCapabilityHost } from '../capabilities/crypto'
import { FfmpegCapabilityHost } from '../capabilities/ffmpeg'
import type { FfmpegDetection } from '../capabilities/ffmpeg-detect'
import type { CapabilityHost } from '../capabilities/interface'
import { UnavailableNotifyHost } from '../capabilities/notify'
import {
  ensureStorageSchema,
  StorageCapabilityHost,
} from '../capabilities/storage'
import { spawnTestBridge } from './test-helpers'

const FIXTURE_DIR = path.join(
  __dirname,
  '../../../../tests/fixtures/plugins/test.allcaps'
)

function buildAllcapsHost(): CapabilityHost {
  const noop = () => {}
  const noopAsync = async () => {}

  const crypto = new CryptoCapabilityHost()

  // Real SQLite-backed storage (in-memory so tests don't touch the filesystem)
  const db = new Database(':memory:')
  ensureStorageSchema(db)
  const storage = new StorageCapabilityHost({ db })

  // notify: server runtime = unavailable (will throw on show())
  const notify = new UnavailableNotifyHost()

  // ffmpeg: no binary → probe and launch methods throw
  const ffmpegDetect: FfmpegDetection = {
    available: false,
    binaryPath: undefined,
    version: undefined,
  }
  const ffmpeg = new FfmpegCapabilityHost({ detect: ffmpegDetect })

  const logNoop = {
    trace: noop,
    debug: noop,
    info: noop,
    warn: noop,
    error: noop,
    fatal: noop,
  }

  return {
    // ── Plan A ──────────────────────────────────────────────────────────────
    createLog: (_pluginId: string) => logNoop,
    getTail: (_pluginId: string, _limit: number) => [],
    clearLog: (_pluginId: string) => {},
    setLogVerbose: (_pluginId: string, _verbose: boolean) => {},
    isLogVerbose: (_pluginId: string) => false,
    subscribeLog: () => () => {},
    appSnapshot: () => ({
      version: '2.5.0',
      platform: process.platform as 'darwin' | 'win32' | 'linux',
      runtime: 'server' as const,
      locale: 'en-US',
      arch: process.arch as 'x64' | 'arm64',
    }),
    i18nSnapshot: (_pluginId: string) => ({
      language: 'en-US',
      dir: 'ltr' as const,
      currentDict: {},
      fallbackDict: {},
    }),
    setLocale: noop,
    onLocaleChange: (_handler: (lang: string) => void) => noop,
    flush: noopAsync,
    // ── Plan B ──────────────────────────────────────────────────────────────
    http: null as unknown as CapabilityHost['http'],
    fsTaskFor: () => null as unknown as ReturnType<CapabilityHost['fsTaskFor']>,
    fsStorageFor: () =>
      null as unknown as ReturnType<CapabilityHost['fsStorageFor']>,
    storage,
    metadata: null as unknown as CapabilityHost['metadata'],
    crypto,
    configFor: () => null as unknown as ReturnType<CapabilityHost['configFor']>,
    lifecycle: null as unknown as CapabilityHost['lifecycle'],
    commands: null as unknown as CapabilityHost['commands'],
    notify,
    ffmpeg,
    secrets: null as unknown as CapabilityHost['secrets'],
    cookieJarFor: () =>
      null as unknown as ReturnType<CapabilityHost['cookieJarFor']>,
  }
}

describe('Plugin Bridge E2E (all caps)', () => {
  it('boots fixture plugin, registers hooks + commands, invokes echoAll', async () => {
    const r = await spawnTestBridge(FIXTURE_DIR, {
      timeoutMs: 15_000,
      capabilityHost: buildAllcapsHost(),
    })

    // ── Boot assertions ──────────────────────────────────────────────────
    expect(r.errorCode).toBeUndefined()

    // hooks.beforeCreate registered during activation
    expect(r.registrations).toContainEqual({
      kind: 'hook',
      key: 'beforeCreate',
    })
    // commands.register during activation
    expect(r.registrations).toContainEqual({
      kind: 'command',
      key: 'test.allcaps.echoAll',
    })
    // lifecycle.onDeactivate registered during activation
    expect(
      r.registrations.find(
        (reg) =>
          reg.key === 'onDeactivate' || reg.key === 'lifecycle:onDeactivate'
      )
    ).toBeTruthy()

    // ── Command invocation assertions ────────────────────────────────────
    // callPlugin sends BridgeExecuteCommand → worker dispatches to the
    // locally registered 'test.allcaps.echoAll' handler, awaits the async
    // result, and returns it via BridgeExecuteCommandResult.
    const proof = (await r.callPlugin('test.allcaps.echoAll', null)) as {
      crypto: string
      storageVersion: number
      randomBytesLen: number
      appRuntime: string
      notifyResult: boolean
      ffmpegResult: boolean
    }

    // crypto.hash('sha256', 'abc') — well-known digest
    // SHA-256 of 'abc' = ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad
    // (matches Node.js crypto output)
    expect(proof.crypto).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'
    )

    // storage.set('hits', 2) returns {version: 2} (first set = 1, second = 2)
    expect(proof.storageVersion).toBe(2)

    // crypto.randomBytes(16) → marshaled as Array<number> in VM → .length = 16
    expect(proof.randomBytesLen).toBe(16)

    // app snapshot: runtime injected at init
    expect(proof.appRuntime).toBe('server')

    // notify.show throws (UnavailableNotifyHost) → notifyResult = false
    expect(proof.notifyResult).toBe(false)

    // ffmpeg.probe throws (no binary) → ffmpegResult = false
    expect(proof.ffmpegResult).toBe(false)

    await r.bridge.dispose()
  }, 20_000)
})
