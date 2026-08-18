import type { AppUpdateProgress } from '@shared/types/app-update'
import type { VerifyUpdateSupport } from 'electron-updater'
import type { Updater } from './update-manager'

type UpdateListener = (...args: unknown[]) => void

export interface DevelopmentUpdateSimulatorOptions {
  currentVersion: string
  delay?: (milliseconds: number) => Promise<void>
  onQuitAndInstall: () => void
}

const DOWNLOAD_STEPS = [8, 24, 47, 72, 91, 100] as const
const SIMULATED_TOTAL_BYTES = 128 * 1024 * 1024
const SIMULATED_BYTES_PER_SECOND = 16 * 1024 * 1024

/** Enables the simulator only for an explicit, unpackaged development run. */
export function shouldUseDevelopmentUpdateSimulator(options: {
  isPackaged: boolean
  value: string | undefined
}): boolean {
  return !options.isPackaged && options.value === '1'
}

/**
 * Development-only electron-updater substitute for exercising the complete
 * renderer flow without update metadata, a release feed, or an installer.
 */
export class DevelopmentUpdateSimulator implements Updater {
  autoDownload = false
  autoInstallOnAppQuit = false
  channel: string | null = null
  allowPrerelease = false
  allowDowngrade = false
  isUpdateSupported: VerifyUpdateSupport = async () => true

  private readonly listeners = new Map<string, UpdateListener[]>()
  private readonly delay: (milliseconds: number) => Promise<void>
  private readonly onQuitAndInstall: () => void
  private readonly stableVersion: string

  constructor(options: DevelopmentUpdateSimulatorOptions) {
    this.delay = options.delay ?? wait
    this.onQuitAndInstall = options.onQuitAndInstall
    this.stableVersion = nextPatchVersion(options.currentVersion)
  }

  on(event: string, listener: UpdateListener): this {
    const listeners = this.listeners.get(event) ?? []
    listeners.push(listener)
    this.listeners.set(event, listeners)
    return this
  }

  async checkForUpdates(): Promise<unknown> {
    this.emit('checking-for-update')
    await this.delay(500)
    const updateInfo = this.updateInfo()
    this.emit('update-available', updateInfo)
    return { updateInfo }
  }

  async downloadUpdate(): Promise<unknown> {
    const updateInfo = this.updateInfo()
    for (const percent of DOWNLOAD_STEPS) {
      await this.delay(250)
      this.emit('download-progress', progressAt(percent))
    }
    this.emit('update-downloaded', updateInfo)
    return ['/tmp/motrix-development-update-simulator.zip']
  }

  quitAndInstall(): void {
    this.emit('before-quit-for-update')
    this.onQuitAndInstall()
  }

  private updateInfo(): { version: string; releaseName: string } {
    const version =
      this.channel === 'beta'
        ? `${this.stableVersion}-beta.1`
        : this.stableVersion
    return {
      version,
      releaseName: 'Development update simulator',
    }
  }

  private emit(event: string, ...args: unknown[]): void {
    for (const listener of this.listeners.get(event) ?? []) listener(...args)
  }
}

function progressAt(percent: number): AppUpdateProgress {
  return {
    percent,
    bytesPerSecond: SIMULATED_BYTES_PER_SECOND,
    transferred: Math.round((SIMULATED_TOTAL_BYTES * percent) / 100),
    total: SIMULATED_TOTAL_BYTES,
  }
}

function nextPatchVersion(version: string): string {
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(version)
  if (!match) return '999.0.0'
  return `${match[1]}.${match[2]}.${Number(match[3]) + 1}`
}

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}
