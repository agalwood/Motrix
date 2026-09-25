import {
  type NatDiagnosticResult,
  NatManager,
  type NatManagerDeps,
  NatPortReachability,
  NatProtocol,
  NatState,
  NatType,
} from '@motrix/nat'

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

  private diagnostic: NatDiagnosticResult | null = null
  private diagnosticInFlight: Promise<void> | null = null

  override getStatus() {
    return { ...super.getStatus(), lastDiagnostic: this.diagnostic }
  }

  override async runDiagnostic(signal?: AbortSignal): Promise<void> {
    if (this.diagnosticInFlight) return this.diagnosticInFlight
    this.diagnosticInFlight = this.checkDiagnostics(signal)
    try {
      await this.diagnosticInFlight
    } finally {
      this.diagnosticInFlight = null
    }
  }

  private async checkDiagnostics(signal?: AbortSignal) {
    const nat = this.deps.settingsProvider.getNat()
    const engine = this.deps.settingsProvider.getEngine()
    if (signal?.aborted) return
    const result: NatDiagnosticResult = {
      runAt: this.now(),
      natType: NatType.Unknown,
      gatewayInfo: this.gatewayInfo,
      portReachability: {
        btListenPort: NatPortReachability.Unknown,
        dhtListenPort: NatPortReachability.Unknown,
      },
      protocolAvailability: {
        pcp:
          this.gatewayInfo?.supportedProtocols.includes(NatProtocol.Pcp) ??
          false,
        natpmp:
          this.gatewayInfo?.supportedProtocols.includes(NatProtocol.NatPmp) ??
          false,
        upnp:
          this.gatewayInfo?.supportedProtocols.includes(NatProtocol.Upnp) ??
          false,
      },
      healthScore: 'fair',
      recommendations: [],
    }
    let externalIp = this.gatewayInfo?.externalIp ?? ''
    if (nat.natTypeDetectionEnabled && nat.stunServers.length > 0) {
      const detected = await this.deps.stunClient.detectNatType({
        servers: nat.stunServers,
        timeoutMs: 3000,
        signal,
      })
      if (signal?.aborted) return
      if (
        detected.ok &&
        detected.value &&
        typeof detected.value === 'object' &&
        'mappedIp' in detected.value &&
        typeof detected.value.mappedIp === 'string'
      ) {
        externalIp = detected.value.mappedIp
        // A binding response alone cannot classify cone/symmetric NAT.
        if (externalIp === this.deps.networkMonitor.snapshot().internalIp)
          result.natType = NatType.Open
      }
    }
    if (
      nat.portReachabilityCheckEnabled &&
      nat.portCheckerEndpoints.length > 0 &&
      externalIp.length > 0
    ) {
      for (const endpoint of nat.portCheckerEndpoints) {
        if (signal?.aborted) return
        const checked = await this.deps.portChecker.checkPortReachable({
          endpoints: [endpoint],
          externalIp,
          port: engine.listenPort,
          timeoutMs: 5000,
          signal,
        })
        if (signal?.aborted) return
        if (
          checked.ok &&
          checked.value &&
          typeof checked.value === 'object' &&
          'reachable' in checked.value &&
          typeof checked.value.reachable === 'boolean'
        ) {
          result.portReachability.btListenPort = checked.value.reachable
            ? NatPortReachability.Reachable
            : NatPortReachability.Unreachable
          result.healthScore = checked.value.reachable ? 'good' : 'poor'
          break
        }
      }
      // The current service contract does not specify UDP; never describe a
      // TCP result for the DHT port as evidence of UDP reachability.
    }
    this.diagnostic = result
    this.deps.onEvent({ type: 'diagnostic-completed', result })
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
