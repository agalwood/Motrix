import { Events } from '@shared/protocol/events'
import type {
  GetTransferStatsParams,
  GlobalStats,
  TransferStatsSnapshot,
} from '@shared/types/stats'
import type Database from 'better-sqlite3'
import type { EventBus } from '../events/event-bus'
import { getLogger } from '../logger'
import {
  TransferStatsService,
  type TransferStatsServiceOptions,
} from './transfer-stats-service'
import { TransferStatsStore } from './transfer-stats-store'

const log = getLogger('transfer-stats')

/**
 * Shared lifecycle adapter used by both Electron and server shells.
 *
 * Keeping EventBus wiring here ensures reconnect boundaries have identical
 * sampling semantics in both runtimes.
 */
export class TransferStatsRuntime {
  private readonly service: TransferStatsService
  private readonly onError: (error: unknown) => void
  private readonly handleEngineDisconnected: () => void
  private readonly handleEngineRecovered: () => void
  private disposed = false
  private disposeResult: boolean | null = null

  constructor(
    db: Database.Database,
    private readonly eventBus: EventBus,
    options: TransferStatsServiceOptions = {}
  ) {
    this.onError =
      options.onError ??
      ((error) => {
        log.error({ err: error }, 'Transfer statistics persistence failed')
      })
    const store = new TransferStatsStore(db, (options.wallNow ?? Date.now)())
    this.service = new TransferStatsService(store, {
      ...options,
      onError: this.onError,
    })

    this.handleEngineDisconnected = () => {
      try {
        this.service.markGap({ flush: true })
      } catch (error) {
        this.reportError(error)
      }
    }
    this.handleEngineRecovered = () => {
      try {
        this.service.markGap()
      } catch (error) {
        this.reportError(error)
      }
    }

    this.eventBus.on(Events.EngineDisconnected, this.handleEngineDisconnected)
    this.eventBus.on(Events.EngineRecovered, this.handleEngineRecovered)
  }

  record(stats: GlobalStats): void {
    if (this.disposed) return
    try {
      this.service.record(stats)
    } catch (error) {
      this.reportError(error)
    }
  }

  snapshot(params: GetTransferStatsParams): TransferStatsSnapshot {
    return this.service.snapshot(params)
  }

  dispose(): boolean {
    if (this.disposed) return this.disposeResult ?? false
    this.disposed = true

    this.eventBus.off(Events.EngineDisconnected, this.handleEngineDisconnected)
    this.eventBus.off(Events.EngineRecovered, this.handleEngineRecovered)

    try {
      this.disposeResult = this.service.dispose()
    } catch (error) {
      this.reportError(error)
      this.disposeResult = false
    }
    return this.disposeResult
  }

  private reportError(error: unknown): void {
    try {
      this.onError(error)
    } catch {
      // Lifecycle cleanup and synchronous EventBus delivery must continue.
    }
  }
}
