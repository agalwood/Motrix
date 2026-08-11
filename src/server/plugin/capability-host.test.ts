// Tests for createServerCapabilityHost.
//
// Verifies that the factory constructs and returns the full CapabilityHost
// surface with all Plan B capabilities wired. Does NOT exercise behavioral
// correctness — Tasks 4-17 cover that. This test only checks wiring.

import { mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// ---------------------------------------------------------------------------
// Mock ffmpeg-detect-server to avoid spawning a real process.
// ---------------------------------------------------------------------------

vi.mock('./ffmpeg-detect-server', () => ({
  makeServerFfmpegDetect: vi.fn(() => async () => ({
    active: null,
    candidates: [],
  })),
}))

// ---------------------------------------------------------------------------
// Import under test (after mocks are registered)
// ---------------------------------------------------------------------------

import BetterSqlite3 from 'better-sqlite3'
import { FsStorageCapabilityHost } from '../../core/plugin/capabilities/fs-storage'
import { HttpCapabilityHost } from '../../core/plugin/capabilities/http'
import { CookieJar } from '../../core/plugin/capabilities/http-cookies'
import type { SettingsManager } from '../../core/settings/settings-manager'
import { createServerCapabilityHost } from './capability-host'

function makeSettingsManager(): SettingsManager {
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
// Helpers
// ---------------------------------------------------------------------------

const TEST_SEED = 'a'.repeat(64) // 64 hex chars = 32 bytes

function makeDb(): BetterSqlite3.Database {
  return new BetterSqlite3(':memory:')
}

function makeTmpDir(): string {
  const dir = path.join(
    tmpdir(),
    `motrix-cap-host-server-test-${Date.now()}-${Math.random().toString(36).slice(2)}`
  )
  mkdirSync(dir, { recursive: true })
  return dir
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('createServerCapabilityHost', () => {
  let db: BetterSqlite3.Database
  let userDataDir: string
  let pluginsDir: string

  beforeEach(() => {
    db = makeDb()
    userDataDir = makeTmpDir()
    pluginsDir = makeTmpDir()
    // Inject a deterministic seed so LibsodiumSecretStore initializes without
    // reading/writing the lockbox file.
    process.env.MOTRIX_SECRETS_SEED = TEST_SEED
  })

  afterEach(() => {
    db.close()
    rmSync(userDataDir, { recursive: true, force: true })
    rmSync(pluginsDir, { recursive: true, force: true })
    delete process.env.MOTRIX_SECRETS_SEED
  })

  it('returns a CapabilityHost with http as HttpCapabilityHost', async () => {
    const host = await createServerCapabilityHost({
      appVersion: '2.0.0',
      hostLanguage: 'en-US',
      db,
      userDataDir,
      pluginsDir,
      settingsManager: makeSettingsManager(),
      configReader: () => ({}),
      secretFieldsFor: () => new Set(),
      manifestCommandIdsFor: () => new Set(),
    })

    expect(host.http).toBeInstanceOf(HttpCapabilityHost)
  })

  it('notify.available is false (server runtime)', async () => {
    const host = await createServerCapabilityHost({
      appVersion: '2.0.0',
      hostLanguage: 'en-US',
      db,
      userDataDir,
      pluginsDir,
      settingsManager: makeSettingsManager(),
      configReader: () => ({}),
      secretFieldsFor: () => new Set(),
      manifestCommandIdsFor: () => new Set(),
    })

    expect(host.notify.available).toBe(false)
  })

  it('secrets.available() is true when MOTRIX_SECRETS_SEED is set', async () => {
    const host = await createServerCapabilityHost({
      appVersion: '2.0.0',
      hostLanguage: 'en-US',
      db,
      userDataDir,
      pluginsDir,
      settingsManager: makeSettingsManager(),
      configReader: () => ({}),
      secretFieldsFor: () => new Set(),
      manifestCommandIdsFor: () => new Set(),
    })

    expect(host.secrets.available()).toBe(true)
  })

  it('fsStorageFor("a") returns a FsStorageCapabilityHost', async () => {
    const host = await createServerCapabilityHost({
      appVersion: '2.0.0',
      hostLanguage: 'en-US',
      db,
      userDataDir,
      pluginsDir,
      settingsManager: makeSettingsManager(),
      configReader: () => ({}),
      secretFieldsFor: () => new Set(),
      manifestCommandIdsFor: () => new Set(),
    })

    expect(host.fsStorageFor('a')).toBeInstanceOf(FsStorageCapabilityHost)
  })

  it('cookieJarFor("a") returns a CookieJar', async () => {
    const host = await createServerCapabilityHost({
      appVersion: '2.0.0',
      hostLanguage: 'en-US',
      db,
      userDataDir,
      pluginsDir,
      settingsManager: makeSettingsManager(),
      configReader: () => ({}),
      secretFieldsFor: () => new Set(),
      manifestCommandIdsFor: () => new Set(),
    })

    expect(host.cookieJarFor('a')).toBeInstanceOf(CookieJar)
  })

  it('all Plan A surfaces remain intact', async () => {
    const host = await createServerCapabilityHost({
      appVersion: '2.0.0',
      hostLanguage: 'en-US',
      db,
      userDataDir,
      pluginsDir,
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
    const host = await createServerCapabilityHost({
      appVersion: '2.0.0',
      hostLanguage: 'en-US',
      db,
      userDataDir,
      pluginsDir,
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
      runtime: 'server',
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
