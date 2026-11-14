import type { EventBus } from '@core/events/event-bus'
import { getLogger } from '@core/logger'
import {
  type NetworkFingerprint,
  readNetworkFingerprint,
} from '@core/network/network-fingerprint'
import { Events } from '@shared/protocol/events'
import type { TaijiRpcClient } from './taiji-rpc-client'

const POLL_MS = 10_000

/** Network/DNS changes are independent of NAT mapping and tracker settings. */
export class TaijiNetworkBridge {
  private timer: ReturnType<typeof setInterval> | undefined
  private stopped = true
  private ready = false
  private generation = 0
  private key: string | undefined
  private pending = false
  private rerun = false
  private observedAt = 0
  private unavailable = ''
  private controller: AbortController | undefined
  private inFlight: Promise<void> | undefined
  private readonly log = getLogger('taiji-network')

  constructor(
    private readonly deps: {
      rpc: Pick<TaijiRpcClient, 'notifyNetworkChange'>
      eventBus: EventBus
      isEngineReady: () => boolean
      read?: (signal: AbortSignal) => Promise<NetworkFingerprint>
      now?: () => number
    }
  ) {}

  private now() {
    return this.deps.now?.() ?? Date.now()
  }

  private readonly stateChanged = () => {
    const ready = this.deps.isEngineReady()
    if (ready === this.ready) return
    this.ready = ready
    this.generation++
    this.controller?.abort()
    this.key = undefined
    this.pending = true
    if (ready) {
      this.rerun = true
      void this.refresh()
    }
  }

  start(): void {
    if (!this.stopped) return
    this.stopped = false
    this.observedAt = this.now()
    this.deps.eventBus.on(Events.EngineStateChanged, this.stateChanged)
    this.timer = setInterval(() => {
      const now = this.now()
      if (now < this.observedAt || now - this.observedAt > POLL_MS * 3)
        this.notifyWake()
      this.observedAt = now
      void this.refresh()
    }, POLL_MS)
    this.timer.unref()
    this.stateChanged()
  }

  notifyWake(): void {
    if (this.stopped) return
    this.generation++
    this.controller?.abort()
    this.key = undefined
    this.pending = true
    this.observedAt = this.now()
    this.rerun = true
    void this.refresh()
  }

  async stop(): Promise<void> {
    this.stopped = true
    this.ready = false
    this.generation++
    clearInterval(this.timer)
    this.deps.eventBus.off(Events.EngineStateChanged, this.stateChanged)
    this.controller?.abort()
    await this.inFlight
  }

  refresh(): Promise<void> {
    if (this.stopped || !this.ready) return Promise.resolve()
    if (this.inFlight) return this.inFlight
    const operation = (async () => {
      do {
        this.rerun = false
        try {
          await this.reconcile()
        } catch {
          if (!this.stopped && this.ready)
            this.log.debug(
              'network context refresh failed; retrying on the next check'
            )
        }
      } while (this.rerun && !this.stopped && this.ready)
    })().finally(() => {
      this.inFlight = undefined
    })
    this.inFlight = operation
    return operation
  }

  private async reconcile(): Promise<void> {
    const generation = this.generation
    const current = () =>
      !this.stopped && this.ready && generation === this.generation
    const controller = new AbortController()
    this.controller = controller
    const snapshot = await (this.deps.read ?? readNetworkFingerprint)(
      controller.signal
    )
    if (!current()) return
    const unavailable = snapshot.unavailable.join(',')
    if (unavailable !== this.unavailable) {
      this.unavailable = unavailable
      this.log.debug(
        { unavailable: snapshot.unavailable },
        'network configuration observation coverage changed'
      )
    }
    // Establish the fingerprint before acknowledgement. Clearing first and
    // then adopting an initial snapshot could retain answers from a network
    // change that happened while the snapshot was being read.
    if (this.pending || this.key !== snapshot.key) {
      this.pending = true
      await this.deps.rpc.notifyNetworkChange()
      if (!current()) return
      this.pending = false
      this.log.debug('engine name-resolution context refreshed')
    }
    this.key = snapshot.key
  }
}
