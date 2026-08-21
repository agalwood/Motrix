import { randomUUID } from 'node:crypto'

export const CURRENT_SETTINGS_VERSION = 10

interface Migration {
  version: number
  migrate: (data: Record<string, unknown>) => Record<string, unknown>
}

function migrateV0ToV1(data: Record<string, unknown>): Record<string, unknown> {
  const general = (data.general ?? {}) as Record<string, unknown>
  const download = (data.download ?? {}) as Record<string, unknown>

  return {
    version: 1,
    engine: {
      maxConcurrentDownloads: download.maxConcurrentTasks ?? undefined,
      maxOverallDownloadLimit: download.maxDownloadSpeed ?? undefined,
      maxOverallUploadLimit: download.maxUploadSpeed ?? undefined,
    },
    app: {
      launchAtStartup: general.launchAtStartup ?? undefined,
      defaultSaveDir: download.defaultSaveDir ?? undefined,
    },
    plugins: data.plugins ?? {},
  }
}

function migrateV1ToV2(data: Record<string, unknown>): Record<string, unknown> {
  const app = (data.app ?? {}) as Record<string, unknown>

  return {
    ...data,
    version: 2,
    app: {
      ...app,
      protocols: { magnet: true },
    },
  }
}

function migrateV2ToV3(data: Record<string, unknown>): Record<string, unknown> {
  const app = (data.app ?? {}) as Record<string, unknown>

  return {
    ...data,
    version: 3,
    app: {
      ...app,
      runMode: app.runMode ?? 1,
      traySpeedometer: app.traySpeedometer ?? true,
    },
  }
}

function migrateV3ToV4(data: Record<string, unknown>): Record<string, unknown> {
  const engine = (data.engine ?? {}) as Record<string, unknown>
  const listenPort =
    typeof engine.listenPort === 'number' ? engine.listenPort : 6881

  return {
    ...data,
    version: 4,
    engine: {
      ...engine,
      dhtListenPort:
        typeof engine.dhtListenPort === 'number'
          ? engine.dhtListenPort
          : listenPort,
    },
    nat: (data.nat ?? {}) as Record<string, unknown>,
  }
}

function migrateV4ToV5(data: Record<string, unknown>): Record<string, unknown> {
  const engine = (data.engine ?? {}) as Record<string, unknown>
  return {
    ...data,
    version: 5,
    engine: {
      ...engine,
      sqlite3Persistence:
        typeof engine.sqlite3Persistence === 'boolean'
          ? engine.sqlite3Persistence
          : true,
      sqlite3DbPath:
        typeof engine.sqlite3DbPath === 'string' ? engine.sqlite3DbPath : '',
      sqlite3HistoryLimit:
        typeof engine.sqlite3HistoryLimit === 'number'
          ? engine.sqlite3HistoryLimit
          : -1,
    },
  }
}

// Inlined to avoid migrations.ts depending on @shared/schemas. Values must
// match DEFAULT_MEDIA_SETTINGS in @shared/schemas/media-settings.ts.
const DEFAULT_MEDIA_SETTINGS_PLAIN = {
  ffmpegBinaryPath: '',
  ffmpegStagingMB: 4096,
  ffmpegOpTimeoutSec: 1800,
}

function migrateV5ToV6(data: Record<string, unknown>): Record<string, unknown> {
  return {
    ...data,
    version: 6,
    media: data.media ?? { ...DEFAULT_MEDIA_SETTINGS_PLAIN },
  }
}

function migrateV6ToV7(data: Record<string, unknown>): Record<string, unknown> {
  const engine = (data.engine ?? {}) as Record<string, unknown>
  const dl =
    typeof engine.maxOverallDownloadLimit === 'number'
      ? engine.maxOverallDownloadLimit
      : 0
  const ul =
    typeof engine.maxOverallUploadLimit === 'number'
      ? engine.maxOverallUploadLimit
      : 0

  const {
    maxOverallDownloadLimit: _dl,
    maxOverallUploadLimit: _ul,
    ...engineRest
  } = engine

  return {
    ...data,
    version: 7,
    engine: engineRest,
    // Two-axis speed-limit shape. A prior overall limit becomes the always-on
    // base; turtle defaults off. alt/auto seed explicit defaults so
    // buildValidSettings has real values to merge (adaptive.speedTest is
    // omitted — the schema's .catch() fills it downstream).
    speedLimit: {
      base: { download: dl, upload: ul },
      alt: { download: 512 * 1024, upload: 64 * 1024 },
      turtle: 'off',
      auto: {
        schedule: { enabled: false, from: '23:00', to: '07:00', days: [] },
        videoApp: { enabled: false, processNames: [] },
        adaptive: {
          enabled: false,
          linkDown: 0,
          linkUp: 0,
          headroomPercent: 80,
        },
      },
    },
  }
}

function migrateV7ToV8(data: Record<string, unknown>): Record<string, unknown> {
  const app = (data.app ?? {}) as Record<string, unknown>
  return {
    ...data,
    version: 8,
    app: {
      ...app,
      updateChannel:
        app.updateChannel === 'beta' || app.updateChannel === 'stable'
          ? app.updateChannel
          : 'stable',
    },
  }
}

const LEGACY_PERFORMANCE_DEFAULTS = {
  maxConnectionPerServer: 16,
  split: 16,
  minSplitSize: 10 * 1024 * 1024,
  diskCache: 64 * 1024 * 1024,
} as const

function migrateV8ToV9(data: Record<string, unknown>): Record<string, unknown> {
  const engine = (data.engine ?? {}) as Record<string, unknown>
  const performanceKeys = Object.keys(LEGACY_PERFORMANCE_DEFAULTS) as Array<
    keyof typeof LEGACY_PERFORMANCE_DEFAULTS
  >
  const hasPerformanceValues = performanceKeys.some(
    (key) => typeof engine[key] === 'number'
  )
  const matchesLegacyDefaults = performanceKeys.every(
    (key) => engine[key] === LEGACY_PERFORMANCE_DEFAULTS[key]
  )
  const existingProfile = engine.performanceProfile
  const performanceProfile =
    existingProfile === 'auto' ||
    existingProfile === 'balanced' ||
    existingProfile === 'high' ||
    existingProfile === 'maximum' ||
    existingProfile === 'custom'
      ? existingProfile
      : !hasPerformanceValues || matchesLegacyDefaults
        ? 'auto'
        : 'custom'

  return {
    ...data,
    version: 9,
    engine: {
      ...engine,
      performanceProfile,
    },
  }
}

/**
 * Seeds `bridge.fixedPort` and a stable `bridge.instanceId`.
 *
 * Numbered v10 rather than v9: `main` shipped its own v9 (the engine
 * performance profile) while this branch was in flight, and a rebase cannot
 * merge two migrations that claim the same version — the one already on the
 * trunk keeps the number.
 */
function migrateV9ToV10(
  data: Record<string, unknown>
): Record<string, unknown> {
  const bridge = (data.bridge ?? {}) as Record<string, unknown>
  const instanceId =
    typeof bridge.instanceId === 'string' && bridge.instanceId !== ''
      ? bridge.instanceId
      : randomUUID()

  return {
    ...data,
    version: 10,
    bridge: {
      fixedPort: bridge.fixedPort ?? 'auto',
      instanceId,
    },
  }
}

const migrations: Migration[] = [
  { version: 1, migrate: migrateV0ToV1 },
  { version: 2, migrate: migrateV1ToV2 },
  { version: 3, migrate: migrateV2ToV3 },
  { version: 4, migrate: migrateV3ToV4 },
  { version: 5, migrate: migrateV4ToV5 },
  { version: 6, migrate: migrateV5ToV6 },
  { version: 7, migrate: migrateV6ToV7 },
  { version: 8, migrate: migrateV7ToV8 },
  { version: 9, migrate: migrateV8ToV9 },
  { version: 10, migrate: migrateV9ToV10 },
]

export function migrate(
  data: Record<string, unknown>
): Record<string, unknown> {
  let current = { ...data }
  let version = typeof current.version === 'number' ? current.version : 0

  if (version === CURRENT_SETTINGS_VERSION) {
    return current
  }

  if (
    version === 0 &&
    current.general === undefined &&
    current.download === undefined
  ) {
    current.version = CURRENT_SETTINGS_VERSION
    return current
  }

  for (const migration of migrations) {
    if (version < migration.version) {
      current = migration.migrate(current)
      version = migration.version
    }
  }

  current.version = CURRENT_SETTINGS_VERSION
  return current
}
