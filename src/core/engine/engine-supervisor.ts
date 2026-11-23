import path from 'node:path'
import { getLogger } from '@core/logger'
import type { AppliedDownloadProxyPolicy } from '@core/proxy/applied-download-proxy-policy'
import type { ProxyBridgeResolver } from '@core/proxy/proxy-bridge-manager'
import type { DownloadProxyOptions } from '@core/proxy/serializers'
import { ENGINE_RPC_PORT } from '@shared/constants'
import { AppError, ErrorCode } from '@shared/errors'
import { Events } from '@shared/protocol/events'
import {
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
import { generateRpcSecret } from '@shared/utils/rpc-secret'
import type { EventBus } from '../events/event-bus'
import type { SettingsManager } from '../settings/settings-manager'
import type { DirectResourceMetadataProfile } from './engine-adapter'
import type {
  EngineConfiguration,
  EngineConnection,
  EngineProcess,
  EngineRuntimeControl,
  EngineTrust,
} from './engine-runtime'
import type { EngineStartupGuard } from './engine-startup-guard'
import { checkPort, findAvailablePort } from './port-check'

const log = getLogger('engine')

/** How long task creation waits for the engine to become Ready
 *  before failing. Engine cold start = process spawn + RPC connect retry
 *  loop (~5s); 15s is a safe margin that still bounds a stuck engine. */
export const ENGINE_READY_TIMEOUT_MS = 15_000

const BACKOFF_BASE = 1_000
const BACKOFF_MAX = 30_000
const MAX_RESTARTS = 5
const HEALTH_CHECK_INTERVAL = 30_000
const MAX_CONSECUTIVE_FAILURES = 3

function sameProxyOptions(
  left: DownloadProxyOptions | null,
  right: DownloadProxyOptions | null
): boolean {
  if (left === null || right === null) return left === right
  return left.allProxy === right.allProxy && left.noProxy === right.noProxy
}

function getBackoffDelay(attempt: number): number {
  return Math.min(BACKOFF_BASE * 2 ** attempt, BACKOFF_MAX)
}

export class EngineSupervisor {
  private startAbort: AbortController | null = null
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
  private restartPromise: Promise<void> | null = null
  private preReadyMaintenance: (() => Promise<void>) | null = null
  private startupGuard: EngineStartupGuard | null = null

  constructor(
    private eventBus: EventBus,
    private settingsManager: SettingsManager,
    private processManager: EngineProcess,
    private configBuilder: EngineConfiguration,
    private trustStore: EngineTrust,
    private rpcClient: EngineConnection,
    private adapter: EngineRuntimeControl,
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
    this.startAbort?.abort()
    this.startAbort = new AbortController()
    this.stopping = false
    this.binaryPath = binaryPath
    this.restartAttempts = 0
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

  /** Required reconciliation runs under a paused startup, before Ready. */
  setStartupGuard(guard: EngineStartupGuard): void {
    this.startupGuard = guard
  }

  /** Register best-effort engine maintenance that runs after RPC connects but before Ready. */
  setPreReadyMaintenance(maintenance: () => Promise<void>): void {
    this.preReadyMaintenance = maintenance
  }

  /**
   * Apply engine speed limits. No-op
   * when the engine is not Ready (cold start picks up limits via `buildStartupArgs`).
   */
  async applySpeedLimits(limits: {
    download: number
    upload: number
  }): Promise<void> {
    if (this.state !== EngineState.Ready) return
    await this.adapter.setSpeedLimits(limits)
  }

  /**
   * HOT-update the default directory inherited by downloads created directly
   * through engine JSON-RPC. Motrix-owned task creation continues to pass its
   * selected directory per task.
   */
  async applyDefaultSaveDir(dir: string): Promise<void> {
    if (this.state !== EngineState.Ready) return
    await this.adapter.setDefaultSaveDirectory(dir)
  }

  /** HOT-update changed runtime engine settings without restarting engine. */
  async applyEngineSettings(
    previous: EngineSettings,
    next: EngineSettings
  ): Promise<void> {
    if (this.state === EngineState.Ready)
      await this.adapter.applySettings(next, previous)
  }

  /**
   * Apply a resolved download proxy while Ready. Startup applies the latest
   * route before authorizing recovered tasks. Null restores direct access.
   */
  async applyProxyChange(
    opts: { allProxy: string; noProxy: string } | null
  ): Promise<boolean> {
    if (this.state !== EngineState.Ready) return false
    await this.writeGlobalProxyOptions(opts)
    return true
  }

  private async writeGlobalProxyOptions(
    opts: DownloadProxyOptions | null
  ): Promise<void> {
    await this.adapter.setDownloadProxy(opts)
  }

  /**
   * Synchronously fence process-exit handling before asynchronous app cleanup.
   * Windows can terminate child processes as soon as session end begins, so
   * waiting until stop() reaches gracefulStop() can misclassify that expected
   * exit as an engine crash.
   */
  prepareForShutdown(): void {
    this.stopping = true
    this.startAbort?.abort()
    this.stopHealthCheck()
    this.clearRestartTimer()
  }

  async stop(): Promise<void> {
    this.prepareForShutdown()

    if (this.processManager.isRunning()) {
      // The process owns checkpoint flushing and its graceful shutdown budget.
      await this.processManager.gracefulStop(30_000)
    }
    this.rpcClient.disconnect()

    this.setState(EngineState.Stopped)
    // NOTE: stopping stays true — prevents doStart() from spawning a new
    // process after stop() returns but before the Electron process exits.
    // It is reset in start() when the engine is explicitly restarted.
  }

  private async doStart(): Promise<void> {
    const startSignal = this.startAbort?.signal
    const cancelled = () => this.stopping || startSignal?.aborted === true
    if (!this.binaryPath || cancelled()) return

    this.setState(EngineState.Starting)
    this.lastError = null
    this.failure = null

    let phase: 'probe' | 'config' | 'spawn' | 'rpc' = 'probe'
    let engineSettings: EngineSettings | null = null

    try {
      const featureReport = await this.processManager.probe(this.binaryPath)
      if (cancelled()) return

      this.featureReport = featureReport
      // Validate the probed engine before preparing or mutating its state.
      this.adapter.setFeatureReport(featureReport)
      // Step 2: Ensure config and build args
      phase = 'config'
      await this.configBuilder.prepare()
      if (cancelled()) return
      const processEnv = await this.trustStore.prepareEnvironment()
      if (cancelled()) return

      if (!this.settingsManager.getEngine().rpcSecret.trim()) {
        await this.settingsManager.update({
          engine: { rpcSecret: generateRpcSecret() },
        })
      }
      engineSettings = this.settingsManager.getEngine()
      // Engine connection is long-lived and caches its credential. Refresh it on
      // every start so an explicit settings rotation authenticates the first
      // RPC sent to the newly spawned engine process.
      this.rpcClient.setSecret(engineSettings.rpcSecret)
      const configuredProxy = structuredClone(this.settingsManager.getProxy())
      const resolvedProxy =
        await this.proxyBridge.resolveForDownload(configuredProxy)
      if (cancelled()) return
      const defaultSaveDir = this.settingsManager.getApp().defaultSaveDir
      // Provider is wired by the shell (Task 8) before start() in production;
      // the { 0, 0 } (unlimited) fallback only fires in tests or if start()
      // runs before the controller attaches.
      const effective = this.getEffectiveLimits?.() ?? {
        download: 0,
        upload: 0,
      }
      if (cancelled()) return
      log.debug(
        {
          rpcPort: engineSettings.rpcPort,
          rpcSecretLength: engineSettings.rpcSecret.length,
        },
        'preparing engine RPC configuration'
      )
      const args = this.configBuilder.buildStartupArgs(
        engineSettings,
        effective,
        defaultSaveDir
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

      await this.configBuilder.migrateSession?.(
        this.binaryPath,
        engineSettings,
        defaultSaveDir,
        startSignal
      )
      if (cancelled()) return

      // Step 4: Spawn process (abort if stop() was called during earlier awaits)
      if (cancelled()) return
      phase = 'spawn'
      const guardedStartup = await this.startupGuard?.prepare(args)
      if (cancelled()) return
      const startArgs = guardedStartup?.args ?? args
      this.lastStartArgs = startArgs
      await this.processManager.spawn(this.binaryPath, startArgs, processEnv)

      // Step 5: Connect RPC
      if (cancelled()) {
        await this.processManager.gracefulStop()
        return
      }
      phase = 'rpc'
      await this.rpcClient.connect(engineSettings.rpcPort)
      if (cancelled()) {
        this.rpcClient.disconnect()
        await this.processManager.gracefulStop()
        return
      }
      await this.adapter.connect()
      // The authenticated runtime report replaces the conservative binary probe.
      this.featureReport = this.adapter.getFeatureReport()
      await this.adapter.applySettings(engineSettings)
      await this.writeGlobalProxyOptions(resolvedProxy)
      // Unlike best-effort maintenance, failure here must stop the paused
      // process. Otherwise a known completed GID can recreate deleted files.
      await guardedStartup?.reconcile(() => cancelled())
      if (cancelled()) {
        this.rpcClient.disconnect()
        await this.processManager.gracefulStop()
        return
      }
      if (this.preReadyMaintenance) {
        try {
          await this.preReadyMaintenance()
        } catch (error) {
          // Startup reconciliation also runs after Ready. Maintenance narrows
          // the visibility/resume window but must not make engine unavailable.
          log.warn({ err: error }, 'pre-ready engine maintenance failed')
        }
        if (cancelled()) {
          this.rpcClient.disconnect()
          await this.processManager.gracefulStop()
          return
        }
      }
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
          'engine HTTP metadata request profile inspection failed closed'
        )
      }

      // Step 6: Ready
      if (cancelled()) {
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
              // startup route but before engine connects. Re-resolve under the
              // policy writer and repair engine before publishing Ready.
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
            () => !cancelled()
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
      if (startSignal?.aborted) return
      this.lastError = err instanceof Error ? err.message : String(err)
      const stderr = this.processManager.getRecentStderr?.() ?? ''
      // Preserve the startup identity failure instead of its later connection
      // refusal. Only capture the fixed diagnostic, never raw task options.
      const gidConflict = stderr.match(
        /\bGID [0-9a-f]{16} is not unique\./i
      )?.[0]
      if (phase === 'rpc' && gidConflict) this.lastError = gidConflict

      // A process can be alive even though RPC connection failed. Always
      // tear down a process spawned by this supervisor before entering Failed;
      // otherwise stop() used to skip it and leave engine holding the port.
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

  private handleUnexpectedExit(code: number | null): void {
    this.stopHealthCheck()
    this.recordFailure(
      EngineFailureReason.UnexpectedExit,
      code === null
        ? 'engine exited unexpectedly'
        : `engine exited unexpectedly with code ${code}`
    )
    this.restartWithBackoff()
  }

  private restartWithBackoff(): void {
    if (this.restartAttempts >= MAX_RESTARTS) {
      if (!this.failure) {
        this.recordFailure(
          EngineFailureReason.Unknown,
          'engine restart attempts were exhausted'
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
        await this.rpcClient.healthCheck()
        this.consecutiveFailures = 0
      } catch {
        this.consecutiveFailures++
        if (this.consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
          this.stopHealthCheck()
          this.recordFailure(
            EngineFailureReason.HealthCheckFailed,
            'engine stopped responding to health checks'
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
        name: binaryPath ? path.basename(binaryPath) : 'taiji',
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
        name: binaryPath ? path.basename(binaryPath) : 'taiji',
        available: binaryAvailable,
        version: binaryVersion,
      },
      rpc: {
        port: engineSettings.rpcPort,
        available: portAvailable,
        expectedListener,
        connection: this.rpcClient.getConnectionStatus(),
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
          'A verified engine process is required for force termination'
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
