import { NatManager, type NatManagerDeps, NatState } from '@motrix/nat'

/**
 * App lifecycle fixes layered over the reusable NAT package.
 *
 * The package waits for an engine-ready event before mapping. During an
 * automatic NAT retry, however, aria2 is usually already Ready, so no new
 * engine event follows rediscovery and the manager can remain in Ready with
 * zero mappings. Re-checking the current engine snapshot after every
 * discovery closes that race for startup, network changes, and retries.
 */
export class MotrixNatManager extends NatManager {
  constructor(
    deps: NatManagerDeps,
    private readonly isEngineReady: () => boolean
  ) {
    super(deps)
  }

  protected override async runDiscovery(): Promise<void> {
    await super.runDiscovery()
    if (this.isEngineReady() && this.getStatus().state === NatState.Ready) {
      await this.mapConfiguredPorts()
    }
  }

  /**
   * A dormant failure still owns its subscriptions and stale mappings.
   * Restart it cleanly so repeated Enable clicks do not accumulate duplicate
   * EventBus/network-monitor listeners, then let discovery build fresh maps.
   */
  override async enable(): Promise<void> {
    const { state } = this.getStatus()
    if (state !== NatState.Idle && state !== NatState.Stopped) {
      await this.stop()
    }
    await this.start()
  }

  override async forceRemap(): Promise<void> {
    if (this.getStatus().state === NatState.Failed) {
      await this.enable()
      return
    }
    await super.forceRemap()
  }
}
