import type {
  EngineCapability,
  EngineFeatureReport,
} from '@shared/types/engine'
import type { EngineTaskOptions } from '@shared/types/engine-task-options'
import type {
  HistoryFilter,
  HistorySearchQuery,
  RequeueResult,
} from '@shared/types/history'
import type { TaskPeer } from '@shared/types/peer'
import type { TaskPiecesResult } from '@shared/types/pieces'
import type { GlobalStats } from '@shared/types/stats'
import type { DownloadTask, TaskFile } from '@shared/types/task'
import type { FileAllocation } from '@shared/types/tuning'

export interface AddTorrentParams {
  metadata: Uint8Array
  saveDir: string
  /** Optional caller-reserved aria2 GID. aria2 accepts exactly 16
   * hexadecimal characters; adapters must reject any other shape before
   * dispatching engine work. */
  gid?: string
  /** Engine-native file indices, serialized to the engine as-is. For aria2
   *  these are 1-based (matching aria2's `select-file`). The create path is
   *  responsible for converting its 0-based request indices before calling. */
  selectedFiles?: number[]
  seedTime?: number
  seedRatio?: number
  btSeedUnverified?: boolean
  pause?: boolean
  // Tells aria2 to hash-check existing data files at the saveDir instead of
  // bailing out with errorCode=13 ("File exists, but a control file does
  // not exist"). Used by SessionManager when re-adding a task whose data
  // file is still on disk from a prior session.
  checkIntegrity?: boolean
  isPrivate?: boolean
  // ── create-path additions ──
  dlLimit?: number
  ulLimit?: number
  /** Engine-agnostic passthrough for shell-supplied options. The adapter
   *  honors keys it understands. */
  extraEngineOptions?: Record<string, string | string[]>
}

export interface CreateDownloadParams {
  uris: string[]
  saveDir: string
  /** Optional caller-reserved aria2 GID. aria2 accepts exactly 16
   * hexadecimal characters; adapters must reject any other shape before
   * dispatching engine work. */
  gid?: string
  filename?: string
  headers?: Record<string, string>
  // ── create-path additions (was Aria2TaskRequestAdapter) ──
  /** Requested per-server connections. Adapter maps to split +
   *  max-connection-per-server. Caller is responsible for clamping. */
  connections?: number
  proxy?: string
  /** Engine-agnostic passthrough for shell-supplied options (bridge cookie
   *  jar / referer). The adapter honors keys it understands. */
  extraEngineOptions?: Record<string, string | string[]>
  priority?: number
  category?: string
  dlLimit?: number
  ulLimit?: number
  pause?: boolean

  // Tuning hints
  totalSizeBytes?: number
  protocol?: 'http' | 'ftp' | 'sftp' | 'bt' | 'magnet' | 'metalink'
  isMultiFile?: boolean

  // Explicit override
  fileAllocation?: FileAllocation
  split?: number
  minSplitSize?: number
}

export interface EngineAdapter {
  connect(): Promise<void>
  disconnect(): Promise<void>
  getCapabilities(): EngineCapability

  /**
   * Engine feature report detected at connect time. Includes version and
   * runtime capability flags (hasBtSeedUnverified, hasSqlitePersistence, ...).
   * Returns conservative defaults before `connect()` has run.
   */
  getFeatureReport(): EngineFeatureReport

  createDownload(params: CreateDownloadParams): Promise<string>
  pauseTask(engineTaskId: string): Promise<void>
  resumeTask(engineTaskId: string): Promise<void>
  removeTask(engineTaskId: string): Promise<void>

  /**
   * Forcefully stop a task without graceful tracker shutdown. Required by
   * BT finalize: an active seeding task ignores `removeDownloadResult`
   * (that RPC only clears stopped/error/removed rows), so we must transition
   * it out of `active` before the result row can be cleaned and the new
   * post-rename gid can be added without a leftover GID lingering.
   */
  forceRemoveTask(engineTaskId: string): Promise<void>

  /**
   * Read all options of an engine task by gid. Returns null when
   * the gid is no longer in the engine (FIFO eviction or restart).
   * Other engine errors propagate.
   */
  getEngineTaskOptions(engineTaskId: string): Promise<EngineTaskOptions | null>

  /** Pause every active/waiting task at the engine level. */
  pauseAll(): Promise<void>

  /** Resume every paused task at the engine level. */
  resumeAll(): Promise<void>

  /**
   * Move a task in the engine queue.
   * - 'POS_SET' sets the absolute position to `pos`.
   * - 'POS_CUR' shifts by `pos` slots (negative = up, positive = down).
   * - 'POS_END' anchors `pos` from the end of the queue.
   * Returns the new absolute position.
   */
  changePosition(
    engineTaskId: string,
    pos: number,
    how: 'POS_SET' | 'POS_CUR' | 'POS_END'
  ): Promise<number>

  getTaskStatus(engineTaskId: string): Promise<DownloadTask | null>
  getTaskFiles(engineTaskId: string): Promise<TaskFile[]>

  /**
   * Mutate per-task engine options (aria2 `changeOption`). Used by
   * SetSelectedFiles to update `select-file` on a paused BT task without
   * re-adding it. Engines that return a status string should swallow it
   * and resolve to void.
   */
  changeOption(
    engineTaskId: string,
    options: Record<string, string>
  ): Promise<void>

  /**
   * Fetch piece state for an engine-backed download task.
   *
   * Returns `null` if the engine has no record of `engineTaskId`. Bitfield can
   * be large, so call only while the consumer is viewing the visualization;
   * it is deliberately excluded from the ListTasks hot path.
   */
  getTaskPieces(engineTaskId: string): Promise<TaskPiecesResult | null>

  /**
   * Fetch the live peer list for a BT task.
   *
   * - Returns `[]` for non-BT tasks or when the engine has no record of
   *   the task — aria2 raises in the latter case; we swallow it because
   *   the renderer polls and a transient miss is not actionable.
   * - The list is unbounded (a large swarm can return hundreds of peers);
   *   the renderer is expected to virtualize.
   */
  getTaskPeers(engineTaskId: string): Promise<TaskPeer[]>

  getGlobalStats(): Promise<GlobalStats>

  /**
   * Add a BT task from raw torrent metadata bytes.
   * Returns the new engineTaskId (gid).
   */
  addTorrent(params: AddTorrentParams): Promise<string>

  /**
   * Fetch the per-task bt-tracker option from the engine.
   * Returns the tracker URLs as an array; empty array if not set.
   */
  getTaskBtTracker(engineTaskId: string): Promise<string[]>

  /**
   * Remove a task's result row from the engine's internal list.
   * Idempotent: returns normally if the result is already gone.
   */
  removeDownloadResult(engineTaskId: string): Promise<void>

  /**
   * Batch variant of {@link removeDownloadResult}, executed in bounded
   * chunks. Entries are attempted in array order and each outcome is
   * reported independently, `Promise.allSettled`-shaped — an already-gone
   * id counts as fulfilled (same idempotent contract as the single form).
   * Never throws: a transport-level failure is reported as rejected
   * entries for the failed chunk and everything after it, so confirmed
   * cleanups survive and a retry re-attempts only what failed.
   */
  removeDownloadResults(
    engineTaskIds: readonly string[]
  ): Promise<PromiseSettledResult<void>[]>

  /**
   * Current upload byte count for an active or recently-removed task.
   * Returns 0 if the task is not found.
   */
  getUploadLength(engineTaskId: string): Promise<number>

  /**
   * List all active + waiting tasks with their info hashes.
   * Used by TaskRecoveryService to match persisted tasks to aria2 state.
   */
  listActiveAndWaiting(): Promise<Array<{ gid: string; infoHash?: string }>>

  /**
   * List all stopped (completed/errored/removed) tasks.
   * Used by TaskRecoveryService.
   */
  listStopped(): Promise<Array<{ gid: string; infoHash?: string }>>

  /**
   * Count completed/errored/removed history rows. Requires the engine
   * to be built and started with SQLite3 persistence enabled; otherwise
   * the underlying RPC error ("SQLite3 persistence is not enabled")
   * propagates unwrapped. Raises EngineProtocolError if the engine
   * returns a non-numeric count.
   */
  getHistoryCount(filter?: HistoryFilter): Promise<number>

  /**
   * Paginated search over persisted download history. Returns DownloadTask
   * objects (DB-rebuilt entries lack BT piece hashes — see fork doc K-1).
   */
  searchHistory(
    query: HistorySearchQuery,
    offset: number,
    num: number
  ): Promise<DownloadTask[]>

  /**
   * Export the current in-memory active+waiting state to an aria2
   * input-file at the given path. Does not touch the persistence DB.
   */
  exportSession(filePath: string): Promise<void>

  /**
   * Recreate a download from a finished history row. The strategy field
   * reports which fallback the engine selected (debug/tooltip surface).
   */
  requeueFromHistory(
    engineTaskId: string,
    overrides?: Record<string, string>
  ): Promise<RequeueResult>

  /**
   * Subscribe to aria2.onBtDownloadComplete notifications.
   * Returns an unsubscribe function.
   */
  onBtDownloadComplete(handler: (engineTaskId: string) => void): () => void

  /**
   * Subscribe to aria2.onDownloadComplete notifications.
   * For BT tasks this fires only after seeding is over.
   */
  onDownloadComplete(handler: (engineTaskId: string) => void): () => void

  /**
   * Subscribe to aria2.onDownloadError notifications.
   */
  onDownloadError(handler: (engineTaskId: string) => void): () => void
}
