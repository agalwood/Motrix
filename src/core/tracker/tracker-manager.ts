import { proxyToFetchUrl } from '@core/proxy/serializers'
import { type EventChannel, Events } from '@shared/protocol/events'
import type { ProxySettings } from '@shared/types/settings'
import type {
  CuratedTrackerList,
  ProxyConfig,
  SourceFetchStatus,
  SyncAndCurateResult,
  SyncResult,
  TrackerHealth,
} from '@shared/types/tracker'
import { trackerLogger } from './logger'
import type { TrackerProber } from './tracker-prober'
import type { TrackerStore } from './tracker-store'
import type { TrackerSyncer } from './tracker-syncer'

const log = trackerLogger('manager')

function buildSourceMap(
  statuses: Array<Record<string, SourceFetchStatus>>
): Record<string, string[]> {
  const result: Record<string, string[]> = {}
  for (const status of statuses) {
    for (const [sourceId, s] of Object.entries(status)) {
      if (!s.urls) continue
      for (const url of s.urls) {
        if (!result[url]) result[url] = []
        if (!result[url].includes(sourceId)) result[url].push(sourceId)
      }
    }
  }
  return result
}

interface RpcClient {
  changeGlobalOption(opts: Record<string, string>): Promise<'OK'>
  changeOption(gid: string, opts: Record<string, string>): Promise<'OK'>
  getOption(gid: string): Promise<Record<string, string>>
  pause(gid: string): Promise<string>
  unpause(gid: string): Promise<string>
  tellStatus(gid: string, keys?: string[]): Promise<{ status: string }>
}

interface EventBus {
  on(channel: EventChannel, listener: (...args: unknown[]) => void): void
  off(channel: EventChannel, listener: (...args: unknown[]) => void): void
  emit(channel: EventChannel, ...args: unknown[]): void
}

export interface TrackerTaskActions {
  pauseTask(taskId: string): Promise<void>
  resumeTask(taskId: string): Promise<void>
}

interface SettingsManager {
  get(): {
    tracker: {
      autoSync: boolean
      syncIntervalHours: number
      sources: {
        id: string
        label: string
        url: string
        builtin: boolean
        enabled: boolean
        cdn: boolean
      }[]
      sourcesEnabled: boolean
      probeEnabled: boolean
      probeTimeoutMs: number
      healthyThresholdMs: number
      minSuccessRate: number
      maxTrackerCount: number
      blacklistEnabled: boolean
      blacklistSources: {
        id: string
        label: string
        url: string
        builtin: boolean
        enabled: boolean
        cdn: boolean
      }[]
    }
  }
  getProxy(): ProxySettings
}

type ProxyUrlResolver = (settings: ProxySettings) => Promise<string | null>

async function resolveProxyUrlWithoutBridge(
  settings: ProxySettings
): Promise<string | null> {
  const proxyUrl = proxyToFetchUrl(settings)
  if (proxyUrl && settings.protocol === 'socks5') {
    throw new Error('SOCKS5 proxy bridge is not configured')
  }
  return proxyUrl
}

export class TrackerManager {
  private curated: CuratedTrackerList = {
    effective: [],
    blacklist: [],
    healthMap: {},
    sourceMap: {},
    lastSyncAt: null,
    lastProbeAt: null,
  }
  private timer: ReturnType<typeof setInterval> | null = null
  private disposed = false
  private initialized = false
  private engineReady = false
  private lifecycleGeneration = 0
  private readonly inFlightTrackerChanges = new Set<Promise<void>>()
  private readonly inFlightCachedStatePushes = new Set<Promise<void>>()
  private stopPromise: Promise<void> | null = null
  private readonly handleEngineRecovered = (): void => {
    this.engineReady = true
    if (!this.initialized || this.disposed) return
    void this.queueCachedStatePush()
  }
  private readonly handleEngineDisconnected = (): void => {
    this.engineReady = false
  }

  constructor(
    private settings: SettingsManager,
    private rpc: RpcClient,
    private eventBus: EventBus,
    private syncer: TrackerSyncer,
    private prober: TrackerProber,
    private store: TrackerStore,
    private taskActions?: TrackerTaskActions,
    private proxyUrlResolver: ProxyUrlResolver = resolveProxyUrlWithoutBridge
  ) {
    this.eventBus.on(Events.EngineRecovered, this.handleEngineRecovered)
    this.eventBus.on(Events.EngineDisconnected, this.handleEngineDisconnected)
  }

  async init(): Promise<void> {
    if (this.disposed) return
    const generation = this.lifecycleGeneration
    const curated = await this.store.load()
    if (!this.isCurrent(generation)) return
    this.curated = curated
    const cfg = this.settings.get().tracker
    log.info(
      {
        loadedEffective: this.curated.effective.length,
        loadedHealth: Object.keys(this.curated.healthMap).length,
        autoSync: cfg.autoSync,
        syncIntervalHours: cfg.syncIntervalHours,
      },
      'init: loaded curated list'
    )
    this.applySyncScheduleChange()

    this.initialized = true
    if (this.engineReady) {
      await this.queueCachedStatePush()
    }
  }

  private queueCachedStatePush(): Promise<void> {
    const operation = this.pushCachedState()
    this.inFlightCachedStatePushes.add(operation)
    void operation.then(
      () => this.inFlightCachedStatePushes.delete(operation),
      () => this.inFlightCachedStatePushes.delete(operation)
    )
    return operation
  }

  private async pushCachedState(): Promise<void> {
    const generation = this.captureGeneration()
    const cfg = this.settings.get().tracker
    const opts: Record<string, string> = {}
    if (cfg.sourcesEnabled && this.curated.effective.length > 0) {
      opts['bt-tracker'] = this.curated.effective.join(',')
    }
    if (cfg.blacklistEnabled && this.curated.blacklist.length > 0) {
      opts['bt-exclude-tracker'] = this.curated.blacklist.join(',')
    }
    if (Object.keys(opts).length > 0) {
      try {
        await this.rpc.changeGlobalOption(opts)
        if (!this.isCurrent(generation)) return
        log.info(
          { opts: Object.keys(opts) },
          'pushed cached state to aria2 after engine became ready'
        )
      } catch (err) {
        if (!this.isCurrent(generation)) return
        log.warn(
          { err },
          'failed to push cached state after engine became ready'
        )
      }
    }
  }

  async syncAndCurate(): Promise<SyncAndCurateResult> {
    const generation = this.captureGeneration()
    const cfg = this.settings.get().tracker
    const totalStart = Date.now()
    log.info(
      {
        sourcesEnabled: cfg.sourcesEnabled,
        enabledSources: cfg.sources.filter((s) => s.enabled).length,
        totalSources: cfg.sources.length,
        blacklistEnabled: cfg.blacklistEnabled,
        probeEnabled: cfg.probeEnabled,
        maxTrackerCount: cfg.maxTrackerCount,
      },
      'syncAndCurate start'
    )

    const proxySettings = this.settings.getProxy()
    const proxyUrl = await this.proxyUrlResolver(proxySettings)
    this.assertCurrent(generation)
    const proxy: ProxyConfig | undefined = proxyUrl
      ? { server: proxyUrl }
      : undefined

    let syncResult: SyncResult = { trackers: [], sourceStatus: {} }
    let healthy: string[] = []
    let healthMap = this.curated.healthMap

    if (cfg.sourcesEnabled) {
      syncResult = await this.syncer.fetch(cfg.sources, proxy)
      this.assertCurrent(generation)

      let healthResults: TrackerHealth[] = []
      if (cfg.probeEnabled && syncResult.trackers.length > 0) {
        healthResults = await this.prober.probe(syncResult.trackers, {
          timeoutMs: cfg.probeTimeoutMs,
          proxy,
          healthyThresholdMs: cfg.healthyThresholdMs,
        })
        this.assertCurrent(generation)
      } else if (cfg.probeEnabled) {
        log.warn('probe skipped: no trackers fetched')
      }

      healthMap = this.store.mergeHealth(this.curated.healthMap, healthResults)

      healthy = cfg.probeEnabled
        ? Object.values(healthMap)
            .filter(
              (h) =>
                h.status !== 'unreachable' &&
                h.successRate >= cfg.minSuccessRate
            )
            .sort(
              (a, b) =>
                (a.lastProbeMs ?? Infinity) - (b.lastProbeMs ?? Infinity)
            )
            .slice(0, cfg.maxTrackerCount)
            .map((h) => h.url)
        : syncResult.trackers.slice(0, cfg.maxTrackerCount)

      if (healthy.length === 0) {
        log.warn(
          {
            totalFetched: syncResult.trackers.length,
            probeEnabled: cfg.probeEnabled,
            minSuccessRate: cfg.minSuccessRate,
          },
          'curated list is empty — check sources, network, or probe threshold'
        )
      }
    } else {
      log.info('source fetch skipped: sourcesEnabled is false')
    }

    let blacklist: string[] = []
    let blacklistSyncResult: SyncResult = { trackers: [], sourceStatus: {} }
    if (cfg.blacklistEnabled && cfg.blacklistSources.length > 0) {
      blacklistSyncResult = await this.syncer.fetch(cfg.blacklistSources, proxy)
      this.assertCurrent(generation)
      blacklist = blacklistSyncResult.trackers
      log.info({ blacklistCount: blacklist.length }, 'blacklist fetched')
    }

    const sourceMap = buildSourceMap([
      syncResult.sourceStatus,
      blacklistSyncResult.sourceStatus,
    ])

    this.curated = {
      effective: healthy,
      blacklist,
      healthMap,
      sourceMap,
      lastSyncAt: Date.now(),
      lastProbeAt:
        cfg.probeEnabled && cfg.sourcesEnabled
          ? Date.now()
          : this.curated.lastProbeAt,
    }

    this.assertCurrent(generation)
    await this.store.save(this.curated)
    this.assertCurrent(generation)

    const globalOpt: Record<string, string> = {
      'bt-tracker': healthy.join(','),
      'bt-exclude-tracker': blacklist.join(','),
    }

    try {
      await this.rpc.changeGlobalOption(globalOpt)
      this.assertCurrent(generation)
      log.info(
        { btTrackerCount: healthy.length, btExcludeCount: blacklist.length },
        'applied to aria2 via changeGlobalOption'
      )
    } catch (err) {
      this.assertCurrent(generation)
      log.warn(
        { err },
        'failed to apply to aria2 — is the engine running? (curated list was still saved)'
      )
      throw err
    }

    this.eventBus.emit(Events.TrackerListUpdated, {
      count: healthy.length,
      lastSyncAt: this.curated.lastSyncAt,
    })

    log.info(
      {
        totalFetched: syncResult.trackers.length,
        totalHealthy: healthy.length,
        totalCurated: healthy.length,
        elapsedMs: Date.now() - totalStart,
      },
      'syncAndCurate done'
    )

    return {
      totalFetched: syncResult.trackers.length,
      totalHealthy: healthy.length,
      totalCurated: healthy.length,
      syncResult,
    }
  }

  getCuratedList(): CuratedTrackerList {
    return this.curated
  }

  setBtTracker(
    taskId: string,
    engineGid: string,
    trackers: string[]
  ): Promise<void> {
    const operation = this.setBtTrackerOwned(taskId, engineGid, trackers)
    this.inFlightTrackerChanges.add(operation)
    void operation.then(
      () => this.inFlightTrackerChanges.delete(operation),
      () => this.inFlightTrackerChanges.delete(operation)
    )
    return operation
  }

  private async setBtTrackerOwned(
    taskId: string,
    engineGid: string,
    trackers: string[]
  ): Promise<void> {
    const generation = this.captureGeneration()
    const status = await this.rpc.tellStatus(engineGid, ['status'])
    this.assertCurrent(generation)
    const isActive = status.status === 'active'

    let shouldResume = false
    try {
      if (isActive) {
        if (!this.taskActions) {
          throw new Error('TrackerManager task actions are not configured')
        }
        // From the moment the pause action starts, this invocation owns the
        // obligation to restore the task's originally-active state. The action
        // can pause the engine before its own persistence/reconciliation
        // settles, so even a rejection or dispose race must attempt resume.
        shouldResume = true
        await this.taskActions.pauseTask(taskId)
        this.assertCurrent(generation)
      }
      await this.rpc.changeOption(engineGid, {
        'bt-tracker': trackers.join(','),
      })
      this.assertCurrent(generation)
    } finally {
      // Do not gate compensation on lifecycle freshness: dispose invalidates
      // publication, but it does not undo the engine pause already accepted by
      // this operation.
      if (shouldResume) {
        await this.taskActions?.resumeTask(taskId)
      }
    }
  }

  async syncBtTracker(
    taskId: string,
    engineGid: string,
    isPrivate: boolean
  ): Promise<void> {
    if (isPrivate) return // never merge global into private torrents

    const generation = this.captureGeneration()
    const opts = await this.rpc.getOption(engineGid)
    this.assertCurrent(generation)
    const effective = (opts['bt-tracker'] ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0)

    const merged = [...new Set([...effective, ...this.curated.effective])]
    await this.setBtTracker(taskId, engineGid, merged)
  }

  async applySourcesChange(enabled: boolean): Promise<void> {
    const generation = this.captureGeneration()
    if (!enabled) {
      await this.rpc.changeGlobalOption({ 'bt-tracker': '' })
      this.assertCurrent(generation)
      log.info('sources disabled — cleared bt-tracker')
      return
    }
    log.info('sources enabled — running syncAndCurate')
    await this.syncAndCurate()
  }

  async applyBlacklistChange(enabled: boolean): Promise<void> {
    const generation = this.captureGeneration()
    if (!enabled) {
      await this.rpc.changeGlobalOption({ 'bt-exclude-tracker': '' })
      this.assertCurrent(generation)
      log.info('blacklist disabled — cleared bt-exclude-tracker')
      return
    }
    log.info('blacklist enabled — running syncAndCurate')
    await this.syncAndCurate()
  }

  invalidateProxyCache(): void {
    // Phase 1: TrackerManager re-reads settings on each operation, so
    // there is no cache to invalidate. The hook exists so that the
    // proxyApplier can call it; future caching can be wired here.
  }

  /**
   * Re-arm (or stop) the periodic sync timer to match current settings.
   * Called at init and whenever autoSync / syncIntervalHours change at
   * runtime — without this the timer keeps its boot-time schedule and keeps
   * firing even after the user turns autoSync off.
   */
  applySyncScheduleChange(): void {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
    if (this.disposed) return
    const generation = this.lifecycleGeneration
    const cfg = this.settings.get().tracker
    if (cfg.autoSync) {
      this.timer = setInterval(() => {
        if (!this.isCurrent(generation)) return
        void this.syncAndCurate().catch((err) => {
          if (this.isCurrent(generation)) {
            log.warn({ err }, 'scheduled tracker sync failed')
          }
        })
      }, cfg.syncIntervalHours * 3600_000)
    }
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.lifecycleGeneration += 1
    this.eventBus.off(Events.EngineRecovered, this.handleEngineRecovered)
    this.eventBus.off(Events.EngineDisconnected, this.handleEngineDisconnected)
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
  }

  stopAndDrain(): Promise<void> {
    if (this.stopPromise) return this.stopPromise
    // Synchronously close admission and invalidate lifecycle publication. Any
    // already-paused setBtTracker operation then runs its unconditional resume
    // compensation before the captured promise settles.
    this.dispose()
    const accepted = [
      ...this.inFlightTrackerChanges,
      ...this.inFlightCachedStatePushes,
    ]
    this.stopPromise = Promise.allSettled(accepted).then(() => undefined)
    return this.stopPromise
  }

  private captureGeneration(): number {
    if (this.disposed) {
      throw new Error('TrackerManager is disposed')
    }
    return this.lifecycleGeneration
  }

  private isCurrent(generation: number): boolean {
    return !this.disposed && this.lifecycleGeneration === generation
  }

  private assertCurrent(generation: number): void {
    if (!this.isCurrent(generation)) {
      throw new Error('TrackerManager is disposed')
    }
  }
}
