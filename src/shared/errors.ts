export enum ErrorCode {
  EngineStartFailed = 'ENGINE_START_FAILED',
  EngineConnectionLost = 'ENGINE_CONNECTION_LOST',
  EngineTimeout = 'ENGINE_TIMEOUT',
  EngineProcessOwnershipUnverified = 'ENGINE_PROCESS_OWNERSHIP_UNVERIFIED',
  EngineProcessTerminationFailed = 'ENGINE_PROCESS_TERMINATION_FAILED',
  TaskCreateFailed = 'TASK_CREATE_FAILED',
  TaskNotFound = 'TASK_NOT_FOUND',
  TaskNotRetryable = 'TASK_NOT_RETRYABLE',
  SessionRestoreFailed = 'SESSION_RESTORE_FAILED',
  SettingsInvalid = 'SETTINGS_INVALID',
  PluginTimeout = 'PLUGIN_TIMEOUT',
  PluginExecutionFailed = 'PLUGIN_EXECUTION_FAILED',
  PluginLoadFailed = 'PLUGIN_LOAD_FAILED',
  // Phase 1A plugin runtime
  PluginManifestInvalid = 'PLUGIN_MANIFEST_INVALID',
  PluginEngineVersionTooOld = 'PLUGIN_ENGINE_VERSION_TOO_OLD',
  PluginPermissionUnsupported = 'PLUGIN_PERMISSION_UNSUPPORTED',
  PluginActivationTimeout = 'PLUGIN_ACTIVATION_TIMEOUT',
  PluginActivationCapExceeded = 'PLUGIN_ACTIVATION_CAP_EXCEEDED',
  PluginCapabilityUnavailable = 'PLUGIN_CAPABILITY_UNAVAILABLE',
  PluginCircuitOpen = 'PLUGIN_CIRCUIT_OPEN',
  PluginRuntimeFault = 'PLUGIN_RUNTIME_FAULT',
  PluginDirNotConfigured = 'PLUGIN_DIR_NOT_CONFIGURED',
  // NAT Manager
  NatDiscoveryFailed = 'NAT_DISCOVERY_FAILED',
  NatMappingFailed = 'NAT_MAPPING_FAILED',
  NatMappingConflict = 'NAT_MAPPING_CONFLICT',
  NatProtocolRejected = 'NAT_PROTOCOL_REJECTED',
  NatParseError = 'NAT_PARSE_ERROR',
  NatSecurityViolation = 'NAT_SECURITY_VIOLATION',
  NatTimeout = 'NAT_TIMEOUT',
  NatNetworkChanged = 'NAT_NETWORK_CHANGED',
  NatGatewayUnreachable = 'NAT_GATEWAY_UNREACHABLE',
  StunDetectionFailed = 'STUN_DETECTION_FAILED',
  // Torrent
  TorrentParseFailed = 'TORRENT_PARSE_FAILED',
  TorrentDuplicateConflict = 'TORRENT_DUPLICATE_CONFLICT',
  MagnetResolveFailed = 'MAGNET_RESOLVE_FAILED',
  MagnetResolveTimeout = 'MAGNET_RESOLVE_TIMEOUT',
  /** Plan B: aria2 cleanup of the magnet metadata fetch is still
   *  pending (RPC transient failure → MagnetTracker.cancel returned
   *  'quarantined'). Operations that would create a sibling aria2 GID
   *  (e.g. swapping the metadata instance for a bt_download instance
   *  after user file selection) must abort and surface a retryable
   *  error so the user can re-confirm after aria2 recovers. */
  MagnetCleanupPending = 'MAGNET_CLEANUP_PENDING',
  // IPC security
  IpcInvalidPayload = 'IPC_INVALID_PAYLOAD',
  IpcRateLimited = 'IPC_RATE_LIMITED',
  InvalidSelection = 'INVALID_SELECTION',
  // Tracker
  TrackerSyncFailed = 'TRACKER_SYNC_FAILED',
  TrackerProbeFailed = 'TRACKER_PROBE_FAILED',
  TrackerRefreshFailed = 'TRACKER_REFRESH_FAILED',
  EngineNotSupported = 'ENGINE_NOT_SUPPORTED',
  EngineFeatureUnavailable = 'ENGINE_FEATURE_UNAVAILABLE',
  EngineProtocolError = 'ENGINE_PROTOCOL_ERROR',
  // Incomplete-suffix feature
  TaskCreateDedupExhausted = 'TASK_CREATE_DEDUP_EXHAUSTED',
  TaskCreateTorrentMetaFailed = 'TASK_CREATE_TORRENT_META_FAILED',
  TaskFinalizeRenameFailed = 'TASK_FINALIZE_RENAME_FAILED',
  TaskFinalizeReseedFailed = 'TASK_FINALIZE_RESEED_FAILED',
  TaskFinalizeMetaMissing = 'TASK_FINALIZE_META_MISSING',
  TaskRemoveCleanupPartial = 'TASK_REMOVE_CLEANUP_PARTIAL',
  TaskRemoveNotAvailableDuringFinalize = 'TASK_REMOVE_NOT_AVAILABLE_DURING_FINALIZE',
  TaskRecoveryFsMismatch = 'TASK_RECOVERY_FS_MISMATCH',
  TaskRecoveryAria2Mismatch = 'TASK_RECOVERY_ARIA2_MISMATCH',
  // GeoIP
  GeoIPDownloadFailed = 'GEOIP_DOWNLOAD_FAILED',
  GeoIPSourceUnsupported = 'GEOIP_SOURCE_UNSUPPORTED',
  GeoIPDatabaseInvalid = 'GEOIP_DATABASE_INVALID',
}

export enum DownloadErrorCode {
  Unknown = 'DL_UNKNOWN',
  NotFound = 'DL_NOT_FOUND',
  Unauthorized = 'DL_UNAUTHORIZED',
  NetworkError = 'DL_NETWORK_ERROR',
  Timeout = 'DL_TIMEOUT',
  DiskFull = 'DL_DISK_FULL',
  FileWriteError = 'DL_FILE_WRITE_ERROR',
  ChecksumMismatch = 'DL_CHECKSUM_MISMATCH',
  TooManyRedirects = 'DL_TOO_MANY_REDIRECTS',
  ServerError = 'DL_SERVER_ERROR',
  BtMetadataFailed = 'DL_BT_METADATA_FAILED',
  BtTrackerError = 'DL_BT_TRACKER_ERROR',
}

export class AppError extends Error {
  constructor(
    public readonly code: ErrorCode,
    message: string,
    public readonly cause?: unknown
  ) {
    super(message)
    this.name = 'AppError'
  }
}
