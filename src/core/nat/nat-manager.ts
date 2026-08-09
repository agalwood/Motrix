import crypto from 'node:crypto'
import {
  type NatGatewayInfo,
  type NatMapping,
  type NatMappingPurpose,
  NatProtocol,
  NatState,
  type NatStatus,
  type NatTransportProtocol,
} from '@shared/types/nat'
import type { NatSettings } from '@shared/types/settings'
import { UPNP_WANIP_V1 } from './codecs'
import { natLogger } from './logger'
import { GenerationGuard, TransitionMutex } from './state-machine'

const log = natLogger('manager')

// Injectable dependency interfaces (structural subsets; concrete classes
// implement them)
export interface NatSettingsProvider {
  getEngine(): { listenPort: number; dhtListenPort: number }
  // The NatManager only consumes the mapping/discovery slice of NatSettings;
  // auto-diagnostic scheduling fields are owned elsewhere.
  getNat(): Omit<NatSettings, 'autoDiagnostic' | 'diagnosticIntervalSec'>
}

export interface UpnpClientLike {
  discover(opts?: {
    timeoutMs?: number
  }): Promise<{ ok: boolean; value?: unknown; error?: unknown }>
  mapPort(
    gateway: unknown,
    params: unknown,
    signal?: AbortSignal
  ): Promise<{ ok: boolean; error?: unknown }>
  unmapPort(
    gateway: unknown,
    params: unknown,
    signal?: AbortSignal
  ): Promise<{ ok: boolean; error?: unknown }>
  getExternalIp(
    gateway: unknown,
    signal?: AbortSignal
  ): Promise<{ ok: boolean; value?: string; error?: unknown }>
}

export interface PmpPcpClientLike {
  natPmpGetExternalIp(options?: {
    timeoutMs?: number
  }): Promise<{ ok: boolean; value?: unknown; error?: unknown }>
  natPmpMap(
    params: unknown
  ): Promise<{ ok: boolean; value?: unknown; error?: unknown }>
  pcpMap(
    params: unknown
  ): Promise<{ ok: boolean; value?: unknown; error?: unknown }>
  setGatewayIp(ip: string): void
  close(): Promise<void>
}

export interface StunClientLike {
  detectNatType(
    options: unknown
  ): Promise<{ ok: boolean; value?: unknown; error?: unknown }>
}

export interface PortCheckerLike {
  checkPortReachable(
    options: unknown
  ): Promise<{ ok: boolean; value?: unknown; error?: unknown }>
}

export interface NetworkMonitorLike {
  start(): void
  stop(): void
  onChange(listener: (snap: unknown) => void): () => void
  snapshot(): { gatewayIp: string; internalIp: string; hash: string }
}

export interface NatManagerHooks {
  /** External conditions met — start mapping configured ports. */
  onReady(listener: () => void): () => void
  /** NAT or port configuration may have changed. */
  onConfigChanged(listener: () => void): () => void
}

export type NatEvent =
  | { type: 'state-changed'; state: NatState }
  | { type: 'error'; error: { code: string; message: string } }
  | { type: 'gateway-changed'; info: NatGatewayInfo }
  | { type: 'mapping-updated'; mappings: NatMapping[] }
  | { type: 'diagnostic-completed'; result: unknown }

export interface NatManagerDeps {
  hooks: NatManagerHooks
  onEvent: (event: NatEvent) => void
  settingsProvider: NatSettingsProvider
  upnpClient: UpnpClientLike
  pmpPcpClient: PmpPcpClientLike
  stunClient: StunClientLike
  portChecker: PortCheckerLike
  networkMonitor: NetworkMonitorLike
  now?: () => number
}

export class NatManager {
  protected readonly deps: NatManagerDeps
  protected readonly mutex = new TransitionMutex()
  protected readonly gen = new GenerationGuard()
  protected readonly now: () => number
  protected readonly PROTOCOL_ORDER: NatProtocol[] = [
    NatProtocol.Pcp,
    NatProtocol.NatPmp,
    NatProtocol.Upnp,
  ]

  protected state: NatState = NatState.Idle
  protected gatewayInfo: NatGatewayInfo | null = null
  protected activeMappings: NatMapping[] = []
  protected lastError: NatStatus['lastError'] = null
  protected unsubscribers: Array<() => void> = []
  protected abortController: AbortController | null = null
  protected stickyProtocol: NatProtocol | null = null
  protected renewalTimer: NodeJS.Timeout | null = null
  protected readonly RETRY_DELAYS_MS: ReadonlyArray<number> = [
    5_000, 15_000, 45_000,
  ]
  protected retryCount = 0
  protected retryTimer: NodeJS.Timeout | null = null
  private readonly coalesceDirty = new Map<string, boolean>()

  constructor(deps: NatManagerDeps) {
    this.deps = deps
    this.now = deps.now ?? (() => Date.now())
  }

  getStatus(): NatStatus {
    return {
      state: this.state,
      enabled: this.deps.settingsProvider.getNat().enabled,
      activeMappings: [...this.activeMappings],
      gatewayInfo: this.gatewayInfo,
      lastError: this.lastError,
      lastDiagnostic: null, // diagnostics live in a follow-up milestone
      retryAttempt: this.retryCount,
      maxRetries: this.RETRY_DELAYS_MS.length,
    }
  }

  async start(): Promise<void> {
    const nat = this.deps.settingsProvider.getNat()
    const engine = this.deps.settingsProvider.getEngine()
    // Reset retry budget on every explicit start so user-triggered enable()
    // and recovery flows get a fresh attempt counter, regardless of whether
    // the manager was previously dormant.
    if (this.retryTimer) {
      clearTimeout(this.retryTimer)
      this.retryTimer = null
    }
    this.retryCount = 0
    log.info(
      {
        enabled: nat.enabled,
        preferredProtocol: nat.preferredProtocol,
        mappingTtl: nat.mappingTtl,
        natTypeDetectionEnabled: nat.natTypeDetectionEnabled,
        portReachabilityCheckEnabled: nat.portReachabilityCheckEnabled,
        listenPort: engine.listenPort,
        dhtListenPort: engine.dhtListenPort,
        currentState: this.state,
      },
      'NatManager.start: entering'
    )
    if (!nat.enabled) {
      this.setState(NatState.Stopped)
      log.info(
        { state: this.state },
        'NatManager.start: NAT disabled, stopped without discovery'
      )
      return
    }
    this.subscribeToBus()
    log.debug(
      { subscribers: this.unsubscribers.length },
      'NatManager.start: event subscribers registered'
    )
    this.deps.networkMonitor.start()
    log.debug('NatManager.start: networkMonitor started')
    await this.runDiscovery()
    log.info(
      {
        state: this.state,
        gatewayIp: this.gatewayInfo?.gatewayIp ?? null,
        internalIp: this.gatewayInfo?.internalIp ?? null,
        externalIp: this.gatewayInfo?.externalIp ?? null,
        supportedProtocols: this.gatewayInfo?.supportedProtocols ?? [],
        manufacturer: this.gatewayInfo?.manufacturer ?? null,
        modelName: this.gatewayInfo?.modelName ?? null,
        lastErrorCode: this.lastError?.code ?? null,
        lastErrorMessage: this.lastError?.message ?? null,
        retryCount: this.retryCount,
      },
      'NatManager.start: completed'
    )
  }

  async stop(): Promise<void> {
    const beforeState = this.state
    const beforeMappingCount = this.activeMappings.length
    // Invalidate any in-flight discovery before its trailing setState writes
    // can resurrect us from Stopped — the generation guard inside doDiscovery
    // honours this bump on every isCurrent() checkpoint.
    this.gen.bump()
    log.info(
      {
        state: beforeState,
        activeMappings: beforeMappingCount,
        stickyProtocol: this.stickyProtocol,
        retryCount: this.retryCount,
        hasRetryTimer: this.retryTimer !== null,
        hasRenewalTimer: this.renewalTimer !== null,
        hasAbortController: this.abortController !== null,
        subscribers: this.unsubscribers.length,
      },
      'NatManager.stop: entering'
    )
    let retryTimerCleared = false
    if (this.retryTimer) {
      clearTimeout(this.retryTimer)
      this.retryTimer = null
      retryTimerCleared = true
    }
    const renewalWasActive = this.renewalTimer !== null
    this.clearRenewalTimer()
    const aborted = this.abortController !== null
    this.abortController?.abort()
    const subscriberCount = this.unsubscribers.length
    for (const off of this.unsubscribers) off()
    this.unsubscribers = []
    log.debug(
      {
        retryTimerCleared,
        renewalTimerCleared: renewalWasActive,
        aborted,
        releasedSubscribers: subscriberCount,
      },
      'NatManager.stop: timers and subscribers released'
    )
    this.deps.networkMonitor.stop()
    log.debug('NatManager.stop: networkMonitor stopped')
    // Unmap all active port mappings from the router before closing clients.
    // Best-effort: each mapping is independent, so one failure must not block
    // the rest or prevent shutdown.
    let unmappedCount = 0
    for (const mapping of this.activeMappings) {
      try {
        await this.unmapOne(mapping)
        unmappedCount++
      } catch (err) {
        log.warn(
          { err, port: mapping.internalPort, method: mapping.method },
          'NatManager.stop: unmapOne failed, continuing'
        )
      }
    }
    log.debug(
      { unmappedCount, total: beforeMappingCount },
      'NatManager.stop: unmapping complete'
    )
    let pmpPcpClosed = true
    try {
      await this.deps.pmpPcpClient.close()
    } catch (err) {
      pmpPcpClosed = false
      log.warn({ err }, 'pmpPcp close failed')
    }
    this.activeMappings = []
    this.gatewayInfo = null
    this.stickyProtocol = null
    this.setState(NatState.Stopped)
    log.info(
      {
        previousState: beforeState,
        clearedMappings: beforeMappingCount,
        retryTimerCleared,
        renewalTimerCleared: renewalWasActive,
        aborted,
        releasedSubscribers: subscriberCount,
        pmpPcpClosed,
        state: this.state,
      },
      'NatManager.stop: completed'
    )
  }

  protected setState(next: NatState): void {
    if (this.state === next) return
    this.state = next
    this.deps.onEvent({ type: 'state-changed', state: next })
    this.handleRetryOnStateChange(next)
  }

  protected setLastError(code: string, message: string): void {
    this.lastError = { code, message, occurredAt: this.now() }
    this.deps.onEvent({ type: 'error', error: { code, message } })
  }

  /**
   * Push the learned gateway address into PmpPcpClient so subsequent
   * NAT-PMP / PCP packets target the real gateway rather than the
   * placeholder the factory used at construction. Silently tolerates
   * malformed inputs from discovery (logs + keeps previous value) rather
   * than propagating the RangeError up the discovery path.
   */
  protected syncPmpPcpGatewayIp(ip: string | undefined | null): void {
    if (!ip) return
    try {
      this.deps.pmpPcpClient.setGatewayIp(ip)
    } catch (err) {
      log.warn(
        { err, ip },
        'syncPmpPcpGatewayIp: discovery produced invalid gateway IP'
      )
    }
  }

  protected handleRetryOnStateChange(next: NatState): void {
    if (next === NatState.Active || next === NatState.Stopped) {
      this.retryCount = 0
      if (this.retryTimer) {
        clearTimeout(this.retryTimer)
        this.retryTimer = null
      }
      return
    }
    if (next === NatState.Failed) {
      if (this.retryCount >= this.RETRY_DELAYS_MS.length) {
        log.info(
          { retries: this.retryCount },
          'entering dormant state; awaiting network change or manual remap'
        )
        return
      }
      // biome-ignore lint/style/noNonNullAssertion: retryCount bounded by length check above
      const delay = this.RETRY_DELAYS_MS[this.retryCount]!
      this.retryCount++
      this.retryTimer = setTimeout(() => {
        this.retryTimer = null
        void this.runDiscovery()
      }, delay)
      this.retryTimer.unref?.()
    }
  }

  protected subscribeToBus(): void {
    const settingsOff = this.deps.hooks.onConfigChanged(() => {
      void this.handleSettingsChanged()
    })

    const readyOff = this.deps.hooks.onReady(() => {
      void this.mapConfiguredPorts()
    })

    const netOff = this.deps.networkMonitor.onChange((snap: unknown) => {
      log.info({ snap }, 'network change detected — re-discovering')
      void this.runDiscovery()
    })

    this.unsubscribers.push(settingsOff, readyOff, netOff)
  }

  private async handleSettingsChanged(): Promise<void> {
    const nat = this.deps.settingsProvider.getNat()
    if (!nat.enabled) {
      await this.stop()
      return
    }
    const engine = this.deps.settingsProvider.getEngine()
    const currentPorts = new Set(this.activeMappings.map((m) => m.internalPort))
    const expected = new Set([engine.listenPort, engine.dhtListenPort])
    const portsChanged =
      currentPorts.size !== expected.size ||
      [...expected].some((p) => !currentPorts.has(p))
    if (portsChanged) {
      for (const mapping of this.activeMappings) {
        if (!expected.has(mapping.internalPort)) {
          await this.unmapOne(mapping).catch(() => {})
        }
      }
      this.activeMappings = []
      await this.mapConfiguredPorts()
    }
  }

  private async unmapOne(mapping: NatMapping): Promise<void> {
    if (
      mapping.method === NatProtocol.Upnp &&
      this.gatewayInfo?.controlUrl &&
      this.gatewayInfo.controlHost &&
      this.gatewayInfo.controlPort
    ) {
      await this.deps.upnpClient.unmapPort(
        {
          gatewayIp: this.gatewayInfo.gatewayIp,
          controlUrl: this.gatewayInfo.controlUrl,
          controlHost: this.gatewayInfo.controlHost,
          controlPort: this.gatewayInfo.controlPort,
          serviceType: UPNP_WANIP_V1,
          manufacturer: this.gatewayInfo.manufacturer ?? '',
          modelName: this.gatewayInfo.modelName ?? '',
        },
        {
          externalPort: mapping.externalPort,
          protocol: mapping.protocol,
        }
      )
    } else if (mapping.method === NatProtocol.Pcp) {
      // PCP: lifetime=0 means "delete" per RFC 6887 §10.2.
      // The nonce MUST match the one used when creating the mapping.
      await this.deps.pmpPcpClient.pcpMap({
        protocol: mapping.protocol,
        internalPort: mapping.internalPort,
        externalPort: 0,
        ttl: 0,
        nonce: mapping.pcpNonce
          ? Buffer.from(mapping.pcpNonce, 'hex')
          : undefined,
      })
    } else {
      // NAT-PMP: ttl=0 means "remove" per RFC 6886 §3.3
      await this.deps.pmpPcpClient.natPmpMap({
        protocol: mapping.protocol,
        internalPort: mapping.internalPort,
        externalPort: 0,
        ttl: 0,
      })
    }
  }

  /**
   * Run `work` under the shared mutex with coalescing: if the mutex is already
   * held, set a dirty flag so the current holder re-runs after completing.
   * Eliminates contention warnings during cold-start and network-change bursts.
   */
  private async runCoalesced(
    label: string,
    work: () => Promise<void>
  ): Promise<void> {
    if (this.mutex.isLocked) {
      this.coalesceDirty.set(label, true)
      log.debug(
        { currentHolder: this.mutex.currentHolder },
        `${label}: coalesced (mutex busy, will re-run after current)`
      )
      return
    }
    do {
      this.coalesceDirty.set(label, false)
      const caller = `${label}@${this.now()}`
      log.debug(
        { caller, currentHolder: this.mutex.currentHolder },
        `${label}: attempting mutex`
      )
      try {
        await this.mutex.runExclusive(async () => {
          log.debug({ caller }, `${label}: mutex acquired`)
          await work()
        }, caller)
        log.debug({ caller }, `${label}: mutex released`)
      } catch {
        // TOCTOU: mutex was free at the isLocked check but acquired before
        // runExclusive. Mark dirty so the holder picks it up.
        this.coalesceDirty.set(label, true)
        log.debug(
          { caller, currentHolder: this.mutex.currentHolder },
          `${label}: mutex race, will retry`
        )
        return
      }
    } while (this.coalesceDirty.get(label))
  }

  protected async runDiscovery(): Promise<void> {
    await this.runCoalesced('discovery', () => this.doDiscovery())
  }

  private async doDiscovery(): Promise<void> {
    this.setState(NatState.Discovering)
    const generation = this.gen.bump()
    this.abortController?.abort()
    this.abortController = new AbortController()

    // Phase 1 discovery: try UPnP first; NAT-PMP/PCP probe is a fast
    // UDP request and does not establish gateway info for SOAP, so treat
    // UPnP as primary.
    const upnp = await this.deps.upnpClient.discover({
      timeoutMs: 3000,
    })
    if (!this.gen.isCurrent(generation)) return
    if (upnp.ok && upnp.value) {
      const g = upnp.value as {
        gatewayIp: string
        controlUrl: string
        controlHost: string
        controlPort: number
        serviceType: string
        manufacturer: string
        modelName: string
      }
      this.gatewayInfo = {
        internalIp: this.deps.networkMonitor.snapshot().internalIp,
        gatewayIp: g.gatewayIp,
        externalIp: null,
        controlUrl: g.controlUrl,
        controlHost: g.controlHost,
        controlPort: g.controlPort,
        manufacturer: g.manufacturer,
        modelName: g.modelName,
        supportedProtocols: [NatProtocol.Upnp],
      }
      this.syncPmpPcpGatewayIp(g.gatewayIp)
      this.deps.onEvent({ type: 'gateway-changed', info: this.gatewayInfo })
      this.setState(NatState.Ready)
      return
    }

    // Fall back to NAT-PMP probe
    const pmp = await this.deps.pmpPcpClient.natPmpGetExternalIp({
      timeoutMs: 1000,
    })
    if (!this.gen.isCurrent(generation)) return
    if (pmp.ok) {
      const snap = this.deps.networkMonitor.snapshot()
      const pmpVal = pmp.value as { externalIp?: string } | undefined
      this.gatewayInfo = {
        internalIp: snap.internalIp,
        gatewayIp: snap.gatewayIp,
        externalIp: pmpVal?.externalIp ?? null,
        controlUrl: null,
        controlHost: null,
        controlPort: null,
        manufacturer: null,
        modelName: null,
        supportedProtocols: [NatProtocol.NatPmp],
      }
      this.syncPmpPcpGatewayIp(snap.gatewayIp)
      this.deps.onEvent({ type: 'gateway-changed', info: this.gatewayInfo })
      this.setState(NatState.Ready)
      return
    }

    if (!this.gen.isCurrent(generation)) return
    this.setLastError('NAT_DISCOVERY_FAILED', 'all discovery attempts failed')
    this.setState(NatState.Failed)
  }

  private async doMapConfiguredPorts(): Promise<void> {
    if (this.state !== NatState.Ready && this.state !== NatState.Active) return
    const engine = this.deps.settingsProvider.getEngine()
    const ports: Array<{
      port: number
      purpose: NatMappingPurpose
      protocol: NatTransportProtocol
    }> = [
      { port: engine.listenPort, purpose: 'bt-listen', protocol: 'TCP' },
      { port: engine.dhtListenPort, purpose: 'dht-listen', protocol: 'UDP' },
    ]
    this.setState(NatState.Mapping)
    const newMappings: NatMapping[] = []
    for (const p of ports) {
      const mapping = await this.mapOne(p.port, p.protocol, p.purpose)
      if (!mapping) {
        this.setLastError(
          'NAT_MAPPING_FAILED',
          `all protocols failed for port ${p.port}`
        )
        this.setState(NatState.Failed)
        return
      }
      newMappings.push(mapping)
    }
    this.activeMappings = newMappings
    this.deps.onEvent({
      type: 'mapping-updated',
      mappings: [...this.activeMappings],
    })
    this.setState(NatState.Active)
    this.scheduleRenewal()
  }

  async mapConfiguredPorts(): Promise<void> {
    await this.runCoalesced('map-configured', () => this.doMapConfiguredPorts())
  }

  async remapAll(): Promise<void> {
    const caller = `remap-all@${this.now()}`
    log.debug(
      { caller, currentHolder: this.mutex.currentHolder },
      'remapAll: attempting mutex'
    )
    try {
      await this.mutex.runExclusive(async () => {
        log.debug({ caller }, 'remapAll: mutex acquired')
        if (this.activeMappings.length === 0) {
          await this.doMapConfiguredPorts()
          return
        }
        const refreshed: NatMapping[] = []
        for (const existing of this.activeMappings) {
          const mapping = await this.mapOne(
            existing.internalPort,
            existing.protocol,
            existing.purpose,
            {
              preferred: existing.method,
              existingNonce: existing.pcpNonce,
            }
          )
          if (!mapping) {
            // Partial failure: invalidate sticky protocol and attempt full fallback
            this.stickyProtocol = null
            const retry = await this.mapOne(
              existing.internalPort,
              existing.protocol,
              existing.purpose
            )
            if (!retry) {
              this.setState(NatState.Failed)
              return
            }
            refreshed.push(retry)
          } else {
            refreshed.push(mapping)
          }
        }
        this.activeMappings = refreshed
        this.deps.onEvent({
          type: 'mapping-updated',
          mappings: [...this.activeMappings],
        })
        this.scheduleRenewal()
      }, caller)
      log.debug({ caller }, 'remapAll: mutex released')
    } catch (err) {
      log.warn({ err, caller }, 'remapAll mutex contention')
    }
  }

  protected scheduleRenewal(): void {
    if (this.renewalTimer) clearTimeout(this.renewalTimer)
    if (this.activeMappings.length === 0) return
    const ttl = this.deps.settingsProvider.getNat().mappingTtl
    const jitter = crypto.randomInt(0, 60_000)
    const base = ttl > 1200 ? (ttl - 600) * 1000 : (ttl / 2) * 1000
    const renewIn = Math.max(base + jitter, 60_000)
    this.renewalTimer = setTimeout(() => {
      void this.remapAll().then(() => this.scheduleRenewal())
    }, renewIn)
    this.renewalTimer.unref?.()
  }

  protected clearRenewalTimer(): void {
    if (this.renewalTimer) {
      clearTimeout(this.renewalTimer)
      this.renewalTimer = null
    }
  }

  private async mapOne(
    internalPort: number,
    protocol: NatTransportProtocol,
    purpose: NatMappingPurpose,
    opts?: { preferred?: NatProtocol; existingNonce?: string }
  ): Promise<NatMapping | null> {
    const { preferred, existingNonce } = opts ?? {}
    const order: NatProtocol[] = preferred
      ? [preferred, ...this.PROTOCOL_ORDER.filter((p) => p !== preferred)]
      : this.stickyProtocol
        ? [
            this.stickyProtocol,
            ...this.PROTOCOL_ORDER.filter((p) => p !== this.stickyProtocol),
          ]
        : [...this.PROTOCOL_ORDER]
    for (const proto of order) {
      const result = await this.tryMap(
        proto,
        internalPort,
        protocol,
        existingNonce
      )
      if (result) {
        this.stickyProtocol = proto
        // SPEC FIX: warn when NAT-PMP is SELECTED (success), not when it fails
        if (proto === NatProtocol.NatPmp) {
          this.deps.onEvent({
            type: 'error',
            error: {
              code: 'NAT_SECURITY_WARNING',
              message: 'NAT-PMP selected; responses are unauthenticated',
            },
          })
        }
        return {
          internalPort,
          externalPort: result.externalPort,
          protocol,
          purpose,
          method: proto,
          ttl: result.ttl,
          expiresAt: this.now() + result.ttl * 1000,
          createdAt: this.now(),
          lastRenewedAt: this.now(),
          pcpNonce: result.pcpNonce,
        }
      }
    }
    return null
  }

  private async tryMap(
    proto: NatProtocol,
    internalPort: number,
    protocol: NatTransportProtocol,
    existingNonce?: string
  ): Promise<{ externalPort: number; ttl: number; pcpNonce?: string } | null> {
    const ttl = this.deps.settingsProvider.getNat().mappingTtl
    try {
      switch (proto) {
        case NatProtocol.Pcp: {
          const r = await this.deps.pmpPcpClient.pcpMap({
            internalPort,
            externalPort: internalPort,
            protocol,
            ttl,
            timeoutMs: 1000,
            nonce: existingNonce
              ? Buffer.from(existingNonce, 'hex')
              : undefined,
          })
          if (!r.ok) return null
          const v = r.value as
            | { externalPort?: number; ttl?: number; nonce?: Buffer }
            | undefined
          return {
            externalPort: v?.externalPort ?? internalPort,
            ttl: v?.ttl ?? ttl,
            pcpNonce: v?.nonce ? v.nonce.toString('hex') : undefined,
          }
        }
        case NatProtocol.NatPmp: {
          const r = await this.deps.pmpPcpClient.natPmpMap({
            protocol,
            internalPort,
            externalPort: internalPort,
            ttl,
            timeoutMs: 1000,
          })
          if (!r.ok) return null
          const v = r.value as
            | { externalPort?: number; ttl?: number }
            | undefined
          return {
            externalPort: v?.externalPort ?? internalPort,
            ttl: v?.ttl ?? ttl,
          }
        }
        case NatProtocol.Upnp: {
          const info = this.gatewayInfo
          if (
            !info?.controlUrl ||
            !info.controlHost ||
            !info.controlPort ||
            info.controlPort < 1 ||
            info.controlPort > 65535
          ) {
            return null
          }
          const r = await this.deps.upnpClient.mapPort(
            {
              gatewayIp: info.gatewayIp,
              controlUrl: info.controlUrl,
              controlHost: info.controlHost,
              controlPort: info.controlPort,
              serviceType: UPNP_WANIP_V1,
              manufacturer: info.manufacturer ?? '',
              modelName: info.modelName ?? '',
            },
            {
              internalIp: this.deps.networkMonitor.snapshot().internalIp,
              internalPort,
              externalPort: internalPort,
              protocol,
              ttl,
              description: 'Motrix',
            },
            // Thread the lifecycle AbortController into the SOAP call so a
            // stop()/re-discovery (both call abortController.abort()) cancels
            // an in-flight UPnP mapping. unmapOne deliberately does NOT pass
            // this signal: stop() aborts before its cleanup-unmap loop, and a
            // pre-aborted signal would cancel the very unmaps that release the
            // router's port mappings.
            this.abortController?.signal
          )
          if (!r.ok) return null
          return { externalPort: internalPort, ttl }
        }
      }
    } catch (err) {
      log.warn({ proto, internalPort, err }, 'tryMap threw')
    }
    return null
  }

  // ——— Public API consumed by M6 IPC layer ———
  async enable(): Promise<void> {
    await this.start()
  }

  async disable(): Promise<void> {
    await this.stop()
  }

  async forceRemap(): Promise<void> {
    if (this.state === NatState.Stopped || this.state === NatState.Idle) {
      await this.start()
      return
    }
    await this.remapAll()
  }

  async runDiagnostic(): Promise<void> {
    // Minimal stub: only NAT type detection if enabled. Full diagnostic
    // landing in M8.
    const nat = this.deps.settingsProvider.getNat()
    if (!nat.natTypeDetectionEnabled || nat.stunServers.length === 0) return
    const result = await this.deps.stunClient.detectNatType({
      servers: nat.stunServers,
      timeoutMs: 3000,
    })
    this.deps.onEvent({
      type: 'diagnostic-completed',
      result: {
        runAt: this.now(),
        natType: result.ok ? 'unknown' : 'unknown',
        gatewayInfo: this.gatewayInfo,
        portReachability: {
          btListenPort: 'unknown',
          dhtListenPort: 'unknown',
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
      },
    })
  }

  async exportBundle(): Promise<{
    clientVersion: string
    platform: NodeJS.Platform
    state: NatState
    stickyProtocol: NatProtocol | null
    gatewayManufacturer: string | null
    gatewayModel: string | null
    internalIpMasked: string | null
    gatewayIpMasked: string | null
    retryCount: number
    activeMappingCount: number
    lastErrorCode: string | null
    recordedAt: number
  }> {
    const mask = (ip: string | null | undefined): string | null => {
      if (!ip) return null
      const parts = ip.split('.')
      if (parts.length !== 4) return null
      return `${parts[0]}.${parts[1]}.x.x`
    }
    return {
      clientVersion: process.env.npm_package_version ?? 'dev',
      platform: process.platform,
      state: this.state,
      stickyProtocol: this.stickyProtocol,
      gatewayManufacturer: this.gatewayInfo?.manufacturer ?? null,
      gatewayModel: this.gatewayInfo?.modelName ?? null,
      internalIpMasked: mask(this.gatewayInfo?.internalIp),
      gatewayIpMasked: mask(this.gatewayInfo?.gatewayIp),
      retryCount: this.retryCount,
      activeMappingCount: this.activeMappings.length,
      lastErrorCode: this.lastError?.code ?? null,
      recordedAt: this.now(),
    }
  }
}
