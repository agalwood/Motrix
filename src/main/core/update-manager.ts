import type { EventBus } from '@core/events/event-bus'
import { type EventChannel, Events } from '@shared/protocol/events'
import type {
  AppUpdateProgress,
  AppUpdateState,
} from '@shared/types/app-update'
import type { AppUpdateChannel } from '@shared/types/settings'
import type { VerifyUpdateSupport } from 'electron-updater'

export interface Updater {
  autoDownload: boolean
  autoInstallOnAppQuit: boolean
  channel: string | null
  allowPrerelease: boolean
  allowDowngrade: boolean
  isUpdateSupported: VerifyUpdateSupport
  on(event: string, listener: (...args: unknown[]) => void): unknown
  checkForUpdates(): Promise<unknown>
  downloadUpdate(): Promise<unknown>
  quitAndInstall(): void
}

export interface UpdateManagerOptions {
  eventBus: EventBus
  updater: Updater
  currentVersion: string
  channel: AppUpdateChannel
  /**
   * Whether this build can update itself. False for builds packaged
   * without update metadata (electron-builder only writes
   * `app-update.yml` for distributable targets like dmg/zip/nsis —
   * `dir` builds and dev runs have none). Defaults to true.
   */
  supported?: boolean
}

// Map autoUpdater event names → EventBus event channels. Keeping the
// raw library names on the source side and our PascalCase channels on
// the EventBus side documents the boundary between "what the library
// emits" and "what our protocol guarantees to the renderer".
const EVENT_BRIDGE: Array<[string, EventChannel]> = [
  ['checking-for-update', Events.UpdateCheckStarted],
  ['update-available', Events.UpdateAvailable],
  ['update-not-available', Events.UpdateNotAvailable],
  ['download-progress', Events.UpdateDownloadProgress],
  ['update-downloaded', Events.UpdateDownloaded],
  ['update-cancelled', Events.UpdateCancelled],
  ['error', Events.UpdateError],
]

export class UpdateManager {
  private readonly eventBus: EventBus
  private readonly updater: Updater
  private readonly supported: boolean
  private channel: AppUpdateChannel
  private state: AppUpdateState
  private checkPromise: Promise<unknown> | null = null
  private downloadPromise: Promise<unknown> | null = null

  constructor(options: UpdateManagerOptions) {
    this.eventBus = options.eventBus
    this.updater = options.updater
    this.supported = options.supported !== false
    this.channel = options.channel
    this.state = {
      phase: this.supported ? 'idle' : 'unsupported',
      currentVersion: options.currentVersion,
    }

    // We never auto-download or auto-install. The renderer drives the
    // user experience: check → ask → download → ask → install, and can
    // recover the latest snapshot whenever the About dialog is reopened.
    this.updater.autoDownload = false
    this.updater.autoInstallOnAppQuit = false
    const baseIsUpdateSupported = this.updater.isUpdateSupported
    this.updater.isUpdateSupported = async (updateInfo) => {
      if (!isVersionAllowedForChannel(updateInfo.version, this.channel)) {
        return false
      }
      return baseIsUpdateSupported(updateInfo)
    }
    this.configureUpdaterChannel()

    for (const [source, channel] of EVENT_BRIDGE) {
      this.updater.on(source, (...args) => {
        this.eventBus.emit(channel, ...args)
        this.consumeUpdaterEvent(source, args[0])
      })
    }
  }

  getState(): AppUpdateState {
    return {
      ...this.state,
      progress: this.state.progress ? { ...this.state.progress } : undefined,
      error: this.state.error ? { ...this.state.error } : undefined,
    }
  }

  getChannel(): AppUpdateChannel {
    return this.channel
  }

  setChannel(channel: AppUpdateChannel): void {
    if (channel === this.channel) return
    this.channel = channel
    this.configureUpdaterChannel()
    this.transition({
      phase: this.supported ? 'idle' : 'unsupported',
      currentVersion: this.state.currentVersion,
    })
  }

  check(): Promise<unknown> {
    if (!this.supported) {
      return Promise.reject(
        new Error('Automatic updates are not supported in this build')
      )
    }
    if (this.checkPromise) return this.checkPromise
    if (
      this.state.phase === 'downloading' ||
      this.state.phase === 'downloaded'
    ) {
      return Promise.reject(
        new Error(
          'Cannot check while an update is downloading or ready to install'
        )
      )
    }

    this.transition({
      phase: 'checking',
      currentVersion: this.state.currentVersion,
    })
    this.checkPromise = this.updater
      .checkForUpdates()
      .catch((error: unknown) => {
        this.transitionToError(error)
        throw error
      })
      .finally(() => {
        this.checkPromise = null
      })
    return this.checkPromise
  }

  download(): Promise<unknown> {
    if (this.downloadPromise) return this.downloadPromise
    const canDownload =
      this.state.phase === 'available' ||
      this.state.phase === 'cancelled' ||
      this.state.phase === 'error'
    if (!canDownload || !this.state.availableVersion) {
      return Promise.reject(new Error('No update is available to download'))
    }

    this.transition({
      ...this.state,
      phase: 'downloading',
      progress: {
        percent: 0,
        bytesPerSecond: 0,
        transferred: 0,
        total: 0,
      },
      error: undefined,
    })
    this.downloadPromise = this.updater
      .downloadUpdate()
      .catch((error: unknown) => {
        this.transitionToError(error)
        throw error
      })
      .finally(() => {
        this.downloadPromise = null
      })
    return this.downloadPromise
  }

  install(): void {
    if (this.state.phase !== 'downloaded') {
      throw new Error('Update is not ready to install')
    }
    this.updater.quitAndInstall()
  }

  private consumeUpdaterEvent(source: string, payload: unknown): void {
    switch (source) {
      case 'checking-for-update':
        if (this.state.phase !== 'checking') {
          this.transition({
            phase: 'checking',
            currentVersion: this.state.currentVersion,
          })
        }
        break
      case 'update-available': {
        const info = updateInfo(payload)
        if (!info.version) {
          this.transitionToError('Update metadata did not include a version')
          break
        }
        if (!isVersionAllowedForChannel(info.version, this.channel)) {
          this.transitionToError(
            `Update version ${info.version} is not allowed on the ${this.channel} channel`
          )
          break
        }
        this.transition({
          phase: 'available',
          currentVersion: this.state.currentVersion,
          availableVersion: info.version,
          releaseName: info.releaseName,
          checkedAt: new Date().toISOString(),
        })
        break
      }
      case 'update-not-available':
        this.transition({
          phase: 'up-to-date',
          currentVersion: this.state.currentVersion,
          checkedAt: new Date().toISOString(),
        })
        break
      case 'download-progress':
        this.transition({
          ...this.state,
          phase: 'downloading',
          progress: updateProgress(payload),
          error: undefined,
        })
        break
      case 'update-downloaded': {
        const info = updateInfo(payload)
        this.transition({
          ...this.state,
          phase: 'downloaded',
          availableVersion: info.version ?? this.state.availableVersion,
          releaseName: info.releaseName ?? this.state.releaseName,
          progress: undefined,
          error: undefined,
        })
        break
      }
      case 'update-cancelled':
        this.transition({
          ...this.state,
          phase: 'cancelled',
          progress: undefined,
          error: undefined,
        })
        break
      case 'error':
        this.transitionToError(payload)
        break
    }
  }

  private transition(next: AppUpdateState): void {
    this.state = next
    this.eventBus.emit(Events.UpdateStateChanged, this.getState())
  }

  private configureUpdaterChannel(): void {
    this.updater.channel = this.channel === 'stable' ? 'latest' : 'beta'
    this.updater.allowPrerelease = this.channel === 'beta'
    // electron-updater's channel setter turns this on implicitly. Motrix uses
    // roll-forward-only channel changes to avoid application/data downgrades.
    this.updater.allowDowngrade = false
  }

  private transitionToError(error: unknown): void {
    this.transition({
      ...this.state,
      phase: 'error',
      progress: undefined,
      error: { message: errorMessage(error) },
    })
  }
}

const STRICT_SEMVER_PATTERN =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/

export function isVersionAllowedForChannel(
  version: string,
  channel: AppUpdateChannel
): boolean {
  const match = STRICT_SEMVER_PATTERN.exec(version)
  if (!match) return false
  const prerelease = match[4]
  if (prerelease === undefined) return true
  return channel === 'beta' && prerelease.split('.')[0] === 'beta'
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)
    : null
}

function finiteNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

function updateInfo(payload: unknown): {
  version?: string
  releaseName?: string
} {
  const record = asRecord(payload)
  return {
    version: typeof record?.version === 'string' ? record.version : undefined,
    releaseName:
      typeof record?.releaseName === 'string' ? record.releaseName : undefined,
  }
}

function updateProgress(payload: unknown): AppUpdateProgress {
  const record = asRecord(payload)
  return {
    percent: Math.min(100, Math.max(0, finiteNumber(record?.percent))),
    bytesPerSecond: Math.max(0, finiteNumber(record?.bytesPerSecond)),
    transferred: Math.max(0, finiteNumber(record?.transferred)),
    total: Math.max(0, finiteNumber(record?.total)),
  }
}

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message
  if (typeof error === 'string' && error) return error
  return 'Unknown update error'
}
