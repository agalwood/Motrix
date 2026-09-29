import { createHash, randomUUID } from 'node:crypto'
import { networkInterfaces } from 'node:os'
import type { EngineAdapter } from '@core/engine/engine-adapter'
import { proxyToFetchUrl } from '@core/proxy/serializers'
import type { TaskManager } from '@core/task/task-manager'
import { type EventChannel, Events } from '@shared/protocol/events'
import type { TaskTrackerPlan } from '@shared/schemas/task-tracker'
import {
  TRACKER_HISTORY_MAX_AGE_MS,
  TRACKER_PROBE_FRESH_MS,
  type TrackerState,
  trackerStateSchema,
} from '@shared/schemas/tracker-state'
import type { TrackerSyncStatus } from '@shared/schemas/tracker-sync'
import type { ProxySettings, TrackerSettings } from '@shared/types/settings'
import type {
  CuratedTrackerList,
  ProxyConfig,
  SyncAndCurateResult,
  SyncResult,
} from '@shared/types/tracker'
import { trackerLogger } from './logger'
import type { TaskTrackerRepository } from './task-tracker-repository'
import { TaskTrackerService } from './task-tracker-service'
import type { TrackerProber } from './tracker-prober'
import { selectTrackers, sourceKey } from './tracker-selector'
import { mergeSourceSnapshots } from './tracker-snapshots'
import type { TrackerStore } from './tracker-store'
import { pruneTrackerHealth } from './tracker-store'
import type { TrackerSyncer } from './tracker-syncer'

const log = trackerLogger('manager')
const STARTUP_SYNC_DELAY_MS = 3_000

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
  runTaskMutation?<T>(
    taskIds: readonly string[],
    operation: () => Promise<T>
  ): Promise<T>
  pauseTask(taskId: string): Promise<void>
  resumeTask(taskId: string): Promise<void>
}

interface SettingsManager {
  get(): {
    onboarding: { disclaimerAccepted: boolean }
    tracker: TrackerSettings
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
  private curated: TrackerState = trackerStateSchema.parse({})
  private readonly abort = new AbortController()
  private engineApplyQueue: Promise<void> = Promise.resolve()
  private routeKey: string | undefined
  private failureRetryAt = 0
  private startupCheck = false
  private clockWatch: ReturnType<typeof setInterval> | null = null
  private timer: ReturnType<typeof setTimeout> | null = null
  private syncInFlight: Promise<SyncAndCurateResult> | null = null
  private finishingSync = false
  private syncStatus: TrackerSyncStatus = 'idle'
  private disposed = false
  private initialized = false
  private engineReady = false
  private lifecycleGeneration = 0
  private readonly inFlightTrackerChanges = new Set<Promise<void>>()
  private readonly inFlightCachedStatePushes = new Set<Promise<void>>()
  private taskTrackers?: TaskTrackerService
  private readonly periodicJitterMs = Math.floor(Math.random() * 30_000)
  private stopPromise: Promise<void> | null = null
  private readonly handleEngineRecovered = (): void => {
    this.engineReady = true
    if (!this.initialized || this.disposed) return
    void this.queueCachedStatePush().catch(() => {
      if (!this.disposed) log.warn('failed to persist tracker defaults')
    })
    this.applySyncScheduleChange()
    void this.taskTrackers?.recover()
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

  configureTaskTracking(
    adapter: EngineAdapter,
    tasks: TaskManager,
    repository: TaskTrackerRepository
  ): void {
    if (!this.taskActions) throw new Error('Tracker task actions missing')
    this.taskTrackers = new TaskTrackerService({
      adapter,
      tasks,
      repository,
      actions: this.taskActions,
      selected: () => this.getCuratedList().effective,
    })
    adapter.configureBtTrackerPolicy?.(this.taskTrackers.prepareCreation)
  }

  noteTaskControl(taskId: string, paused: boolean): void {
    this.taskTrackers?.noteTaskControl(taskId, paused)
  }

  getTaskTrackerPlan(
    taskId: string,
    engineGid: string
  ): Promise<TaskTrackerPlan> {
    if (!this.taskTrackers) throw new Error('Task trackers not configured')
    return this.taskTrackers.plan(taskId, engineGid)
  }

  applyTaskTrackerPlan(
    taskId: string,
    engineGid: string,
    fingerprint: string
  ): Promise<void> {
    if (!this.taskTrackers) throw new Error('Task trackers not configured')
    return this.taskTrackers.apply(taskId, engineGid, fingerprint)
  }

  async init(): Promise<void> {
    if (this.disposed) return
    const generation = this.lifecycleGeneration
    const curated = await this.store.load()
    if (!this.isCurrent(generation)) return
    this.curated = trackerStateSchema.parse(curated)
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
    if (curated.version !== 2) {
      for (const kind of ['tracker', 'blacklist'] as const) {
        const sources = kind === 'tracker' ? cfg.sources : cfg.blacklistSources
        for (const source of sources) {
          const urls = Object.entries(curated.sourceMap)
            .filter(([, ids]) => ids.includes(source.id))
            .map(([url]) => url)
          if (!urls.length || curated.lastSyncAt === null) continue
          this.curated.snapshots[sourceKey(kind, source.id)] = {
            id: source.id,
            url: source.url,
            kind,
            urls,
            lastAttemptAt: curated.lastSyncAt,
            lastSuccessAt: curated.lastSyncAt,
            contentChangedAt: curated.lastSyncAt,
            error: null,
            failures: 0,
            nextRetryAt: null,
          }
        }
      }
    }
    this.reselect()
    this.initialized = true
    if (this.engineReady) void this.taskTrackers?.recover()
    this.startupCheck = true
    this.applySyncScheduleChange(true)
    if (this.clockWatch) clearInterval(this.clockWatch)
    let observedAt = Date.now()
    let network = this.networkSignature()
    this.clockWatch = setInterval(() => {
      if (this.engineReady) void this.taskTrackers?.recover()
      const now = Date.now()
      const currentNetwork = this.networkSignature()
      if (
        now < observedAt ||
        now - observedAt > 120_000 ||
        network !== currentNetwork
      )
        this.notifyWake()
      network = currentNetwork
      observedAt = now
    }, 60_000)
    this.clockWatch.unref?.()
    if (this.engineReady) {
      await this.queueCachedStatePush()
    }
  }

  private queueCachedStatePush(): Promise<void> {
    const operation = this.engineApplyQueue
      .catch(() => undefined)
      .then(() => this.pushCachedState())
    this.engineApplyQueue = operation
    this.inFlightCachedStatePushes.add(operation)
    void operation.then(
      () => this.inFlightCachedStatePushes.delete(operation),
      () => this.inFlightCachedStatePushes.delete(operation)
    )
    return operation
  }

  private async pushCachedState(): Promise<void> {
    if (this.disposed || !this.engineReady) return
    const generation = this.captureGeneration()
    this.reselect()
    const revision = this.curated.revision
    try {
      await this.rpc.changeGlobalOption({
        'bt-tracker': this.curated.effective.join(','),
        'bt-exclude-tracker': '',
      })
      if (!this.isCurrent(generation)) return
      if (revision === this.curated.revision)
        this.curated.pendingEngineApply = false
    } catch {
      if (!this.isCurrent(generation)) return
      this.curated.pendingEngineApply = true
      log.warn(
        'failed to apply cached tracker defaults; waiting for engine recovery'
      )
    }
    await this.store.save(this.curated)
  }

  syncAndCurate(
    trigger: 'manual' | 'scheduled' | 'retry' = 'manual'
  ): Promise<SyncAndCurateResult> {
    if (this.syncInFlight) return this.syncInFlight
    this.clearSyncTimer()
    const operation = this.performSyncAndCurate(trigger)
      .catch((error) => {
        if (!this.disposed) {
          this.failureRetryAt = Date.now() + 5 * 60_000
          this.setSyncStatus('failed')
        }
        throw error
      })
      .finally(async () => {
        this.finishingSync = true
        try {
          if (this.disposed) return
          this.applySyncScheduleChange()
          await this.store.save(this.curated)
          if (!this.disposed)
            this.eventBus.emit(Events.TrackerListUpdated, {
              count: this.curated.effective.length,
            })
        } catch (error) {
          if (!this.disposed) this.setSyncStatus('failed')
          throw error
        } finally {
          this.finishingSync = false
          this.syncInFlight = null
        }
      })
    this.syncInFlight = operation
    return operation
  }

  private async performSyncAndCurate(
    trigger: 'manual' | 'scheduled' | 'retry'
  ): Promise<SyncAndCurateResult> {
    const generation = this.captureGeneration()
    const startedAt = Date.now()
    this.setSyncStatus('fetching')
    const cfg = structuredClone(this.settings.get().tracker)
    const proxyUrl = await this.proxyUrlResolver(this.settings.getProxy())
    this.assertCurrent(generation)
    const proxy: ProxyConfig | undefined = proxyUrl
      ? { server: proxyUrl }
      : undefined
    this.routeKey = createHash('sha256')
      .update(proxyUrl ?? 'direct')
      .digest('hex')
      .slice(0, 16)
    this.pruneSnapshots()
    let snapshots = { ...this.curated.snapshots }
    const fetchKind = async (kind: 'tracker' | 'blacklist') => {
      const enabled =
        kind === 'tracker' ? cfg.sourcesEnabled : cfg.blacklistEnabled
      const sources = (
        kind === 'tracker' ? cfg.sources : cfg.blacklistSources
      ).filter(
        (source) =>
          enabled &&
          source.enabled &&
          (trigger !== 'retry' ||
            snapshots[sourceKey(kind, source.id)]?.error != null) &&
          (trigger !== 'scheduled' ||
            (this.startupCheck &&
              !snapshots[sourceKey(kind, source.id)]?.error &&
              Date.now() -
                (snapshots[sourceKey(kind, source.id)]?.lastSuccessAt ?? 0) >=
                30 * 60_000) ||
            this.sourceDueAt(kind, source.id, source.url) <= Date.now())
      )
      if (!sources.length)
        return { trackers: [], sourceStatus: {} } as SyncResult
      const cache = Object.fromEntries(
        sources
          .map((source) => [source.id, snapshots[sourceKey(kind, source.id)]])
          .filter(([, snapshot]) => snapshot)
      )
      const result = await this.syncer.fetch(
        sources,
        proxy,
        cache,
        this.abort.signal
      )
      this.assertCurrent(generation)
      snapshots = mergeSourceSnapshots(
        snapshots,
        sources,
        result.sourceStatus,
        kind,
        Date.now(),
        kind === 'tracker' ? cfg.sources : cfg.blacklistSources
      )
      for (const source of sources) {
        const snapshot = snapshots[sourceKey(kind, source.id)]
        if (snapshot?.error && result.sourceStatus[source.id]?.ok) {
          result.sourceStatus[source.id] = {
            ok: false,
            count: 0,
            elapsedMs: 0,
            failure: snapshot.error,
          }
        }
      }
      return result
    }
    const syncResult = await fetchKind('tracker')
    const blacklistResult = await fetchKind('blacklist')
    this.failureRetryAt = 0
    this.startupCheck = false
    const now = Date.now()
    let selection = selectTrackers({
      settings: this.settings.get().tracker,
      snapshots,
      health: this.curated.healthMap,
      previous: this.curated.effective,
      firstSeen: this.curated.firstSeen,
      now,
      routeKey: this.routeKey,
    })
    let healthMap = this.curated.healthMap
    const current = this.settings.get().tracker
    const probeUrls = current.probeEnabled
      ? selection.candidates
          .filter(
            (c) => c.reason !== 'blacklisted' && c.reason !== 'unsupported'
          )
          .sort(
            (a, b) =>
              (healthMap[a.url]?.lastProbeAt ?? 0) -
                (healthMap[b.url]?.lastProbeAt ?? 0) ||
              a.url.localeCompare(b.url)
          )
          .filter(
            (c) =>
              healthMap[c.url]?.routeKey !== this.routeKey ||
              healthMap[c.url]?.lastProbeAt == null ||
              now - (healthMap[c.url].lastProbeAt ?? 0) >=
                TRACKER_PROBE_FRESH_MS
          )
          .slice(0, 100)
          .map((c) => c.url)
      : []
    if (probeUrls.length) {
      this.setSyncStatus('probing')
      const results = await this.prober.probe(probeUrls, {
        timeoutMs: current.probeTimeoutMs,
        proxy,
        healthyThresholdMs: current.healthyThresholdMs,
        signal: this.abort.signal,
        routeKey: this.routeKey,
      })
      this.assertCurrent(generation)
      healthMap = this.store.mergeHealth(healthMap, results)
    }
    // Re-read settings after IO; late results cannot restore disabled sources.
    selection = selectTrackers({
      settings: this.settings.get().tracker,
      snapshots,
      health: healthMap,
      previous: this.curated.effective,
      firstSeen: selection.firstSeen,
      now: Date.now(),
      routeKey: this.routeKey,
    })
    const statuses = [
      ...Object.values(syncResult.sourceStatus),
      ...Object.values(blacklistResult.sourceStatus),
    ]
    const failed = statuses.filter((status) => !status.ok).length
    const successful = statuses.length - failed
    const enabledSnapshots = (['tracker', 'blacklist'] as const).flatMap(
      (kind) => {
        const settings = this.settings.get().tracker
        if (
          !(kind === 'tracker'
            ? settings.sourcesEnabled
            : settings.blacklistEnabled)
        )
          return []
        return (
          kind === 'tracker' ? settings.sources : settings.blacklistSources
        )
          .filter((source) => source.enabled)
          .map((source) => {
            const snapshot = snapshots[sourceKey(kind, source.id)]
            return snapshot?.url === source.url ? snapshot : undefined
          })
      }
    )
    const allSourcesSucceeded =
      enabledSnapshots.length > 0 &&
      enabledSnapshots.every(
        (snapshot) =>
          snapshot && !snapshot.error && snapshot.lastSuccessAt !== null
      )
    const previous = new Set(this.curated.effective)
    const next = new Set(selection.effective)
    const run = {
      id: randomUUID(),
      trigger,
      startedAt,
      finishedAt: Date.now(),
      outcome:
        failed === 0
          ? ('success' as const)
          : successful
            ? ('partial' as const)
            : ('failed' as const),
      successfulSources: successful,
      failedSources: failed,
      added: [...next].filter((url) => !previous.has(url)).length,
      removed: [...previous].filter((url) => !next.has(url)).length,
      selected: next.size,
    }
    this.setSyncStatus('applying')
    this.curated = {
      ...this.curated,
      version: 2,
      ...selection,
      snapshots,
      healthMap: pruneTrackerHealth(
        healthMap,
        new Set(selection.candidates.map((c) => c.url)),
        Date.now()
      ),
      revision: this.curated.revision + 1,
      history: [run, ...this.curated.history]
        .filter((r) => Date.now() - r.finishedAt <= TRACKER_HISTORY_MAX_AGE_MS)
        .slice(0, 100),
      lastAttemptAt: Date.now(),
      lastSyncAt:
        allSourcesSucceeded && statuses.length
          ? Math.min(
              ...enabledSnapshots.map(
                (snapshot) => snapshot?.lastSuccessAt ?? 0
              )
            )
          : this.curated.lastSyncAt,
      lastProbeAt: probeUrls.length ? Date.now() : this.curated.lastProbeAt,
      pendingEngineApply: true,
    }
    this.pruneSnapshots()
    await this.store.save(this.curated)
    this.assertCurrent(generation)
    await this.queueCachedStatePush()
    this.assertCurrent(generation)
    this.eventBus.emit(Events.TrackerListUpdated, {
      count: this.curated.effective.length,
    })
    this.setSyncStatus(failed ? 'failed' : 'idle')
    return {
      totalFetched: syncResult.trackers.length,
      totalHealthy: selection.effective.length,
      totalCurated: selection.effective.length,
      syncResult,
    }
  }

  private reselect(): void {
    Object.assign(
      this.curated,
      selectTrackers({
        settings: this.settings.get().tracker,
        snapshots: this.curated.snapshots,
        health: this.curated.healthMap,
        previous: this.curated.effective,
        firstSeen: this.curated.firstSeen,
        now: Date.now(),
        routeKey: this.routeKey,
      })
    )
  }

  private pruneSnapshots(): void {
    const cfg = this.settings.get().tracker
    const keys = new Set([
      ...cfg.sources.map((source) => sourceKey('tracker', source.id)),
      ...cfg.blacklistSources.map((source) =>
        sourceKey('blacklist', source.id)
      ),
    ])
    this.curated.snapshots = Object.fromEntries(
      Object.entries(this.curated.snapshots).filter(([key]) => keys.has(key))
    )
    const referenced = new Set([
      ...Object.keys(this.curated.healthMap),
      ...this.curated.candidates.map((c) => c.url),
    ])
    this.curated.firstSeen = Object.fromEntries(
      Object.entries(this.curated.firstSeen).filter(([url]) =>
        referenced.has(url)
      )
    )
  }

  async applySelectionChange(): Promise<void> {
    const generation = this.captureGeneration()
    this.reselect()
    this.curated.revision++
    this.curated.pendingEngineApply = true
    await this.store.save(this.curated)
    this.assertCurrent(generation)
    await this.queueCachedStatePush()
    this.assertCurrent(generation)
    this.eventBus.emit(Events.TrackerListUpdated, {
      count: this.curated.effective.length,
    })
    this.applySyncScheduleChange()
  }

  getCuratedList(): CuratedTrackerList {
    this.reselect()
    return this.curated
  }

  getSyncStatus(): TrackerSyncStatus {
    return this.syncStatus
  }

  private setSyncStatus(status: TrackerSyncStatus): void {
    if (this.syncStatus === status) return
    this.syncStatus = status
    this.eventBus.emit(Events.TrackerSyncStatusChanged)
  }

  setBtTracker(
    taskId: string,
    engineGid: string,
    trackers: string[]
  ): Promise<void> {
    const operation = this.taskTrackers
      ? this.taskTrackers.edit(taskId, engineGid, trackers)
      : this.setBtTrackerOwned(taskId, engineGid, trackers)
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
    if (isPrivate !== false) return // never merge global into private torrents
    if (this.taskTrackers) {
      const plan = await this.taskTrackers.plan(taskId, engineGid)
      await this.taskTrackers.apply(taskId, engineGid, plan.fingerprint)
      return
    }

    const generation = this.captureGeneration()
    const opts = await this.rpc.getOption(engineGid)
    this.assertCurrent(generation)
    const effective = (opts['bt-tracker'] ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0)

    const merged = [
      ...new Set([...effective, ...this.getCuratedList().effective]),
    ]
    await this.setBtTracker(taskId, engineGid, merged)
  }

  async applySourcesChange(enabled: boolean): Promise<void> {
    await this.applySelectionChange()
    if (enabled) await this.syncAndCurate()
  }

  async applyBlacklistChange(enabled: boolean): Promise<void> {
    await this.applySelectionChange()
    if (enabled) await this.syncAndCurate()
  }

  invalidateProxyCache(): void {
    this.routeKey = undefined
    this.reselect()
    this.applySyncScheduleChange(true)
  }

  /** Wake/interface changes share the normal single-flight, debounced schedule. */
  notifyWake(): void {
    if (this.disposed) return
    this.startupCheck = true
    this.applySyncScheduleChange(true)
  }

  private networkSignature(): string {
    return Object.entries(networkInterfaces())
      .flatMap(([name, addresses]) =>
        (addresses ?? [])
          .filter((address) => !address.internal)
          .map((address) => `${name}:${address.family}:${address.address}`)
      )
      .sort()
      .join('|')
  }

  private sourceDueAt(
    kind: 'tracker' | 'blacklist',
    id: string,
    url: string
  ): number {
    const snapshot = this.curated.snapshots[sourceKey(kind, id)]
    if (!snapshot || snapshot.url !== url) return 0
    if ((snapshot.lastAttemptAt ?? 0) > Date.now()) return 0
    return (
      snapshot.nextRetryAt ??
      (snapshot.lastSuccessAt ?? 0) +
        this.settings.get().tracker.syncIntervalHours * 3600_000 +
        this.periodicJitterMs
    )
  }

  /** Recompute the next automatic sync from the persisted cache age. */
  applySyncScheduleChange(startup = false): void {
    const cfg = this.settings.get().tracker
    const now = Date.now()
    const due = (['tracker', 'blacklist'] as const).flatMap((kind) => {
      if (!(kind === 'tracker' ? cfg.sourcesEnabled : cfg.blacklistEnabled))
        return []
      return (kind === 'tracker' ? cfg.sources : cfg.blacklistSources)
        .filter((source) => source.enabled)
        .map((source) => {
          const snapshot = this.curated.snapshots[sourceKey(kind, source.id)]
          const at = this.sourceDueAt(kind, source.id, source.url)
          if (
            startup &&
            !snapshot?.error &&
            now - (snapshot?.lastSuccessAt ?? 0) >= 30 * 60_000
          )
            return now
          return at
        })
    })
    if (!due.length) {
      this.clearSyncTimer()
      return
    }
    const deadline = Math.max(this.failureRetryAt, Math.min(...due))
    this.scheduleSync(Math.max(STARTUP_SYNC_DELAY_MS, deadline - now))
  }

  private clearSyncTimer(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    this.curated.nextCheckAt = null
  }

  private scheduleSync(delayMs: number): void {
    this.clearSyncTimer()
    const settings = this.settings.get()
    if (
      this.disposed ||
      !this.initialized ||
      (this.syncInFlight && !this.finishingSync) ||
      !settings.tracker.autoSync ||
      !settings.onboarding.disclaimerAccepted
    )
      return
    this.curated.nextCheckAt = Date.now() + delayMs
    const generation = this.lifecycleGeneration
    this.timer = setTimeout(() => {
      this.timer = null
      if (
        !this.isCurrent(generation) ||
        !this.settings.get().onboarding.disclaimerAccepted
      )
        return
      if (this.syncInFlight) {
        void this.syncInFlight
          .finally(() => this.applySyncScheduleChange())
          .catch(() => undefined)
        return
      }
      void this.syncAndCurate('scheduled').catch(() => {
        if (this.isCurrent(generation))
          log.warn('scheduled tracker sync failed')
      })
    }, delayMs)
    this.timer.unref?.()
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.abort.abort()
    if (this.clockWatch) clearInterval(this.clockWatch)
    this.clockWatch = null
    this.lifecycleGeneration += 1
    this.eventBus.off(Events.EngineRecovered, this.handleEngineRecovered)
    this.eventBus.off(Events.EngineDisconnected, this.handleEngineDisconnected)
    this.clearSyncTimer()
  }

  stopAndDrain(): Promise<void> {
    if (this.stopPromise) return this.stopPromise
    // Synchronously close admission and invalidate lifecycle publication. Any
    // already-paused setBtTracker operation then runs its unconditional resume
    // compensation before the captured promise settles.
    this.dispose()
    const accepted = [
      this.store.flush?.(),
      this.taskTrackers?.stopAndDrain(),
      ...this.inFlightTrackerChanges,
      ...this.inFlightCachedStatePushes,
      ...(this.syncInFlight ? [this.syncInFlight] : []),
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
