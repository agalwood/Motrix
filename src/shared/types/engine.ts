export enum EngineState {
  Stopped = 'stopped',
  Starting = 'starting',
  Ready = 'ready',
  Restarting = 'restarting',
  Failed = 'failed',
}

export enum EngineFailureReason {
  PortInUse = 'port_in_use',
  BinaryUnavailable = 'binary_unavailable',
  SpawnFailed = 'spawn_failed',
  RpcUnavailable = 'rpc_unavailable',
  UnexpectedExit = 'unexpected_exit',
  HealthCheckFailed = 'health_check_failed',
  Unknown = 'unknown',
}

/**
 * i18n key for a given engine failure reason. Shared by the renderer's
 * sticky diagnostic toast (`use-notification-toasts.ts`) and the
 * main-process notification-center subscriber
 * (`engine-failure-subscriber.ts`), which previously carried two
 * byte-identical copies of this function kept in sync by mirror comments.
 */
export function engineFailureReasonKey(
  reason: EngineFailureReason | undefined
): string {
  const value = reason ?? EngineFailureReason.Unknown
  return `panel.dashboard.engine.diagnostics.reason.${value}`
}

export enum EngineProcessOwnership {
  CurrentApp = 'current_app',
  VerifiedOrphan = 'verified_orphan',
  ExternalAria2 = 'external_aria2',
  Other = 'other',
  Unknown = 'unknown',
}

export enum EngineRecoveryAction {
  Retry = 'retry',
  ForceTerminate = 'force_terminate',
  SwitchPort = 'switch_port',
  RestoreDefaultPort = 'restore_default_port',
}

export enum EngineRecoveryRecommendation {
  None = 'none',
  Retry = 'retry',
  ForceTerminate = 'force_terminate',
  SwitchPort = 'switch_port',
}

export interface EngineFailureInfo {
  reason: EngineFailureReason
  occurredAt: number
  technicalMessage: string | null
}

/**
 * Payload of `Events.EngineFailureOccurred` (Task 13) — emitted by
 * `EngineSupervisor.recordFailure()` every time it records a failure.
 * `incidentId` is `engine:${occurredAt}:${seq}`, unique per emission via a
 * per-instance monotonic `seq` that resets on every boot (fresh
 * `EngineSupervisor` instance) — it is not a replay-safe identifier across
 * restarts, which is why the notification ledger grace-cleans engine-scoped
 * rows on startup instead of relying on cross-boot dedup.
 */
export interface EngineFailurePayload {
  incidentId: string
  reason: EngineFailureReason
  occurredAt: number
  technicalMessage: string | null
}

/** Payload emitted after settings save while startup-only engine keys differ. */
export interface EngineRestartRequiredPayload {
  changedKeys: string[]
}

/** Emitted when the pre-spawn binary probe selects compatibility limits. */
export interface EngineCompatibilityWarningPayload {
  version: string
  connectionLimit: number
}

export interface EngineProcessInfo {
  pid: number
  name: string
  executableName: string | null
  ownership: EngineProcessOwnership
  safeToTerminate: boolean
}

export interface EngineStatusSnapshot {
  state: EngineState
  featureReport: EngineFeatureReport | null
  failure: EngineFailureInfo | null
  managedPid: number | null
}

export interface EngineDiagnosticReport extends EngineStatusSnapshot {
  generatedAt: number
  binary: {
    name: string
    available: boolean
    version: string | null
  }
  rpc: {
    port: number
    available: boolean
    expectedListener: boolean
  }
  process: EngineProcessInfo | null
  defaultRpc: {
    port: number
    isCurrent: boolean
    available: boolean
    process: EngineProcessInfo | null
    canRestore: boolean
    requiresTermination: boolean
  }
  suggestedRpcPort: number | null
  canRetry: boolean
  canForceTerminate: boolean
  canSwitchPort: boolean
  recommendation: EngineRecoveryRecommendation
}

export interface EngineRecoveryRequest {
  action: EngineRecoveryAction
  expectedPid?: number
}

export interface EngineRecoveryResult {
  ok: boolean
  previousRpcPort: number
  rpcPort: number
  status: EngineStatusSnapshot
}

export interface EngineCapability {
  http: boolean
  ftp: boolean
  bt: boolean
  magnet: boolean
  metalink: boolean
}

/**
 * aria2_motrix fork's enabledFeatures tag for SQLite3 persistence.
 * Note the dash (not a space) — the upstream aria2 1.37.0 build used
 * 'SQLite3 Session' for an older feature; the fork deliberately picked
 * a different token to avoid silent confusion.
 */
export const FEATURE_SQLITE3_PERSISTENCE = 'SQLite3-Persistence'

export interface EngineFeatureReport {
  version: string
  features: string[]
  hasBtSeedUnverified: boolean
  hasBtSaveMetadata: boolean
  hasMoveStorage: boolean
  /**
   * Whether the binary has the aria2_motrix fork's SQLite3 persistence
   * feature compiled in. Detected by `enabledFeatures` containing
   * `FEATURE_SQLITE3_PERSISTENCE`.
   */
  hasSqlitePersistence: boolean
}
