// Tests for createElectronCapabilityHost.
//
// Verifies that the factory constructs and returns the full CapabilityHost
// surface with all Plan B capabilities wired. Does NOT exercise behavioral
// correctness — Tasks 4-17 cover that. This test only checks wiring.
//
// Uses relative imports because vitest.config.ts does not alias @main.

import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// ---------------------------------------------------------------------------
// Electron mocks — hoisted so vi.mock factories can reference them.
// ---------------------------------------------------------------------------

const { MockNotification, mockLocateFfmpeg, mockVersionDetectorFactory } =
  vi.hoisted(() => {
    class MockNotification {
      static isSupported = vi.fn(() => true)
      on(_ev: string, _fn: () => void): void {}
      show(): void {}
      close(): void {}
    }

    return {
      MockNotification,
      mockLocateFfmpeg: vi.fn(async () => ({
        available: false,
        binaryPath: null as string | null,
        version: null,
      })),
      mockVersionDetectorFactory: vi.fn(() => async () => ({
        active: null,
        candidates: [],
      })),
    }
  })

// Note: no safeStorage mock — the Electron capability host no longer uses
// Electron's keychain-backed safeStorage. Secrets are handled by the
// file-backed LibsodiumSecretStore (writes a lockbox under userDataDir).
vi.mock('electron', () => ({
  Notification: MockNotification,
  app: {
    getPath: vi.fn((_name: string) => tmpdir()),
    getVersion: vi.fn(() => '2.0.0'),
  },
}))

vi.mock('@core/ffmpeg/ffmpeg-locator', () => ({
  locateFfmpeg: mockLocateFfmpeg,
}))

// The eager detector remains mocked as a regression sentinel: capability-host
// construction must never invoke it because it executes `ffmpeg -version`.
vi.mock('./ffmpeg-detect-electron', () => ({
  makeElectronFfmpegDetect: mockVersionDetectorFactory,
  resolveElectronFfmpegEnvPath: vi.fn(() => null),
}))

// ---------------------------------------------------------------------------
// Import under test (after mocks are registered)
// ---------------------------------------------------------------------------

import BetterSqlite3 from 'better-sqlite3'
import { FsStorageCapabilityHost } from '../../core/plugin/capabilities/fs-storage'
import { HttpCapabilityHost } from '../../core/plugin/capabilities/http'
import { CookieJar } from '../../core/plugin/capabilities/http-cookies'
import type { SettingsManager } from '../../core/settings/settings-manager'
import { createElectronCapabilityHost } from './capability-host'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeDb(): BetterSqlite3.Database {
  return new BetterSqlite3(':memory:')
}

function makeSettingsManager(): SettingsManager {
  // Wrapper only reaches .get().media.ffmpegBinaryPath; structural fake.
  const fake = {
    get: () => ({
      media: {
        ffmpegBinaryPath: '',
        ffmpegStagingMB: 4096,
        ffmpegOpTimeoutSec: 1800,
      },
    }),
  }
  return fake as unknown as SettingsManager
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('createElectronCapabilityHost', () => {
  let db: BetterSqlite3.Database

  beforeEach(() => {
    db = makeDb()
    MockNotification.isSupported.mockClear()
    mockLocateFfmpeg.mockClear()
    mockVersionDetectorFactory.mockClear()
  })

  afterEach(() => {
    db.close()
  })

  it('returns a CapabilityHost with http as HttpCapabilityHost', async () => {
    const host = await createElectronCapabilityHost({
      appVersion: '2.0.0',
      hostLanguage: 'en-US',
      db,
      userDataDir: tmpdir(),
      pluginsDir: path.join(tmpdir(), 'plugins'),
      settingsManager: makeSettingsManager(),
      configReader: () => ({}),
      secretFieldsFor: () => new Set(),
      manifestCommandIdsFor: () => new Set(),
    })

    expect(host.http).toBeInstanceOf(HttpCapabilityHost)
  })

  it('does not initialize native notification support while wiring capabilities', async () => {
    await createElectronCapabilityHost({
      appVersion: '2.0.0',
      hostLanguage: 'en-US',
      db,
      userDataDir: tmpdir(),
      pluginsDir: path.join(tmpdir(), 'plugins'),
      settingsManager: makeSettingsManager(),
      configReader: () => ({}),
      secretFieldsFor: () => new Set(),
      manifestCommandIdsFor: () => new Set(),
    })

    expect(MockNotification.isSupported).not.toHaveBeenCalled()
  })

  it('locates FFmpeg without running the version detector at startup', async () => {
    mockLocateFfmpeg.mockResolvedValueOnce({
      available: true,
      binaryPath: '/user-data/binaries/ffmpeg',
      version: null,
    })

    const host = await createElectronCapabilityHost({
      appVersion: '2.0.0',
      hostLanguage: 'en-US',
      db,
      userDataDir: '/user-data',
      pluginsDir: path.join(tmpdir(), 'plugins'),
      settingsManager: makeSettingsManager(),
      configReader: () => ({}),
      secretFieldsFor: () => new Set(),
      manifestCommandIdsFor: () => new Set(),
    })

    expect(mockLocateFfmpeg).toHaveBeenCalledOnce()
    expect(mockVersionDetectorFactory).not.toHaveBeenCalled()
    expect(host.ffmpeg.available).toBe(true)
    expect(host.ffmpeg.version).toBeUndefined()
  })

  it('returns a CapabilityHost with a functional storage host', async () => {
    const host = await createElectronCapabilityHost({
      appVersion: '2.0.0',
      hostLanguage: 'en-US',
      db,
      userDataDir: tmpdir(),
      pluginsDir: path.join(tmpdir(), 'plugins'),
      settingsManager: makeSettingsManager(),
      configReader: () => ({}),
      secretFieldsFor: () => new Set(),
      manifestCommandIdsFor: () => new Set(),
    })

    expect(host.storage).toBeDefined()
  })

  it('crypto.randomBytes(8) returns 8-byte Uint8Array', async () => {
    const host = await createElectronCapabilityHost({
      appVersion: '2.0.0',
      hostLanguage: 'en-US',
      db,
      userDataDir: tmpdir(),
      pluginsDir: path.join(tmpdir(), 'plugins'),
      settingsManager: makeSettingsManager(),
      configReader: () => ({}),
      secretFieldsFor: () => new Set(),
      manifestCommandIdsFor: () => new Set(),
    })

    const bytes = host.crypto.randomBytes(8)
    expect(bytes).toBeInstanceOf(Uint8Array)
    expect(bytes.byteLength).toBe(8)
  })

  it('fsStorageFor("a") returns a FsStorageCapabilityHost', async () => {
    const host = await createElectronCapabilityHost({
      appVersion: '2.0.0',
      hostLanguage: 'en-US',
      db,
      userDataDir: tmpdir(),
      pluginsDir: path.join(tmpdir(), 'plugins'),
      settingsManager: makeSettingsManager(),
      configReader: () => ({}),
      secretFieldsFor: () => new Set(),
      manifestCommandIdsFor: () => new Set(),
    })

    const fsStorage = host.fsStorageFor('a')
    expect(fsStorage).toBeInstanceOf(FsStorageCapabilityHost)
  })

  it('cookieJarFor("a") returns a CookieJar', async () => {
    const host = await createElectronCapabilityHost({
      appVersion: '2.0.0',
      hostLanguage: 'en-US',
      db,
      userDataDir: tmpdir(),
      pluginsDir: path.join(tmpdir(), 'plugins'),
      settingsManager: makeSettingsManager(),
      configReader: () => ({}),
      secretFieldsFor: () => new Set(),
      manifestCommandIdsFor: () => new Set(),
    })

    const jar = host.cookieJarFor('a')
    expect(jar).toBeInstanceOf(CookieJar)
  })

  it('all Plan A surfaces remain intact', async () => {
    const host = await createElectronCapabilityHost({
      appVersion: '2.0.0',
      hostLanguage: 'en-US',
      db,
      userDataDir: tmpdir(),
      pluginsDir: path.join(tmpdir(), 'plugins'),
      settingsManager: makeSettingsManager(),
      configReader: () => ({}),
      secretFieldsFor: () => new Set(),
      manifestCommandIdsFor: () => new Set(),
    })

    expect(typeof host.createLog).toBe('function')
    expect(typeof host.getTail).toBe('function')
    expect(typeof host.appSnapshot).toBe('function')
    expect(typeof host.i18nSnapshot).toBe('function')
    expect(typeof host.setLocale).toBe('function')
    expect(typeof host.onLocaleChange).toBe('function')
    expect(typeof host.flush).toBe('function')
  })

  it('keeps app and plugin i18n snapshots on the live locale', async () => {
    const host = await createElectronCapabilityHost({
      appVersion: '2.0.0',
      hostLanguage: 'en-US',
      db,
      userDataDir: tmpdir(),
      pluginsDir: path.join(tmpdir(), 'plugins'),
      settingsManager: makeSettingsManager(),
      configReader: () => ({}),
      secretFieldsFor: () => new Set(),
      manifestCommandIdsFor: () => new Set(),
      localeSnapshotFor: () => ({
        currentDict: { greeting: '你好' },
        fallbackDict: { greeting: 'Hello' },
      }),
    })
    const changed = vi.fn()
    const unsubscribe = host.onLocaleChange(changed)

    host.setLocale('zh-CN')

    expect(changed).toHaveBeenCalledWith('zh-CN')
    expect(host.appSnapshot()).toMatchObject({
      runtime: 'electron',
      platform: process.platform,
      arch: process.arch,
      locale: 'zh-CN',
    })
    expect(host.i18nSnapshot('alice.demo')).toEqual({
      language: 'zh-CN',
      dir: 'ltr',
      currentDict: { greeting: '你好' },
      fallbackDict: { greeting: 'Hello' },
    })
    unsubscribe()
  })
})
