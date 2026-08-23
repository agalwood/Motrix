import type { DownloadErrorCode } from '../errors'

export enum TaskStatus {
  Queued = 'queued',
  FetchingMetadata = 'fetching_metadata',
  /** Plan B follow-up: aria2 has finished fetching the .torrent
   *  metadata and the file list has been parsed, but the user has
   *  not yet confirmed the file selection in the add-task dialog.
   *  The task lives in DB as `phase='magnet_metadata_resolution'` so
   *  a crash during the dialog still recovers; the new aggregate
   *  status surface lets the Downloads list pill say "Ready" instead
   *  of the misleading "Fetching". On user confirm the row swaps to
   *  a `bt_download` instance with `aggStatus=Downloading`. */
  MetadataReady = 'metadata_ready',
  Downloading = 'downloading',
  Finalizing = 'finalizing',
  Seeding = 'seeding',
  Paused = 'paused',
  Completed = 'completed',
  Error = 'error',
  Removed = 'removed',
}

export enum TaskType {
  Http = 'http',
  Ftp = 'ftp',
  Bt = 'bt',
  Magnet = 'magnet',
  Metalink = 'metalink',
}

export enum TransitionPhase {
  Idle = 'idle',
  Renaming = 'renaming',
  Reseeding = 'reseeding',
}

export enum TaskKind {
  Direct = 'direct',
  Bt = 'bt',
  Hls = 'hls',
  Mux = 'mux',
}

export enum TaskInstancePhase {
  HttpDownload = 'http_download',
  BtDownload = 'bt_download',
  MagnetMetadataResolution = 'magnet_metadata_resolution',
  HlsSegment = 'hls_segment',
  HlsSubtitle = 'hls_subtitle',
  HlsAudio = 'hls_audio',
  FfmpegMux = 'ffmpeg_mux',
}

export interface TaskInstance {
  instanceId: string
  motrixId: string
  gid: string | null
  phase: TaskInstancePhase
  status: TaskStatus
  progress: number
  totalBytes: number
  downloadedBytes: number
  uploadedBytes: number
  diskPath: string
  transitionPhase: TransitionPhase
  uris: string[]
  uriHash: string | null
  payload: Record<string, unknown>
  createdAt: number
  updatedAt: number
}

export interface DownloadTask {
  id: string
  engineTaskId: string
  name: string
  type: TaskType
  status: TaskStatus
  progress: number
  totalBytes: number
  downloadedBytes: number
  downloadSpeed: number
  uploadSpeed: number
  etaSeconds: number
  saveDir: string
  createdAt: number
  updatedAt: number
  finishedAt: number | null
  errorMessage: string | null

  // ── source & transfer ────────────────────────────
  uris: string[]
  // Total upload bytes for the task's lifetime, including bytes from
  // gids that have been retired. Computed as
  // `uploadedBytesBaseline + currentGidUploadLength` on every poll.
  // Treat as a derived field — only `uploadedBytesBaseline` is durable.
  uploadedBytes: number
  // Cumulative upload from retired gids (pre-finalize sessions, pre-reAdd
  // sessions). Bumped at gid swap points; survives across restarts.
  uploadedBytesBaseline: number
  fileCount: number

  // ── connection & metadata ────────────────────────
  connections: number
  // aria2 piece size in bytes. Applies to direct HTTP/FTP downloads as
  // well as BitTorrent; persisted so completed tasks can reconstruct their
  // fully-downloaded piece map after the engine result has been retired.
  pieceLength: number
  infoHash: string | null
  errorCode: DownloadErrorCode | null
  errorDetailKey: string | null
  errorDetailParams: Record<string, string> | null
  diagnosisRevision: number
  metadataProgress: number

  // ── scheduling & organization ────────────────────
  priority: number
  category: string | null
  dlLimit: number
  ulLimit: number
  filename: string
  sizeWhenDone: number

  // ── provenance (bridge / plugin / user) ─────────────
  source: TaskSource
  sourceMeta: SourceMeta

  // ── BT extension (optional) ──────────────────────
  bt?: BtExtension

  // ── incomplete-suffix lifecycle ──────────────────
  diskPath: string
  finalPath: string
  finalName: string
  transitionPhase: TransitionPhase
  torrentMetaPath: string | null

  // ── task kind & multi-instance support ───────────
  kind: TaskKind
  // For single-instance tasks (direct/bt today), this array contains
  // exactly one entry whose `gid` equals `engineTaskId`. Multi-instance
  // tasks (HLS, magnet metadata pending) carry N entries. Renderers can
  // safely read engineTaskId / status / progress as before.
  instances: TaskInstance[]
}

export interface BtExtension {
  peers: number
  seeds: number
  ratio: number
  trackers: string[]
  /** Selected torrent files using the domain's 0-based indices. */
  selectedFiles: number[]

  peersInSwarm: number
  seedsInSwarm: number
  announceList: string[][]
  comment: string | null
  isPrivate: boolean
  magnetUri: string | null
  sequentialDownload: boolean
}

/**
 * Build a BtExtension with all-zero/empty defaults. Use at creation and
 * restore sites that start from defaults and override only the few fields
 * they actually know — keeps the extension shape in one place so a new field
 * gets one default here instead of being missed at a copy. Sites that derive
 * most fields from an engine snapshot (e.g. aria2 translate) keep an explicit
 * literal so the compiler still flags any unhandled field.
 */
/**
 * Build a DownloadTask from neutral zero-state defaults plus the caller's
 * fields. Identity, timestamps, and path fields have no meaningful default
 * and stay required; everything else starts at the zero state every creation
 * site (createTaskHandler, MediaTaskCoordinator) previously spelled out by
 * hand — a new DownloadTask field with a neutral default is added here once.
 */
export function makeDownloadTask(
  init: Partial<DownloadTask> &
    Pick<
      DownloadTask,
      | 'id'
      | 'name'
      | 'type'
      | 'kind'
      | 'saveDir'
      | 'createdAt'
      | 'updatedAt'
      | 'filename'
      | 'finalName'
      | 'finalPath'
      | 'diskPath'
      | 'source'
      | 'sourceMeta'
      | 'instances'
    >
): DownloadTask {
  return {
    engineTaskId: '',
    status: TaskStatus.Queued,
    progress: 0,
    totalBytes: 0,
    downloadedBytes: 0,
    downloadSpeed: 0,
    uploadSpeed: 0,
    etaSeconds: 0,
    finishedAt: null,
    errorMessage: null,
    uris: [],
    uploadedBytes: 0,
    uploadedBytesBaseline: 0,
    fileCount: 0,
    connections: 0,
    pieceLength: 0,
    infoHash: null,
    errorCode: null,
    errorDetailKey: null,
    errorDetailParams: null,
    diagnosisRevision: 0,
    metadataProgress: 0,
    priority: 0,
    category: null,
    dlLimit: 0,
    ulLimit: 0,
    sizeWhenDone: 0,
    transitionPhase: TransitionPhase.Idle,
    torrentMetaPath: null,
    ...init,
  }
}

export function makeDefaultBtExtension(
  overrides?: Partial<BtExtension>
): BtExtension {
  return {
    peers: 0,
    seeds: 0,
    ratio: 0,
    trackers: [],
    selectedFiles: [],
    peersInSwarm: 0,
    seedsInSwarm: 0,
    announceList: [],
    comment: null,
    isPrivate: false,
    magnetUri: null,
    sequentialDownload: false,
    ...overrides,
  }
}

export type TaskSource = 'user' | 'bridge' | 'plugin'

export interface BridgeSourceMeta {
  kind: 'direct' | 'hls' | 'dash' | 'mux' | 'magnet'
  extensionId: string
  browser: 'chromium' | 'firefox'
  sessionKey: string // `${browser}:${extensionId}`
  pageUrl: string
  pageTitle: string
  qualityLabel: string
  durationSec: number | null
  submittedAt: number // unix ms
}

// PluginSourceMeta shape is intentionally open in v1; only bridge tasks
// populate sourceMeta in v1.0.
export type SourceMeta = BridgeSourceMeta | null

export interface TaskFile {
  /** Engine-neutral 0-based file index. */
  index: number
  path: string
  size: number
  completedBytes: number
  selected: boolean
}
