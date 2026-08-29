import path from 'node:path'
import { getLogger } from '@core/logger'
import type { AppliedDownloadProxyPolicy } from '@core/proxy/applied-download-proxy-policy'
import {
  extractAria2ProxyCredentials,
  stripAria2ProxyCredentials,
} from '@core/proxy/aria2-proxy-routing'
import type { ProxyBridgeResolver } from '@core/proxy/proxy-bridge-manager'
import type { Aria2ProxyOptions } from '@core/proxy/serializers'
import { ENGINE_RPC_PORT } from '@shared/constants'
import { AppError, ErrorCode } from '@shared/errors'
import { Events } from '@shared/protocol/events'
import {
  type EngineCompatibilityWarningPayload,
  type EngineDiagnosticReport,
  type EngineFailureInfo,
  type EngineFailurePayload,
  EngineFailureReason,
  type EngineFeatureReport,
  EngineProcessOwnership,
  EngineRecoveryAction,
  EngineRecoveryRecommendation,
  type EngineRecoveryRequest,
  type EngineRecoveryResult,
  EngineState,
  type EngineStatusSnapshot,
} from '@shared/types/engine'
import type { EngineSettings } from '@shared/types/settings'
import type { EventBus } from '../events/event-bus'
import { probePrecise } from '../probe/disk-probe'
import type { SettingsManager } from '../settings/settings-manager'
import type { Aria2Adapter } from './aria2/aria2-adapter'
import type { Aria2ConfigBuilder } from './aria2/aria2-config-builder'
import type { Aria2ProcessManager } from './aria2/aria2-process-manager'
import type { Aria2RpcClient } from './aria2/aria2-rpc-client'
import { isSqliteCorruptionDiagnostic } from './aria2/aria2-sqlite-recovery'
import type { Aria2TrustStore } from './aria2/aria2-trust-store'
import { recommend } from './aria2/aria2-tuning'
import {
  isMotrixFork,
  STANDARD_ARIA2_CONNECTION_LIMIT,
} from './aria2/feature-report'
import type { DirectResourceMetadataProfile } from './engine-adapter'
import { checkPort, findAvailablePort } from './port-check'

const log = getLogger('engine')

/** How long task creation waits for the aria2 engine to become Ready
 *  before failing. Engine cold start = process spawn + RPC connect retry
 *  loop (~5s); 15s is a safe margin that still bounds a stuck engine. */
export const ENGINE_READY_TIMEOUT_MS = 15_000

const BACKOFF_BASE = 1_000
const BACKOFF_MAX = 30_000
const MAX_RESTARTS = 5
const HEALTH_CHECK_INTERVAL = 30_000
const MAX_CONSECUTIVE_FAILURES = 3

function sameProxyOptions(
  left: Aria2ProxyOptions | null,
  right: Aria2ProxyOptions | null
): boolean {
  if (left === null || right === null) return left === right
  return left.allProxy === right.allProxy && left.noProxy === right.noProxy
}

const HOT_ENGINE_OPTIONS = {
  maxConcurrentDownloads: 'max-concurrent-downloads',
  maxConnectionPerServer: 'max-connection-per-server',
  split: 'split',
  minSplitSize: 'min-split-size',
  userAgent: 'user-agent',
  connectTimeout: 'connect-timeout',
  socketTimeout: 'timeout',
  maxTries: 'max-tries',
  retryWait: 'retry-wait',
  lowestSpeedLimit: 'lowest-speed-limit',
  btMaxPeers: 'bt-max-peers',
  btEnableLpd: 'bt-enable-lpd',
  seedRatio: 'seed-ratio',
  seedTime: 'seed-time',
  remoteTime: 'remote-time',
} as const satisfies Partial<Record<keyof EngineSettings, string>>

function getBackoffDelay(attempt: number): number {
  return Math.min(BACKOFF_BASE * 2 ** attempt, BACKOFF_MAX)
}

export class EngineSupervisor {
  private state: EngineState = EngineState.Stopped
  private featureReport: EngineFeatureReport | null = null
  private getEffectiveLimits:
    | (() => { download: number; upload: number })
    | null = null
  private binaryPath: string | null = null
  private restartAttempts = 0
  private healthCheckTimer: ReturnType<typeof setInterval> | null = null
  private consecutiveFailures = 0
  private restartTimer: ReturnType<typeof setTimeout> | null = null
  private stopping = false
  private suppressExitHandling = false
  private lastError: string | null = null
  private failure: EngineFailureInfo | null = null
  private lastStartArgs: string[] = []
  // Monotonic per-instance counter for EngineFailurePayload.incidentId.
  // Resets to 0 on every new EngineSupervisor (i.e. every boot) — it is
  // deliberately NOT persisted or derived from anything durable.
  private failureSeq = 0
  private sqliteFallbackActive = false
  private sqliteFallbackAttempted = false
  private restartPromise: Promise<void> | null = null

  constructor(
    private eventBus: EventBus,
    private settingsManager: SettingsManager,
    private processManager: Aria2ProcessManager,
    private configBuilder: Aria2ConfigBuilder,
    private trustStore: Aria2TrustStore,
    private rpcClient: Aria2RpcClient,
    private adapter: Aria2Adapter,
    private proxyBridge: Pick<ProxyBridgeResolver, 'resolveForDownload'>,
    private appliedDownloadProxyPolicy?: Pick<
      AppliedDownloadProxyPolicy,
      'commit' | 'markUnavailable'
    > &
      Partial<Pick<AppliedDownloadProxyPolicy, 'publishStartupRoute'>>
  ) {
    // Wire up process exit handler
    this.processManager.onExit = (code, _signal) => {
      if (this.stopping || this.suppressExitHandling) return
      if (this.state === EngineState.Ready) {
        this.handleUnexpectedExit(code)
      }
    }
  }

  getState(): EngineState {
    return this.state
  }

  getFeatureReport(): EngineFeatureReport | null {
    return this.featureReport
  }

  getLastError(): string | null {
    return this.lastError
  }

  getStatus(): EngineStatusSnapshot {
    return {
      state: this.state,
      featureReport: this.featureReport,
      failure: this.failure,
      managedPid: this.processManager.isRunning()
        ? this.processManager.getPid()
        : null,
    }
  }

  async start(binaryPath: string): Promise<void> {
    this.stopping = false
    this.binaryPath = binaryPath
    this.restartAttempts = 0
    this.sqliteFallbackActive = false
    this.sqliteFallbackAttempted = false
    await this.doStart()
  }

  restart(): Promise<void> {
    if (this.restartPromise) return this.restartPromise
    if (!this.binaryPath) {
      return Promise.reject(
        new Error('EngineSupervisor.restart called before start')
      )
    }
    const path = this.binaryPath
    const restartPromise = this.performRestart(path).finally(() => {
      if (this.restartPromise === restartPromise) {
        this.restartPromise = null
      }
    })
    this.restartPromise = restartPromise
    return restartPromise
  }

  private async performRestart(path: string): Promise<void> {
    await this.stop()
    await this.start(path)
  }

  setEffectiveLimitsProvider(
    fn: () => { download: number; upload: number }
  ): void {
    this.getEffectiveLimits = fn
  }

  /**
   * HOT-update the aria2 speed limits via `aria2.changeGlobalOption`. No-op
   * when the engine is not Ready (cold start picks up limits via `buildArgs`).
   */
  async applySpeedLimits(limits: {
    download: number
    upload: number
  }): Promise<void> {
    if (this.state !== EngineState.Ready) return
    await this.rpcClient.changeGlobalOption({
      'max-overall-download-limit': String(limits.download),
      'max-overall-upload-limit': String(limits.upload),
    })
  }

  /**
   * HOT-update the aria2 DNS resolver via `aria2.changeGlobalOption`.
   * No-op when the engine is not Ready (cold start picks up the value via
   * `buildArgs`). Applies to new and waiting downloads only — active
   * downloads keep the resolver they started with.
   */
  async applyAsyncDns(asyncDns: boolean): Promise<void> {
    if (this.state !== EngineState.Ready) return
    await this.rpcClient.changeGlobalOption({
      'async-dns': String(asyncDns),
    })
  }

  /**
   * HOT-update the default directory inherited by downloads created directly
   * through aria2 JSON-RPC. Motrix-owned task creation continues to pass its
   * selected directory per task.
   */
  async applyDefaultSaveDir(dir: string): Promise<void> {
    if (this.state !== EngineState.Ready) return
    await this.rpcClient.changeGlobalOption({ dir })
  }

  /** HOT-update changed runtime engine settings without restarting aria2. */
  async applyEngineSettings(
    previous: EngineSettings,
    next: EngineSettings
  ): Promise<void> {
    const persistedNext = await this.persistCompatibilityLimits(next)
    if (this.state !== EngineState.Ready) return

    const compatiblePrevious = this.applyCompatibilityLimits(previous)
    const compatibleNext = this.applyCompatibilityLimits(persistedNext)
    const params: Record<string, string> = {}
    for (const [key, option] of Object.entries(HOT_ENGINE_OPTIONS) as Array<
      [keyof typeof HOT_ENGINE_OPTIONS, string]
    >) {
      if (compatiblePrevious[key] !== compatibleNext[key]) {
        params[option] = String(compatibleNext[key])
      }
    }
    if (Object.keys(params).length === 0) return
    await this.rpcClient.changeGlobalOption(params)
  }

  private applyCompatibilityLimits(settings: EngineSettings): EngineSettings {
    const report = this.featureReport
    if (!report || isMotrixFork(report)) return settings

    return {
      ...settings,
      maxConnectionPerServer: Math.min(
        settings.maxConnectionPerServer,
        STANDARD_ARIA2_CONNECTION_LIMIT
      ),
      split: Math.min(settings.split, STANDARD_ARIA2_CONNECTION_LIMIT),
    }
  }

  private async persistCompatibilityLimits(
    settings: EngineSettings
  ): Promise<EngineSettings> {
    const compatible = this.applyCompatibilityLimits(settings)
    if (
      compatible.maxConnectionPerServer === settings.maxConnectionPerServer &&
      compatible.split === settings.split
    ) {
      return settings
    }

    const persisted: EngineSettings = {
      ...compatible,
      // Named profiles re-apply their fixed values during validation. Move
      // the adjusted settings to custom so 16 remains the durable truth.
      performanceProfile: 'custom',
    }
    try {
      await this.settingsManager.update({
        engine: {
          performanceProfile: persisted.performanceProfile,
          maxConnectionPerServer: persisted.maxConnectionPerServer,
          split: persisted.split,
        },
      })
    } catch (error) {
      // A settings write failure must not revive the original startup crash.
      // The in-memory compatibility values still let this engine run safely.
      log.warn(
        { err: error },
        'failed to persist aria2 compatibility limits; using runtime limits'
      )
      return compatible
    }
    return persisted
  }

  private async resolveRuntimeEngineSettings(
    settings: EngineSettings
  ): Promise<EngineSettings> {
    if (settings.performanceProfile !== 'auto') return settings

    const downloadPath = this.settingsManager.getApp().defaultSaveDir
    try {
      const probe = await probePrecise(downloadPath)
      const tuning = recommend(probe, null)
      return {
        ...settings,
        diskCache: tuning.diskCache,
        split: tuning.split,
        minSplitSize: tuning.minSplitSize,
      }
    } catch (error) {
      log.warn(
        { err: error, downloadPath },
        'automatic performance probe failed; using profile defaults'
      )
      return settings
    }
  }

  /**
   * HOT-update the aria2 proxy via `aria2.changeGlobalOption`. No-op when
   * the engine is not Ready (cold start picks up proxy via `buildArgs`).
   * Pass `null` to clear the proxy (sends empty strings, which aria2
   * treats as "no proxy" at runtime).
   */
  async applyProxyChange(
    opts: { allProxy: string; noProxy: string } | null
  ): Promise<boolean> {
    if (this.state !== EngineState.Ready) return false
    await this.writeGlobalProxyOptions(opts)
    return true
  }

  private async writeGlobalProxyOptions(
    opts: Aria2ProxyOptions | null
  ): Promise<void> {
    const proxyCredentials = opts
      ? extractAria2ProxyCredentials(opts.allProxy)
      : { username: '', password: '' }
    const proxyEndpoint = opts ? stripAria2ProxyCredentials(opts.allProxy) : ''
    if (!proxyCredentials || proxyEndpoint === null) {
      throw new TypeError('Unsupported aria2 proxy credentials')
    }
    const params = {
      'all-proxy': proxyEndpoint,
      'http-proxy': '',
      'http-proxy-user': '',
      'http-proxy-passwd': '',
      'https-proxy': '',
      'https-proxy-user': '',
      'https-proxy-passwd': '',
      'ftp-proxy': '',
      'ftp-proxy-user': '',
      'ftp-proxy-passwd': '',
      'all-proxy-user': proxyCredentials.username,
      'all-proxy-passwd': proxyCredentials.password,
      'no-proxy': opts?.noProxy ?? '',
      'proxy-method': 'get',
    }
    await this.rpcClient.changeGlobalOption(params)
  }

  /**
   * Synchronously fence process-exit handling before asynchronous app cleanup.
   * Windows can terminate child processes as soon as session end begins, so
   * waiting until stop() reaches gracefulStop() can misclassify that expected
   * exit as an engine crash.
   */
  prepareForShutdown(): void {
    this.stopping = true
    this.stopHealthCheck()
    this.clearRestartTimer()
  }

  async stop(): Promise<void> {
    this.prepareForShutdown()

    if (this.processManager.isRunning()) {
      // SIGTERM aria2 directly. Its signal handler sets
      // globalHaltRequested, afterEachIteration() calls requestHalt(), the
      // run loop exits, onEndOfRun() flushes piece progress to the SQLite
      // DB (WAL fsync) and getResult() writes the final session — both the
      // text backend (--save-session=) and the DB backend
      // (--enable-sqlite3-persistence=true) when configured.
      //
      // We do NOT call aria2.shutdown (adds 3s scheduling delay; SIGTERM
      // is equivalent and immediate). We do NOT preemptively call
      // saveSession either — the signal handler covers both backends and
      // calling it from here would race the run-loop teardown.
      //
      // Timeout is 30s, up from 5s, to cover SQLite WAL commit + fsync
      // for the active task table on large queues.
      await this.processManager.gracefulStop(30_000)
    }
    this.rpcClient.disconnect()

    this.setState(EngineState.Stopped)
    // NOTE: stopping stays true — prevents doStart() from spawning a new
    // process after stop() returns but before the Electron process exits.
    // It is reset in start() when the engine is explicitly restarted.
  }

  private async doStart(): Promise<void> {
    if (!this.binaryPath || this.stopping) return

    this.setState(EngineState.Starting)
    this.lastError = null
    this.failure = null

    let phase: 'probe' | 'config' | 'spawn' | 'rpc' = 'probe'
    let engineSettings: EngineSettings | null = null

    try {
      const featureReport = await this.processManager.probe(this.binaryPath)
      if (this.stopping) return

      this.featureReport = featureReport
      // The adapter's durable-remove trust gate reads its own featureReport,
      // and nothing calls adapter.connect() in production — inject the report
      // we just probed so the gate reflects the real engine version.
      this.adapter.setFeatureReport(featureReport)
      if (!isMotrixFork(featureReport)) {
        const payload: EngineCompatibilityWarningPayload = {
          version: featureReport.version,
          connectionLimit: STANDARD_ARIA2_CONNECTION_LIMIT,
        }
        this.eventBus.emit(Events.EngineCompatibilityWarning, payload)
      }

      // Step 2: Ensure config and build args
      phase = 'config'
      await this.configBuilder.ensureUserConfig()
      if (this.stopping) return
      const processEnv = await this.trustStore.prepareEnvironment()
      if (this.stopping) return

      const configuredEngineSettings = this.settingsManager.getEngine()
      const resolvedEngineSettings = this.applyCompatibilityLimits(
        await this.resolveRuntimeEngineSettings(
          await this.persistCompatibilityLimits(configuredEngineSettings)
        )
      )
      engineSettings = this.sqliteFallbackActive
        ? { ...resolvedEngineSettings, sqlite3Persistence: false }
        : resolvedEngineSettings
      // Aria2RpcClient is long-lived and caches its credential. Refresh it on
      // every start so an explicit settings rotation authenticates the first
      // RPC sent to the newly spawned aria2 process.
      this.rpcClient.setSecret(engineSettings.rpcSecret)
      const configuredProxy = structuredClone(this.settingsManager.getProxy())
      const resolvedProxy =
        await this.proxyBridge.resolveForDownload(configuredProxy)
      if (this.stopping) return
      const defaultSaveDir = this.settingsManager.getApp().defaultSaveDir
      // Provider is wired by the shell (Task 8) before start() in production;
      // the { 0, 0 } (unlimited) fallback only fires in tests or if start()
      // runs before the controller attaches.
      const effective = this.getEffectiveLimits?.() ?? {
        download: 0,
        upload: 0,
      }
      const sqliteActive =
        featureReport.hasSqlitePersistence &&
        engineSettings.sqlite3Persistence === true
      const loadTextSession =
        !sqliteActive && (await this.configBuilder.hasSavedSession())
      if (this.stopping) return
      log.debug(
        {
          rpcPort: engineSettings.rpcPort,
          rpcSecretLength: engineSettings.rpcSecret.length,
        },
        'preparing aria2 RPC configuration'
      )
      const args = this.configBuilder.buildArgs(
        engineSettings,
        featureReport.hasSqlitePersistence,
        resolvedProxy,
        effective,
        defaultSaveDir,
        loadTextSession
      )
      this.lastStartArgs = args

      // Step 3: Port check
      const portAvailable = await checkPort(engineSettings.rpcPort)
      if (!portAvailable) {
        const processInfo = await this.processManager.inspectPort(
          engineSettings.rpcPort,
          { binaryPath: this.binaryPath, args }
        )
        this.recordFailure(
          EngineFailureReason.PortInUse,
          `RPC port ${engineSettings.rpcPort} is already in use`
        )
        this.eventBus.emit(Events.PortConflict, {
          port: engineSettings.rpcPort,
          process: processInfo,
        })
        this.setState(EngineState.Failed)
        return
      }

      // Step 4: Spawn process (abort if stop() was called during earlier awaits)
      if (this.stopping) return
      phase = 'spawn'
      await this.processManager.spawn(this.binaryPath, args, processEnv)

      // Step 5: Connect RPC
      if (this.stopping) {
        await this.processManager.gracefulStop()
        return
      }
      phase = 'rpc'
      await this.rpcClient.connect(engineSettings.rpcPort)
      if (this.stopping) {
        this.rpcClient.disconnect()
        await this.processManager.gracefulStop()
        return
      }
      // Raw JSON-RPC clients commonly omit per-task options. Seed the global
      // template so their new HTTP/FTP tasks retain aria2's historical Motrix
      // resume behavior. Motrix-owned recovery still overrides `continue`
      // explicitly per task where safety requires it.
      await this.rpcClient.changeGlobalOption({ continue: 'true' })
      // Inspect only a sanitized compatibility decision. Raw global options
      // can contain passwords, custom headers and cookie paths and must never
      // be cached on the adapter or published to task composition.
      let pendingMetadataProfile: DirectResourceMetadataProfile | null = null
      try {
        pendingMetadataProfile =
          typeof this.adapter.inspectDirectResourceMetadataProfile ===
          'function'
            ? await this.adapter.inspectDirectResourceMetadataProfile()
            : null
      } catch (error) {
        log.debug(
          { err: error },
          'aria2 HTTP metadata request profile inspection failed closed'
        )
      }

      // Step 6: Ready
      if (this.stopping) {
        this.rpcClient.disconnect()
        await this.processManager.gracefulStop()
        return
      }
      const publishReady = () => {
        this.adapter.setDirectResourceMetadataProfile?.(pendingMetadataProfile)
        this.setState(EngineState.Ready)
      }
      if (this.appliedDownloadProxyPolicy?.publishStartupRoute) {
        const published =
          await this.appliedDownloadProxyPolicy.publishStartupRoute(
            async () => {
              // A proxy update can be persisted after buildArgs() captured its
              // startup route but before aria2 connects. Re-resolve under the
              // policy writer and repair aria2 before publishing Ready.
              const latestConfiguredProxy = structuredClone(
                this.settingsManager.getProxy()
              )
              const latestResolvedProxy =
                await this.proxyBridge.resolveForDownload(latestConfiguredProxy)
              if (!sameProxyOptions(resolvedProxy, latestResolvedProxy)) {
                await this.writeGlobalProxyOptions(latestResolvedProxy)
              }
              return latestResolvedProxy
            },
            publishReady,
            () => !this.stopping
          )
        if (!published) return
      } else {
        this.appliedDownloadProxyPolicy?.commit(resolvedProxy)
        publishReady()
      }
      this.lastError = null
      this.failure = null
      this.restartAttempts = 0
      this.consecutiveFailures = 0
      this.startHealthCheck()
    } catch (err) {
      this.lastError = err instanceof Error ? err.message : String(err)
      const stderr = this.processManager.getRecentStderr?.() ?? ''

      // A process can be alive even though RPC connection failed. Always
      // tear down a process spawned by this supervisor before entering Failed;
      // otherwise stop() used to skip it and leave aria2 holding the port.
      if (this.processManager.isRunning()) {
        this.suppressExitHandling = true
        try {
          await this.processManager.gracefulStop(5_000)
        } catch (cleanupError) {
          log.warn({ err: cleanupError }, 'failed-start cleanup failed')
        } finally {
          this.suppressExitHandling = false
        }
      }
      this.rpcClient.disconnect()

      if (
        engineSettings &&
        (await this.tryActivateSqliteFallback(
          engineSettings,
          `${this.lastError}\n${stderr}`
        ))
      ) {
        this.setState(EngineState.Restarting)
        await this.doStart()
        return
      }

      const reason =
        phase === 'probe'
          ? EngineFailureReason.BinaryUnavailable
          : phase === 'spawn'
            ? EngineFailureReason.SpawnFailed
            : phase === 'rpc'
              ? EngineFailureReason.RpcUnavailable
              : EngineFailureReason.Unknown
      this.recordFailure(reason, this.lastError)
      log.error({ err: this.lastError }, 'start failed')
      this.setState(EngineState.Failed)
    }
  }

  private async tryActivateSqliteFallback(
    settings: EngineSettings,
    diagnostic: string
  ): Promise<boolean> {
    if (
      this.sqliteFallbackAttempted ||
      this.sqliteFallbackActive ||
      !this.featureReport?.hasSqlitePersistence ||
      !settings.sqlite3Persistence ||
      !isSqliteCorruptionDiagnostic(diagnostic)
    ) {
      return false
    }

    this.sqliteFallbackAttempted = true
    let quarantine: Awaited<
      ReturnType<Aria2ConfigBuilder['quarantineSqliteDatabase']>
    > | null = null
    try {
      quarantine = await this.configBuilder.quarantineSqliteDatabase(settings)
    } catch (error) {
      // Disabling the backend still gives the text session a chance to start.
      // Keep the original database untouched if the recoverable move failed.
      log.warn({ err: error }, 'failed to quarantine corrupt aria2 database')
    }

    this.sqliteFallbackActive = true
    try {
      await this.settingsManager.update({
        engine: { sqlite3Persistence: false },
      })
    } catch (error) {
      log.warn(
        { err: error },
        'failed to persist aria2 SQLite fallback setting; using runtime fallback'
      )
    }
    log.warn(
      {
        databasePath: quarantine?.databasePath,
        quarantinePaths: quarantine?.moved,
        textSessionAvailable: await this.configBuilder.hasSavedSession(),
      },
      'corrupt aria2 SQLite persistence quarantined; retrying with text session'
    )
    return true
  }

  private handleUnexpectedExit(code: number | null): void {
    this.stopHealthCheck()
    this.recordFailure(
      EngineFailureReason.UnexpectedExit,
      code === null
        ? 'aria2 exited unexpectedly'
        : `aria2 exited unexpectedly with code ${code}`
    )
    this.restartWithBackoff()
  }

  private restartWithBackoff(): void {
    if (this.restartAttempts >= MAX_RESTARTS) {
      if (!this.failure) {
        this.recordFailure(
          EngineFailureReason.Unknown,
          'aria2 restart attempts were exhausted'
        )
      }
      this.setState(EngineState.Failed)
      return
    }

    this.setState(EngineState.Restarting)
    const delay = getBackoffDelay(this.restartAttempts)
    this.restartAttempts++

    this.restartTimer = setTimeout(async () => {
      if (this.processManager.isRunning()) {
        this.suppressExitHandling = true
        try {
          await this.processManager.gracefulStop(5_000)
        } finally {
          this.suppressExitHandling = false
        }
      }
      this.rpcClient.disconnect()
      await this.doStart()
    }, delay)
  }

  private startHealthCheck(): void {
    this.consecutiveFailures = 0
    this.healthCheckTimer = setInterval(async () => {
      if (this.state !== EngineState.Ready) return

      try {
        await this.rpcClient.getVersion()
        this.consecutiveFailures = 0
      } catch {
        this.consecutiveFailures++
        if (this.consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
          this.stopHealthCheck()
          this.recordFailure(
            EngineFailureReason.HealthCheckFailed,
            'aria2 stopped responding to health checks'
          )
          this.restartWithBackoff()
        }
      }
    }, HEALTH_CHECK_INTERVAL)
  }

  private stopHealthCheck(): void {
    if (this.healthCheckTimer !== null) {
      clearInterval(this.healthCheckTimer)
      this.healthCheckTimer = null
    }
  }

  private clearRestartTimer(): void {
    if (this.restartTimer !== null) {
      clearTimeout(this.restartTimer)
      this.restartTimer = null
    }
  }

  private setState(newState: EngineState): void {
    const prev = this.state
    if (prev === newState) return
    this.state = newState

    if (newState !== EngineState.Ready) {
      this.adapter.setDirectResourceMetadataProfile?.(null)
      this.appliedDownloadProxyPolicy?.markUnavailable()
    }

    this.eventBus.emit(Events.EngineStateChanged, newState)

    if (prev === EngineState.Ready && newState !== EngineState.Ready) {
      this.eventBus.emit(Events.EngineDisconnected)
    }
    if (prev !== EngineState.Ready && newState === EngineState.Ready) {
      this.eventBus.emit(Events.EngineRecovered)
    }
  }

  async diagnose(): Promise<EngineDiagnosticReport> {
    const binaryPath = this.binaryPath
    const engineSettings = this.settingsManager.getEngine()
    let binaryAvailable = false
    let binaryVersion: string | null = null

    if (binaryPath) {
      try {
        const report = await this.processManager.probe(binaryPath)
        binaryAvailable = true
        binaryVersion = report.version
      } catch {
        // The report below carries the failed binary check.
      }
    }

    const portAvailable = await checkPort(engineSettings.rpcPort)
    const expected = this.expectedProcess()
    let processInfo =
      !portAvailable && expected
        ? await this.processManager.inspectPort(
            engineSettings.rpcPort,
            expected
          )
        : null
    if (
      !processInfo &&
      this.state === EngineState.Ready &&
      this.processManager.isRunning() &&
      this.processManager.getPid() !== null
    ) {
      processInfo = {
        // Checked above; the non-null assertion only bridges TS narrowing
        // across the second method call.
        pid: this.processManager.getPid() as number,
        name: binaryPath ? path.basename(binaryPath) : 'aria2c',
        executableName: binaryPath ? path.basename(binaryPath) : null,
        ownership: EngineProcessOwnership.CurrentApp,
        safeToTerminate: true,
      }
    }
    const expectedListener =
      this.state === EngineState.Ready &&
      processInfo?.ownership === EngineProcessOwnership.CurrentApp
    const canForceTerminate =
      this.state !== EngineState.Ready && Boolean(processInfo?.safeToTerminate)
    const canSwitchPort =
      this.state !== EngineState.Ready && !portAvailable && !canForceTerminate
    const canRetry =
      this.state !== EngineState.Ready && binaryAvailable && portAvailable
    const suggestedRpcPort = canSwitchPort
      ? await findAvailablePort(engineSettings.rpcPort + 1)
      : null
    const defaultRpcIsCurrent = engineSettings.rpcPort === ENGINE_RPC_PORT
    const defaultRpcAvailable = defaultRpcIsCurrent
      ? portAvailable
      : await checkPort(ENGINE_RPC_PORT)
    const defaultRpcProcess =
      !defaultRpcIsCurrent && !defaultRpcAvailable && expected
        ? await this.processManager.inspectPort(ENGINE_RPC_PORT, expected)
        : defaultRpcIsCurrent
          ? processInfo
          : null
    const defaultRpcRequiresTermination = Boolean(
      defaultRpcProcess?.safeToTerminate
    )
    const recommendation =
      this.state === EngineState.Ready
        ? EngineRecoveryRecommendation.None
        : canForceTerminate
          ? EngineRecoveryRecommendation.ForceTerminate
          : canSwitchPort
            ? EngineRecoveryRecommendation.SwitchPort
            : canRetry
              ? EngineRecoveryRecommendation.Retry
              : EngineRecoveryRecommendation.None

    return {
      ...this.getStatus(),
      generatedAt: Date.now(),
      binary: {
        name: binaryPath ? path.basename(binaryPath) : 'aria2c',
        available: binaryAvailable,
        version: binaryVersion,
      },
      rpc: {
        port: engineSettings.rpcPort,
        available: portAvailable,
        expectedListener,
      },
      process: processInfo,
      defaultRpc: {
        port: ENGINE_RPC_PORT,
        isCurrent: defaultRpcIsCurrent,
        available: defaultRpcAvailable,
        process: defaultRpcProcess,
        canRestore:
          !defaultRpcIsCurrent &&
          (defaultRpcAvailable || defaultRpcRequiresTermination),
        requiresTermination: defaultRpcRequiresTermination,
      },
      suggestedRpcPort,
      canRetry,
      canForceTerminate,
      canSwitchPort: canSwitchPort && suggestedRpcPort !== null,
      recommendation,
    }
  }

  async recover(request: EngineRecoveryRequest): Promise<EngineRecoveryResult> {
    if (!this.binaryPath) {
      throw new AppError(
        ErrorCode.EngineStartFailed,
        'Engine recovery is unavailable before the first start attempt'
      )
    }

    const previousRpcPort = this.settingsManager.getEngine().rpcPort

    if (
      request.action === EngineRecoveryAction.RestoreDefaultPort &&
      previousRpcPort === ENGINE_RPC_PORT
    ) {
      return {
        ok: this.state === EngineState.Ready,
        previousRpcPort,
        rpcPort: previousRpcPort,
        status: this.getStatus(),
      }
    }

    if (request.action === EngineRecoveryAction.ForceTerminate) {
      const expected = this.expectedProcess()
      if (!expected || request.expectedPid === undefined) {
        throw new AppError(
          ErrorCode.EngineProcessOwnershipUnverified,
          'A verified aria2 process is required for force termination'
        )
      }
      await this.processManager.forceTerminateVerified(
        request.expectedPid,
        previousRpcPort,
        expected
      )
    }

    if (request.action === EngineRecoveryAction.SwitchPort) {
      const nextPort = await findAvailablePort(previousRpcPort + 1)
      if (nextPort === null) {
        throw new AppError(
          ErrorCode.EngineStartFailed,
          'No available RPC port was found'
        )
      }
      await this.settingsManager.update({ engine: { rpcPort: nextPort } })
    }

    if (request.action === EngineRecoveryAction.RestoreDefaultPort) {
      const defaultPortAvailable = await checkPort(ENGINE_RPC_PORT)
      if (!defaultPortAvailable) {
        const expected = this.expectedProcess()
        const processInfo = expected
          ? await this.processManager.inspectPort(ENGINE_RPC_PORT, expected)
          : null
        if (
          !expected ||
          !processInfo?.safeToTerminate ||
          request.expectedPid !== processInfo.pid
        ) {
          throw new AppError(
            ErrorCode.EngineProcessOwnershipUnverified,
            `Port ${ENGINE_RPC_PORT} is occupied by a process that Motrix cannot safely terminate`
          )
        }
        await this.processManager.forceTerminateVerified(
          processInfo.pid,
          ENGINE_RPC_PORT,
          expected
        )
      }
      await this.settingsManager.update({
        engine: { rpcPort: ENGINE_RPC_PORT },
      })
    }

    await this.restart()
    const rpcPort = this.settingsManager.getEngine().rpcPort
    return {
      ok: this.state === EngineState.Ready,
      previousRpcPort,
      rpcPort,
      status: this.getStatus(),
    }
  }

  private expectedProcess(): { binaryPath: string; args: string[] } | null {
    if (!this.binaryPath || this.lastStartArgs.length === 0) return null
    return { binaryPath: this.binaryPath, args: this.lastStartArgs }
  }

  private recordFailure(
    reason: EngineFailureReason,
    technicalMessage: string | null
  ): void {
    this.lastError = technicalMessage
    const occurredAt = Date.now()
    this.failure = {
      reason,
      occurredAt,
      technicalMessage,
    }
    const payload: EngineFailurePayload = {
      incidentId: `engine:${occurredAt}:${this.failureSeq++}`,
      reason,
      occurredAt,
      technicalMessage,
    }
    this.eventBus.emit(Events.EngineFailureOccurred, payload)
  }

  /**
   * Resolve once the engine is (or becomes) Ready; reject on Failed or after
   * `timeoutMs`. Used to gate task creation so cold-start requests wait for
   * the engine instead of hitting a not-yet-connected RPC socket. Always
   * removes its listener and clears its timer on settle.
   */
  async waitUntilReady(timeoutMs: number): Promise<void> {
    if (this.state === EngineState.Ready) return
    return new Promise<void>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout>
      const onState = (...args: unknown[]): void => {
        const next = args[0] as EngineState
        if (next !== EngineState.Ready && next !== EngineState.Failed) return
        clearTimeout(timer)
        this.eventBus.off(Events.EngineStateChanged, onState)
        if (next === EngineState.Ready) {
          resolve()
        } else {
          reject(
            new AppError(
              ErrorCode.EngineTimeout,
              'engine entered failed state while waiting for ready'
            )
          )
        }
      }
      timer = setTimeout(() => {
        this.eventBus.off(Events.EngineStateChanged, onState)
        reject(
          new AppError(
            ErrorCode.EngineTimeout,
            `engine not ready within ${timeoutMs}ms`
          )
        )
      }, timeoutMs)
      this.eventBus.on(Events.EngineStateChanged, onState)
    })
  }

  assertReady(): void {
    if (this.state !== EngineState.Ready) {
      throw new AppError(
        ErrorCode.EngineConnectionLost,
        `engine is not ready (${this.state})`
      )
    }
  }
}
