import path from 'node:path'
import { AppCapabilityHost } from '@core/plugin/capabilities/app'
import { CommandsCapabilityHost } from '@core/plugin/capabilities/commands'
import { ConfigCapabilityHost } from '@core/plugin/capabilities/config'
import { CryptoCapabilityHost } from '@core/plugin/capabilities/crypto'
import { FfmpegCapabilityHost } from '@core/plugin/capabilities/ffmpeg'
import { projectActiveToLegacy } from '@core/plugin/capabilities/ffmpeg-detect'
import { FsStorageCapabilityHost } from '@core/plugin/capabilities/fs-storage'
import { FsTaskCapabilityHost } from '@core/plugin/capabilities/fs-task'
import { HttpCapabilityHost } from '@core/plugin/capabilities/http'
import {
  CookieJar,
  ensureCookieJarSchema,
} from '@core/plugin/capabilities/http-cookies'
import { I18nCapabilityHost } from '@core/plugin/capabilities/i18n'
import type { CapabilityHost } from '@core/plugin/capabilities/interface'
import { LifecycleCapabilityHost } from '@core/plugin/capabilities/lifecycle'
import { LogCapabilityHost } from '@core/plugin/capabilities/log'
import {
  ensureMetadataSchema,
  MetadataCapabilityHost,
} from '@core/plugin/capabilities/metadata'
import {
  ensureStorageSchema,
  StorageCapabilityHost,
} from '@core/plugin/capabilities/storage'
import { LibsodiumSecretStore } from '@core/plugin/secret-store-libsodium'
import type { SettingsManager } from '@core/settings/settings-manager'
import type { SupportedLocale } from '@shared/constants/locales'
import type Database from 'better-sqlite3'
import { makeServerFfmpegDetect } from './ffmpeg-detect-server'
import { UnavailableNotifyHost } from './notify-stub'

export interface ServerCapabilityHostOptions {
  appVersion: string
  hostLanguage: SupportedLocale
  db: Database.Database
  /** Used by LibsodiumSecretStore to locate / create the secrets.lockbox file. */
  userDataDir: string
  /** Root dir for per-plugin logs, storage, etc. */
  pluginsDir: string
  /**
   * Provides live MediaSettings (read on every ffmpeg detect) plus any other
   * settings the capability host needs going forward.
   */
  settingsManager: SettingsManager
  /** Provides stored config values for a plugin. */
  configReader: (pluginId: string) => Record<string, unknown>
  /** Returns the set of secret field keys declared in a plugin's manifest. */
  secretFieldsFor: (pluginId: string) => ReadonlySet<string>
  /**
   * Returns the set of command IDs declared in a plugin's
   * `contributes.commands[]`. Used by CommandsCapabilityHost to enforce
   * spec §5 L1741-1746 manifest-declaration check on register().
   */
  manifestCommandIdsFor: (pluginId: string) => ReadonlySet<string>
  /** Dictionaries cached by PluginRegistry for the active + fallback locale. */
  localeSnapshotFor?: (pluginId: string) => {
    currentDict: Record<string, string>
    fallbackDict: Record<string, string>
  }
}

export async function createServerCapabilityHost(
  opts: ServerCapabilityHostOptions
): Promise<CapabilityHost> {
  // ── Plan A pieces ─────────────────────────────────────────────────────────
  const log = new LogCapabilityHost({
    pluginLogsDir: path.join(opts.pluginsDir, '_logs'),
  })
  const appCap = new AppCapabilityHost({
    appVersion: opts.appVersion,
    platform: process.platform as 'darwin' | 'win32' | 'linux',
    runtime: 'server',
    locale: opts.hostLanguage,
    arch: process.arch as 'x64' | 'arm64',
  })
  const i18nCap = new I18nCapabilityHost({ hostLanguage: opts.hostLanguage })

  // ── Plan B schema bootstrap ───────────────────────────────────────────────
  ensureStorageSchema(opts.db)
  ensureMetadataSchema(opts.db)
  ensureCookieJarSchema(opts.db)

  // ── Plan B capability instances ───────────────────────────────────────────
  const crypto = new CryptoCapabilityHost()
  const storage = new StorageCapabilityHost({ db: opts.db })
  const metadata = new MetadataCapabilityHost({ db: opts.db })
  const lifecycle = new LifecycleCapabilityHost()
  const commandsCap = new CommandsCapabilityHost({
    manifestCommandIds: opts.manifestCommandIdsFor,
    // Spec §5 L1800: self-invocations go to the plugin's own pino log, NOT
    // to the cross-plugin audit NDJSON.
    onSelfInvoke: (event) => {
      const logger = log.create(event.callerId)
      logger.debug('plugin self-invoke', {
        type: 'self-invoke',
        commandId: event.commandId,
        durMs: event.durMs,
        ok: event.ok,
        ...(event.errorCode ? { errorCode: event.errorCode } : {}),
      })
    },
  })
  const notify = new UnavailableNotifyHost()
  // secrets: prefer env seed, fall back to lockbox file, else FailingSecretStore
  const secrets = await LibsodiumSecretStore.create({
    userDataDir: opts.userDataDir,
    envSeed: process.env.MOTRIX_SECRETS_SEED,
  })
  const detectFfmpeg = makeServerFfmpegDetect({
    settingsManager: opts.settingsManager,
    userDataDir: opts.userDataDir,
  })
  const ffmpegResult = await detectFfmpeg()
  const ffmpegDetection = projectActiveToLegacy(ffmpegResult)
  const ffmpeg = new FfmpegCapabilityHost({ detect: ffmpegDetection })
  const http = new HttpCapabilityHost() // per-plugin jar injected by Task 19 bridge

  return {
    // ── Plan A ──────────────────────────────────────────────────────────────
    createLog: (id) => log.create(id),
    getTail: (id, n) => log.getTail(id, n),
    clearLog: (id) => log.clear(id),
    setLogVerbose: (id, v) => log.setVerbose(id, v),
    isLogVerbose: (id) => log.isVerbose(id),
    subscribeLog: (listener) => log.subscribe(listener),
    appSnapshot: () => ({
      ...appCap.snapshot(),
      locale: i18nCap.language,
    }),
    i18nSnapshot: (pluginId) => ({
      language: i18nCap.language,
      dir: i18nCap.direction,
      ...(opts.localeSnapshotFor?.(pluginId) ?? {
        currentDict: {},
        fallbackDict: {},
      }),
    }),
    setLocale: (locale) => i18nCap.setLanguage(locale),
    onLocaleChange: (h) => i18nCap.onChange(h),
    flush: () => log.flush(),

    // ── Plan B ──────────────────────────────────────────────────────────────
    http,
    fsTaskFor: (saveDir, filePath) =>
      new FsTaskCapabilityHost({ saveDir, filePath }),
    fsStorageFor: (pluginId) =>
      new FsStorageCapabilityHost({
        pluginStorageRoot: path.join(opts.pluginsDir, pluginId, 'storage'),
      }),
    storage,
    metadata,
    crypto,
    configFor: (pluginId) =>
      new ConfigCapabilityHost({
        pluginId,
        readValues: () => opts.configReader(pluginId),
        schemaDefaults: {}, // Plan F populates from manifest contributes.configuration
        secretFields: opts.secretFieldsFor(pluginId),
        decryptSecret: async (cipher) => secrets.decrypt(cipher),
      }),
    lifecycle,
    commands: commandsCap,
    notify,
    ffmpeg,
    secrets,
    cookieJarFor: (pluginId) => new CookieJar(opts.db, pluginId),
  }
}
