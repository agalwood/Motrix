import type { EventBus } from '@core/events/event-bus'
import { AppError, ErrorCode } from '@shared/errors'
import type { AppUpdateState } from '@shared/types/app-update'
import type { AppUpdateChannel } from '@shared/types/settings'
import { UpdateManager, type Updater } from './update-manager'

export interface AppUpdateService {
  getState(): AppUpdateState
  getChannel(): AppUpdateChannel
  setChannel(channel: AppUpdateChannel): void
  check(): Promise<unknown>
  download(): Promise<unknown>
  install(): void
}

interface CreateAppUpdateServiceOptions {
  eventBus: EventBus
  currentVersion: string
  channel: AppUpdateChannel
  isWindowsPackage: boolean
  supported: boolean
  loadUpdater: () => Promise<Updater>
  getManagedMessage: () => string
}

/** Windows packages never load the application updater, including sideloaded tests. */
export async function createAppUpdateService(
  options: CreateAppUpdateServiceOptions
): Promise<AppUpdateService> {
  if (options.isWindowsPackage) {
    return new ManagedUpdateService(
      options.currentVersion,
      options.channel,
      options.getManagedMessage
    )
  }

  return new UpdateManager({
    eventBus: options.eventBus,
    currentVersion: options.currentVersion,
    channel: options.channel,
    updater: await options.loadUpdater(),
    supported: options.supported,
  })
}

class ManagedUpdateService implements AppUpdateService {
  constructor(
    private readonly currentVersion: string,
    private channel: AppUpdateChannel,
    private readonly getManagedMessage: () => string
  ) {}

  getState(): AppUpdateState {
    return {
      phase: 'managed',
      currentVersion: this.currentVersion,
      updateAuthority: 'system',
    }
  }

  getChannel(): AppUpdateChannel {
    return this.channel
  }

  setChannel(channel: AppUpdateChannel): void {
    // Retain the preference for callers without creating a package update channel.
    this.channel = channel
  }

  check(): Promise<never> {
    return Promise.reject(this.managedError())
  }

  download(): Promise<never> {
    return Promise.reject(this.managedError())
  }

  install(): never {
    throw this.managedError()
  }

  private managedError(): AppError {
    return new AppError(ErrorCode.AppUpdateManaged, this.getManagedMessage())
  }
}
