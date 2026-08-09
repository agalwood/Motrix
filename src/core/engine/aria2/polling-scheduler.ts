import { getLogger } from '@core/logger'
import { Events } from '@shared/protocol/events'
import type { GlobalStats } from '@shared/types/stats'
import type { EventBus } from '../../events/event-bus'
import type { Aria2RpcClient } from './aria2-rpc-client'
import { translateGlobalStat } from './translate'
import type { Aria2RawStatus } from './types'

const log = getLogger('polling-scheduler')

const ACTIVE_INTERVAL = 1_000
const IDLE_INTERVAL = 10_000

// Notifications that indicate a download has started or resumed.
const START_NOTIFICATIONS = new Set(['aria2.onDownloadStart'])

// Notifications that indicate a download may have stopped or paused.
const STOP_NOTIFICATIONS = new Set([
  'aria2.onDownloadPause',
  'aria2.onDownloadComplete',
  'aria2.onDownloadStop',
  'aria2.onDownloadError',
  'aria2.onBtDownloadComplete',
])

export type PollingTaskUpdateSource = 'authoritative-poll' | 'notification'

export class PollingScheduler {
  private mode: 'active' | 'idle' = 'idle'
  private timer: ReturnType<typeof setTimeout> | null = null
  private polling = false
  private stopped = true
  private pendingPoll = false
  private inFlightPoll: Promise<void> | null = null
  private drainPromise: Promise<void> | null = null

  constructor(
    private rpc: Aria2RpcClient,
    private eventBus: EventBus,
    private onStats: (stats: GlobalStats) => void,
    private onTasksUpdate: (
      tasks: Aria2RawStatus[],
      source: PollingTaskUpdateSource
    ) => void | Promise<void>
  ) {}

  start(): void {
    this.mode = 'idle'
    this.stopped = false
    // Fire an immediate first poll, then chain
    this.poll()
  }

  stop(): void {
    void this.stopAndDrain()
  }

  stopAndDrain(): Promise<void> {
    if (this.drainPromise) return this.drainPromise
    this.stopped = true
    this.pendingPoll = false
    this.clearTimer()
    const inFlight = this.inFlightPoll
    this.drainPromise = inFlight
      ? inFlight.then(
          () => undefined,
          () => undefined
        )
      : Promise.resolve()
    return this.drainPromise
  }

  private clearTimer(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer)
      this.timer = null
    }
  }

  getMode(): 'active' | 'idle' {
    return this.mode
  }

  async handleNotification(
    method: string,
    event: { gid: string }
  ): Promise<void> {
    if (this.stopped) return
    if (START_NOTIFICATIONS.has(method)) {
      this.switchMode('active')
      await this.syncNotifiedTask(event.gid)
      if (this.stopped) return
      this.requestPoll()
      return
    }

    if (STOP_NOTIFICATIONS.has(method)) {
      await this.syncNotifiedTask(event.gid)
      if (this.stopped) return
      await this.checkAndSwitchMode()
      if (this.stopped) return
      this.requestPoll()
    }
  }

  private async syncNotifiedTask(gid: string): Promise<void> {
    try {
      const task = await this.rpc.tellStatus(gid)
      if (this.stopped) return
      await this.onTasksUpdate([task], 'notification')
    } catch (err) {
      log.debug({ err, gid }, 'notification task sync failed')
    }
  }

  private switchMode(newMode: 'active' | 'idle'): void {
    if (this.mode === newMode) return
    this.mode = newMode

    // Reschedule with new interval — cancel any pending timer
    this.clearTimer()
    // Schedule next poll with new interval (don't fire immediately here,
    // the current or next poll will pick up the new mode)
    this.scheduleNext()

    this.eventBus.emit(Events.EngineActiveChanged, newMode === 'active')
  }

  private async checkAndSwitchMode(): Promise<void> {
    try {
      const stats = await this.rpc.getGlobalStat()
      if (this.stopped) return
      if (Number(stats.numActive) === 0) {
        this.switchMode('idle')
      }
    } catch {
      // If we can't check, stay in current mode
    }
  }

  private scheduleNext(): void {
    if (this.stopped) return
    const interval = this.mode === 'active' ? ACTIVE_INTERVAL : IDLE_INTERVAL
    this.timer = setTimeout(() => {
      // Clear the handle BEFORE firing the next poll. The `poll()`
      // finally-block uses `this.timer === null` as the signal "no
      // pending timer, safe to schedule next". Without this reset
      // the very first scheduled tick would leave `timer` set to a
      // dead handle, breaking the chain after a single iteration.
      this.timer = null
      this.poll()
    }, interval)
  }

  private poll(): void {
    if (this.stopped) return
    if (this.polling) {
      this.pendingPoll = true
      return
    }
    this.polling = true

    const run = this.pollOnce()
    this.inFlightPoll = run

    run
      .catch((err) => {
        // Surface RPC failures explicitly — silent swallow here is what
        // hid the multicall-secret-injection bug for hours during dev.
        // health-check still owns reconnect logic; we only log.
        log.error({ err }, 'pollOnce error')
      })
      .finally(() => {
        if (this.inFlightPoll === run) {
          this.inFlightPoll = null
        }
        this.polling = false
        if (this.stopped) return
        if (this.pendingPoll) {
          this.pendingPoll = false
          this.poll()
          return
        }
        // Only schedule next if we haven't been stopped
        if (this.timer === null) {
          this.scheduleNext()
        }
      })
  }

  private requestPoll(): void {
    if (this.stopped) return
    this.clearTimer()
    this.poll()
  }

  // Both modes share the same RPC shape: get stats + active + waiting in
  // one multicall round-trip. Only the cadence differs (1s vs 10s). Idle
  // still polls the task list because BT magnet metadata-fetch never emits
  // aria2.onDownloadStart, leaving freshly added tasks stuck at the
  // renderer's initial Queued placeholder until polling reconciles.
  private async pollOnce(): Promise<void> {
    const results = await this.rpc.multicall([
      { method: 'aria2.getGlobalStat', params: [] },
      { method: 'aria2.tellActive', params: [] },
      { method: 'aria2.tellWaiting', params: [0, 1000] },
    ])
    if (this.stopped) return

    const rawStats = results[0] as import('./types').Aria2RawGlobalStat
    const rawActive = results[1] as Aria2RawStatus[]
    const rawWaiting = results[2] as Aria2RawStatus[]

    // Notifications are advisory: aria2 may already have active work when
    // Motrix subscribes (for example after session restore). Reconcile the
    // cadence from every authoritative stats response so an initially active
    // engine cannot remain on the 10-second idle interval indefinitely.
    const numActive = Number(rawStats.numActive)
    if (Number.isFinite(numActive)) {
      this.switchMode(numActive > 0 ? 'active' : 'idle')
    }

    this.onStats(translateGlobalStat(rawStats))
    await this.onTasksUpdate(
      [...rawActive, ...rawWaiting],
      'authoritative-poll'
    )
  }
}
