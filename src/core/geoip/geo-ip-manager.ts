import { stat } from 'node:fs/promises'
import type { EventBus } from '@core/events/event-bus'
import { getLogger } from '@core/logger'
import type { SettingsManager } from '@core/settings/settings-manager'
import { AppError, ErrorCode } from '@shared/errors'
import { Events } from '@shared/protocol/events'
import type {
  CountryRef,
  GeoIPSettings,
  GeoIPStatus,
} from '@shared/types/geoip'
import { GeoIPDownloader, type ProgressListener } from './geo-ip-downloader'
import { GeoIPService } from './geo-ip-service'
import { resolveDownloadUrl } from './sources'

const log = getLogger('GeoIPManager')

const HOUR_MS = 60 * 60 * 1000
const DAY_MS = 24 * HOUR_MS
const SCHEDULER_INTERVAL_MS = HOUR_MS

export interface GeoIPManagerDeps {
  settingsManager: SettingsManager
  eventBus: EventBus
  dbPath: string
  /**
   * Override for the auto-update scheduler interval. Tests use a small
   * value with `vi.useFakeTimers()`; production passes
   * {@link SCHEDULER_INTERVAL_MS}.
   */
  schedulerIntervalMs?: number
  downloader?: GeoIPDownloader
  service?: GeoIPService
}

/**
 * Owns the GeoIP database lifecycle: opens the on-disk file at startup
 * (when present), runs an hourly scheduler that triggers downloads when
 * the configured interval elapses, and exposes synchronous lookup +
 * status surfaces for the IPC layer.
 *
 * Settings changes are observed via the manager's own
 * {@link onSettingsChanged} method which the bootstrapping code wires
 * into `SettingsManagerOptions.onChange`. Concurrent download requests
 * are coalesced via an `inFlight` promise so multiple UI clicks resolve
 * with the same outcome.
 */
export class GeoIPManager {
  private readonly settingsManager: SettingsManager
  private readonly eventBus: EventBus
  private readonly dbPath: string
  private readonly downloader: GeoIPDownloader
  private readonly service: GeoIPService
  private readonly schedulerIntervalMs: number

  private timer: ReturnType<typeof setInterval> | null = null
  private inFlight: Promise<GeoIPStatus> | null = null
  private isDownloading = false
  private lastError: string | null = null
  private currentSizeBytes = 0

  constructor(deps: GeoIPManagerDeps) {
    this.settingsManager = deps.settingsManager
    this.eventBus = deps.eventBus
    this.dbPath = deps.dbPath
    this.downloader = deps.downloader ?? new GeoIPDownloader()
    this.service = deps.service ?? new GeoIPService()
    this.schedulerIntervalMs = deps.schedulerIntervalMs ?? SCHEDULER_INTERVAL_MS
  }

  async start(): Promise<void> {
    const settings = this.getSettings()
    if (settings.enabled) {
      await this.service.open(this.dbPath)
      await this.refreshSize()
    }
    this.timer = setInterval(() => {
      this.tick().catch((err) => {
        log.warn({ err }, 'auto-update tick failed')
      })
    }, this.schedulerIntervalMs)
  }

  async stop(): Promise<void> {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
    // Drain any in-flight auto-update so its file writes finish before
    // the caller proceeds with teardown (matters for tests that delete
    // the tmpdir right after stop()).
    if (this.inFlight) {
      await this.inFlight.catch(() => {})
    }
    this.service.close()
  }

  isEnabled(): boolean {
    return this.getSettings().enabled
  }

  lookupCountry(ip: string): CountryRef | null {
    if (!this.isEnabled()) return null
    return this.service.lookupCountry(ip)
  }

  getStatus(): GeoIPStatus {
    const settings = this.getSettings()
    return {
      enabled: settings.enabled,
      hasDatabase: this.currentSizeBytes > 0,
      loaded: this.service.isLoaded(),
      lastUpdatedAt: settings.lastUpdatedAt,
      databaseVersion: settings.databaseVersion,
      sizeBytes: this.currentSizeBytes,
      isDownloading: this.isDownloading,
      lastError: this.lastError,
    }
  }

  async triggerUpdate(): Promise<GeoIPStatus> {
    if (this.inFlight) return this.inFlight
    this.inFlight = this.runUpdate().finally(() => {
      this.inFlight = null
    })
    return this.inFlight
  }

  /**
   * Hook called by the SettingsManager `onChange` glue when the geoip
   * namespace mutates. Reloads the on-disk file when the user toggles
   * `enabled` or rewires the source — the actual download is left to
   * the user's explicit "Update now" press to keep the UX predictable.
   */
  async onSettingsChanged(
    prev: GeoIPSettings,
    next: GeoIPSettings
  ): Promise<void> {
    if (!prev.enabled && next.enabled) {
      await this.service.reload(this.dbPath)
      await this.refreshSize()
    }
    if (prev.enabled && !next.enabled) {
      this.service.close()
    }
  }

  // ─── internals ────────────────────────────────────────────────

  private getSettings(): GeoIPSettings {
    return this.settingsManager.get().geoip
  }

  private async tick(): Promise<void> {
    const s = this.getSettings()
    if (!s.enabled || !s.autoUpdate) return
    const intervalMs = Math.max(1, s.autoUpdateIntervalDays) * DAY_MS
    if (Date.now() - s.lastUpdatedAt < intervalMs) return
    if (this.isDownloading) return
    log.info({ source: s.source }, 'GeoIP auto-update due')
    await this.triggerUpdate().catch(() => {
      // Errors already recorded in lastError + status event.
    })
  }

  private async runUpdate(): Promise<GeoIPStatus> {
    const settings = this.getSettings()
    const url = resolveDownloadUrl(settings)
    if (!url) {
      const message =
        settings.source === 'maxmind'
          ? 'MaxMind official source is not yet supported (Phase 2.1).'
          : 'No download URL configured for the selected source.'
      this.lastError = message
      this.emitStatus()
      throw new AppError(ErrorCode.GeoIPSourceUnsupported, message)
    }

    this.isDownloading = true
    this.lastError = null
    this.emitStatus()

    const onProgress: ProgressListener = (progress) => {
      this.eventBus.emit(Events.GeoIPUpdateProgress, progress)
    }

    try {
      const result = await this.downloader.download(
        url,
        this.dbPath,
        onProgress
      )
      await this.service.reload(this.dbPath)
      this.currentSizeBytes = result.sizeBytes
      await this.settingsManager.update({
        geoip: {
          lastUpdatedAt: Date.now(),
          databaseVersion: result.version,
        },
      })
      log.info(
        { sizeBytes: result.sizeBytes, version: result.version },
        'GeoIP database installed'
      )
      this.isDownloading = false
      this.emitStatus()
      return this.getStatus()
    } catch (err) {
      this.isDownloading = false
      this.lastError =
        err instanceof Error ? err.message : 'unknown download error'
      log.warn({ err }, 'GeoIP update failed')
      this.emitStatus()
      throw err
    }
  }

  private async refreshSize(): Promise<void> {
    try {
      const s = await stat(this.dbPath)
      this.currentSizeBytes = s.size
    } catch {
      this.currentSizeBytes = 0
    }
  }

  private emitStatus(): void {
    this.eventBus.emit(Events.GeoIPStatusChanged, this.getStatus())
  }
}
