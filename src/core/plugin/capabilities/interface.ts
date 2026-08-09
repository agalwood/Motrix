// src/core/plugin/capabilities/interface.ts

import type { SupportedLocale } from '@shared/constants/locales'
import type { PluginLogEntry } from '@shared/types/plugin'
import type { ManifestLocaleDict } from '../manifest/i18n-resolve'
import type { CommandsCapabilityHost } from './commands'
import type { ConfigCapabilityHost } from './config'
import type { CryptoCapabilityHost } from './crypto'
import type { FfmpegCapabilityHost } from './ffmpeg'
import type { FsStorageCapabilityHost } from './fs-storage'
import type { FsTaskCapabilityHost } from './fs-task'
import type { HttpCapabilityHost } from './http'
import type { CookieJar } from './http-cookies'
import type { LifecycleCapabilityHost } from './lifecycle'
import type { MetadataCapabilityHost } from './metadata'
import type { NotifyCapabilityHost } from './notify'
import type { SecretStore } from './secret-store'
import type { StorageCapabilityHost } from './storage'

// `LogEntry` is the wire shape of a single log entry. The canonical type
// lives in @shared/types/plugin so the renderer can type IPC payloads
// without importing from @core/.
export type LogEntry = PluginLogEntry

export type LogStreamListener = (pluginId: string, entry: LogEntry) => void

export interface PluginLogCapability {
  trace(msg: string, fields?: Record<string, unknown>): void
  debug(msg: string, fields?: Record<string, unknown>): void
  info(msg: string, fields?: Record<string, unknown>): void
  warn(msg: string, fields?: Record<string, unknown>): void
  error(msg: string, fields?: Record<string, unknown>): void
  fatal(msg: string, fields?: Record<string, unknown>): void
}

export interface AppCapabilitySnapshot {
  version: string
  platform: 'darwin' | 'win32' | 'linux'
  runtime: 'electron' | 'server'
  locale: string
  arch: 'x64' | 'arm64'
}

export interface I18nSnapshot {
  language: string
  dir: 'ltr' | 'rtl'
  currentDict: ManifestLocaleDict
  fallbackDict: ManifestLocaleDict
}

// Aggregated host capability surface. Plan A members + Plan B additions.
export interface CapabilityHost {
  // ── Plan A ────────────────────────────────────────────────────────────────
  createLog(pluginId: string): PluginLogCapability
  getTail(pluginId: string, limit: number): LogEntry[]
  clearLog(pluginId: string): void
  setLogVerbose(pluginId: string, verbose: boolean): void
  isLogVerbose(pluginId: string): boolean
  subscribeLog(listener: LogStreamListener): () => void
  appSnapshot(): AppCapabilitySnapshot
  i18nSnapshot(pluginId: string): I18nSnapshot
  setLocale(locale: SupportedLocale): void
  onLocaleChange(handler: (lang: string) => void): () => void
  flush(): Promise<void>

  // ── Plan B ────────────────────────────────────────────────────────────────
  /** Shared outbound HTTP host (jar injected per-request by the bridge). */
  http: HttpCapabilityHost
  /** Factory: returns a per-(saveDir, filePath) fs.task host. */
  fsTaskFor(saveDir: string, filePath: string): FsTaskCapabilityHost
  /** Factory: returns a per-plugin fs.storage host rooted at pluginsDir/<pluginId>/storage/. */
  fsStorageFor(pluginId: string): FsStorageCapabilityHost
  /** Shared SQLite-backed key-value store (dispatched per-plugin by bridge). */
  storage: StorageCapabilityHost
  /** Shared SQLite-backed per-task metadata store (dispatched per-plugin by bridge). */
  metadata: MetadataCapabilityHost
  /** Stateless crypto primitives (hash, hmac, randomBytes, aes). */
  crypto: CryptoCapabilityHost
  /** Factory: returns a per-plugin config resolver. */
  configFor(pluginId: string): ConfigCapabilityHost
  /** Shared deactivate handler registry. */
  lifecycle: LifecycleCapabilityHost
  /** Shared command registry + dispatcher. */
  commands: CommandsCapabilityHost
  /** Desktop notification surface (unavailable on server). */
  notify: NotifyCapabilityHost
  /** ffmpeg run + probe host (uses detected binary or unavailable). */
  ffmpeg: FfmpegCapabilityHost
  /** Secret encrypt/decrypt store (file-backed libsodium on both shells). */
  secrets: SecretStore
  /** Factory: returns a per-plugin cookie jar backed by SQLite. */
  cookieJarFor(pluginId: string): CookieJar
}
