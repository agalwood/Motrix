import { describe, expect, it } from 'vitest'
import { CURRENT_SETTINGS_VERSION, migrate } from './migrations'
import { DEFAULT_MEDIA_SETTINGS } from './validators'

describe('migrate', () => {
  it('returns input unchanged when already at current version', () => {
    const input = { version: CURRENT_SETTINGS_VERSION, engine: {}, app: {} }
    const result = migrate(input)
    expect(result).toEqual(input)
  })

  it('adds version field when missing', () => {
    const input = { engine: {}, app: {} }
    const result = migrate(input as Record<string, unknown>)
    expect(result.version).toBe(CURRENT_SETTINGS_VERSION)
  })

  it('migrates from v0 (legacy format with general/download)', () => {
    const legacy = {
      general: {
        launchAtStartup: true,
        restoreOnCrash: true,
      },
      download: {
        defaultSaveDir: '/tmp/downloads',
        maxConcurrentTasks: 8,
        maxDownloadSpeed: 1000,
        maxUploadSpeed: 500,
      },
      plugins: {},
    }
    const result = migrate(legacy as Record<string, unknown>)
    const app = result.app as Record<string, unknown>
    const engine = result.engine as Record<string, unknown>
    expect(result.version).toBe(CURRENT_SETTINGS_VERSION)
    expect(app.launchAtStartup).toBe(true)
    expect(app.defaultSaveDir).toBe('/tmp/downloads')
    expect(engine.maxConcurrentDownloads).toBe(8)
    // v6→v7 strips these from engine and moves them to speedLimit.base
    expect(engine.maxOverallDownloadLimit).toBeUndefined()
    expect(engine.maxOverallUploadLimit).toBeUndefined()
    const speedLimit = result.speedLimit as Record<string, unknown>
    const base = speedLimit.base as Record<string, unknown>
    expect(base.download).toBe(1000)
    expect(base.upload).toBe(500)
    expect(result.plugins).toEqual({})
  })

  it('preserves plugins through migration', () => {
    const legacy = {
      general: { launchAtStartup: false, restoreOnCrash: true },
      download: {
        defaultSaveDir: '',
        maxConcurrentTasks: 5,
        maxDownloadSpeed: 0,
        maxUploadSpeed: 0,
      },
      plugins: { 'my-plugin': { enabled: true, order: 0, config: {} } },
    }
    const result = migrate(legacy as Record<string, unknown>)
    expect(result.plugins).toEqual({
      'my-plugin': { enabled: true, order: 0, config: {} },
    })
  })

  it('handles completely empty object', () => {
    const result = migrate({})
    expect(result.version).toBe(CURRENT_SETTINGS_VERSION)
    expect(result.engine).toBeUndefined()
    expect(result.app).toBeUndefined()
  })

  it('migrates from v1 to v2 (adds protocols)', () => {
    const v1Data = {
      version: 1,
      engine: { rpcPort: 16800 },
      app: { launchAtStartup: true, theme: 'dark' },
      plugins: {},
    }
    const result = migrate(v1Data as Record<string, unknown>)
    expect(result.version).toBe(CURRENT_SETTINGS_VERSION)
    const app = result.app as Record<string, unknown>
    expect(app.protocols).toEqual({ magnet: true })
    expect(app.launchAtStartup).toBe(true)
    expect(app.theme).toBe('dark')
  })
})

describe('migration v3 → v4', () => {
  it('targets version 10', () => {
    expect(CURRENT_SETTINGS_VERSION).toBe(10)
  })

  it('adds dhtListenPort defaulting to listenPort value', () => {
    const v3 = {
      version: 3,
      engine: { listenPort: 51413, rpcPort: 16800 },
      app: {},
      plugins: {},
    }
    const result = migrate(v3)
    expect(result.version).toBe(CURRENT_SETTINGS_VERSION)
    const engine = result.engine as Record<string, unknown>
    expect(engine.dhtListenPort).toBe(51413)
  })

  it('adds empty nat namespace', () => {
    const v3 = {
      version: 3,
      engine: { listenPort: 6881 },
      app: {},
      plugins: {},
    }
    const v4 = migrate(v3)
    expect(v4.nat).toEqual({})
  })

  it('preserves existing nat namespace if user pre-set values', () => {
    const v3 = {
      version: 3,
      engine: { listenPort: 6881 },
      app: {},
      nat: { enabled: false },
      plugins: {},
    }
    const v4 = migrate(v3)
    expect((v4.nat as Record<string, unknown>).enabled).toBe(false)
  })
})

describe('migration v4 → v5 (sqlite3 persistence)', () => {
  it('populates default sqlite3 fields on legacy settings without them', () => {
    const legacy = {
      version: 4,
      engine: {
        rpcPort: 16800,
        rpcSecret: 'motrix-secret',
        listenPort: 6881,
        dhtListenPort: 6881,
      },
      app: {},
      nat: {},
      plugins: {},
    }
    const migrated = migrate(legacy)
    const engine = migrated.engine as Record<string, unknown>
    expect(migrated.version).toBe(CURRENT_SETTINGS_VERSION)
    expect(engine.sqlite3Persistence).toBe(true)
    expect(engine.sqlite3DbPath).toBe('')
    expect(engine.sqlite3HistoryLimit).toBe(-1)
  })

  it('preserves existing sqlite3 fields if already present', () => {
    const legacy = {
      version: 4,
      engine: {
        rpcPort: 16800,
        sqlite3Persistence: false,
        sqlite3DbPath: '/var/lib/motrix/aria2.db',
        sqlite3HistoryLimit: 1000,
      },
      app: {},
      nat: {},
      plugins: {},
    }
    const migrated = migrate(legacy)
    const engine = migrated.engine as Record<string, unknown>
    expect(engine.sqlite3Persistence).toBe(false)
    expect(engine.sqlite3DbPath).toBe('/var/lib/motrix/aria2.db')
    expect(engine.sqlite3HistoryLimit).toBe(1000)
  })
})

describe('migration v5 → v6 (media namespace)', () => {
  it('migrates v5 → v6 by injecting media defaults', () => {
    const v5 = { version: 5, engine: {}, app: {} }
    const out = migrate(v5)
    expect(out.version).toBe(CURRENT_SETTINGS_VERSION)
    expect(out.media).toEqual(DEFAULT_MEDIA_SETTINGS)
  })

  it('preserves user-provided media on migration', () => {
    const v5WithMedia = {
      version: 5,
      media: {
        ffmpegBinaryPath: '/u/ffmpeg',
        ffmpegStagingMB: 2048,
        ffmpegOpTimeoutSec: 600,
      },
    }
    const out = migrate(v5WithMedia) as Record<string, unknown>
    expect(out.media).toEqual({
      ffmpegBinaryPath: '/u/ffmpeg',
      ffmpegStagingMB: 2048,
      ffmpegOpTimeoutSec: 600,
    })
  })
})

describe('migration v6 → v7 (speedLimit namespace)', () => {
  it('targets version 10', () => {
    expect(CURRENT_SETTINGS_VERSION).toBe(10)
  })

  it('v6→v7: maps a configured limit to base, turtle off', () => {
    const result = migrate({
      version: 6,
      engine: {
        maxOverallDownloadLimit: 1024000,
        maxOverallUploadLimit: 256000,
      },
    })
    expect(result.version).toBe(CURRENT_SETTINGS_VERSION)
    expect(
      (result.engine as Record<string, unknown>).maxOverallDownloadLimit
    ).toBeUndefined()
    expect(
      (result.engine as Record<string, unknown>).maxOverallUploadLimit
    ).toBeUndefined()
    expect(result.speedLimit).toMatchObject({
      turtle: 'off',
      base: { download: 1024000, upload: 256000 },
      alt: { download: 512 * 1024, upload: 64 * 1024 },
    })
  })

  it('v6→v7: only download limit set → base download, upload zero', () => {
    const result = migrate({
      version: 6,
      engine: { maxOverallDownloadLimit: 512000 },
    })
    expect(result.speedLimit).toMatchObject({
      turtle: 'off',
      base: { download: 512000, upload: 0 },
    })
  })

  it('v6→v7: only upload limit set → base upload, download zero', () => {
    const result = migrate({
      version: 6,
      engine: { maxOverallUploadLimit: 128000 },
    })
    expect(result.speedLimit).toMatchObject({
      turtle: 'off',
      base: { download: 0, upload: 128000 },
    })
  })

  it('v6→v7: no prior limit → base 0/0, turtle off', () => {
    const result = migrate({ version: 6, engine: {} })
    expect(result.speedLimit).toMatchObject({
      turtle: 'off',
      base: { download: 0, upload: 0 },
    })
  })
})

describe('migration v7 → v8 (application update channel)', () => {
  it('defaults existing users to stable', () => {
    const result = migrate({ version: 7, app: { theme: 'dark' } })

    expect(result.version).toBe(CURRENT_SETTINGS_VERSION)
    expect(result.app).toEqual({ theme: 'dark', updateChannel: 'stable' })
  })

  it.each(['stable', 'beta'] as const)(
    'preserves an already valid %s channel',
    (updateChannel) => {
      const result = migrate({ version: 7, app: { updateChannel } })

      expect(result.app).toEqual({ updateChannel })
    }
  )

  it('repairs an invalid persisted channel to stable', () => {
    const result = migrate({ version: 7, app: { updateChannel: 'alpha' } })

    expect(result.app).toEqual({ updateChannel: 'stable' })
  })
})

describe('migration v8 → v9 (performance profiles)', () => {
  it('moves the previous defaults to the automatic profile', () => {
    const result = migrate({
      version: 8,
      engine: {
        maxConnectionPerServer: 16,
        split: 16,
        minSplitSize: 10 * 1024 * 1024,
        diskCache: 64 * 1024 * 1024,
      },
    })

    expect(result.version).toBe(CURRENT_SETTINGS_VERSION)
    expect(result.engine).toMatchObject({ performanceProfile: 'auto' })
  })

  it('preserves tuned values through the custom profile', () => {
    const result = migrate({
      version: 8,
      engine: {
        maxConnectionPerServer: 24,
        split: 12,
        minSplitSize: 2 * 1024 * 1024,
        diskCache: 48 * 1024 * 1024,
      },
    })

    expect(result.engine).toMatchObject({
      performanceProfile: 'custom',
      maxConnectionPerServer: 24,
      split: 12,
      minSplitSize: 2 * 1024 * 1024,
      diskCache: 48 * 1024 * 1024,
    })
  })
})

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

describe('migration v9 → v10 (bridge fixed port and instance id)', () => {
  it('seeds fixedPort auto and a UUID instanceId for a plain v9 document', () => {
    const result = migrate({ version: 9, app: { theme: 'dark' } })

    expect(result.version).toBe(CURRENT_SETTINGS_VERSION)
    const bridge = result.bridge as Record<string, unknown>
    expect(bridge.fixedPort).toBe('auto')
    expect(bridge.instanceId).toEqual(expect.stringMatching(UUID_PATTERN))
  })

  it('preserves an existing bridge object instead of clobbering it', () => {
    const result = migrate({
      version: 9,
      bridge: { fixedPort: 16803, instanceId: 'already-set-id' },
    })

    expect(result.bridge).toEqual({
      fixedPort: 16803,
      instanceId: 'already-set-id',
    })
  })

  it('mints a fresh instanceId only when one is not already present', () => {
    const result = migrate({ version: 9, bridge: { fixedPort: 16803 } })

    expect((result.bridge as Record<string, unknown>).fixedPort).toBe(16803)
    expect((result.bridge as Record<string, unknown>).instanceId).toEqual(
      expect.stringMatching(UUID_PATTERN)
    )
  })

  it('never regenerates instanceId once the document is already at v10', () => {
    const migratedOnce = migrate({ version: 9 })
    const instanceId = (migratedOnce.bridge as Record<string, unknown>)
      .instanceId
    // Pins that seeding actually minted an id: without this, a migration that
    // returned a bridge object with no instanceId would satisfy the equality
    // below vacuously (undefined === undefined).
    expect(instanceId).toEqual(expect.stringMatching(UUID_PATTERN))

    // migrate() short-circuits at version === CURRENT_SETTINGS_VERSION
    // (migrations.ts), so a v10 document never re-enters migrateV9ToV10.
    const migratedTwice = migrate(migratedOnce)

    expect((migratedTwice.bridge as Record<string, unknown>).instanceId).toBe(
      instanceId
    )
  })
})
