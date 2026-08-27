import { randomBytes } from 'node:crypto'
import { mkdtemp, readdir, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, isAbsolute, join, parse, resolve } from 'node:path'
import type { Aria2RpcClient } from '@core/engine/aria2/aria2-rpc-client'
import type { Aria2RawStatus } from '@core/engine/aria2/types'
import type { EventBus } from '@core/events/event-bus'
import { AsyncWorkTracker } from '@core/inspector-activity/async-work-tracker'
import { newTaskId } from '@core/lib/ids'
import { getLogger } from '@core/logger'
import type {
  MotrixDatabase,
  TaskInstanceRow,
  TaskRow,
  TaskWithInstances,
  TaskWithInstancesAndFiles,
} from '@core/session/motrix-database'
import type { SettingsManager } from '@core/settings/settings-manager'
import {
  buildTerminalOccurrence,
  type TaskTransitionRecordInput,
  warnOccurrenceUndispatchable,
} from '@core/task/actions/shared'
import {
  applyTerminalTransition,
  terminalFieldsFromRow,
} from '@core/task/apply-terminal-transition'
import {
  acquireBtInfoHashAdmission,
  btTaskTargetDir,
  canonicalBtPath,
  isBtInfoHashRegistered,
  normalizeBtInfoHash,
  TorrentDuplicateConflictError,
} from '@core/task/bt-duplicate-policy'
import { btWorkspacePath } from '@core/task/bt-storage-layout'
import type { OccurrenceDispatcher } from '@core/task/occurrences/occurrence-dispatcher'
import type { TaskManager } from '@core/task/task-manager'
import { taskRowToDownloadTask } from '@core/task/task-row-to-download-task'
import { AppError, DownloadErrorCode, ErrorCode } from '@shared/errors'
import { Events } from '@shared/protocol/events'
import type { DownloadTask, SourceMeta, TaskSource } from '@shared/types/task'
import {
  TaskInstancePhase,
  TaskKind,
  TaskStatus,
  TaskType,
  TransitionPhase,
} from '@shared/types/task'
import type { TaskActivityRecorder } from '@shared/types/task-activity'
import type { TaskTerminalOccurrence } from '@shared/types/task-occurrence'
import {
  getMagnetCleanupArtifactPaths,
  getMagnetCleanupRestoreGraph,
  isMagnetCleanupQuarantined,
  isMagnetCleanupTombstoneHidden,
  withMagnetCleanupArtifactPaths,
  withMagnetCleanupQuarantined,
  withMagnetCleanupTombstoneHidden,
} from './magnet-cleanup-quarantine'
import type { TorrentParser } from './torrent-parser'

const log = getLogger('magnet-tracker')
const HEX_INFO_HASH_RE = /^[a-fA-F0-9]{40}$/
const BASE32_INFO_HASH_RE = /^[A-Z2-7]{32}$/i
const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'
const UNKNOWN_INFO_HASH = '0'.repeat(40)
const METADATA_TIMEOUT_MULTIPLIER_PAYLOAD_KEY =
  'metadataTimeoutMultiplier' as const
const INITIAL_METADATA_TIMEOUT_MULTIPLIER = 1
const RETRY_METADATA_TIMEOUT_MULTIPLIER = 2

/** Outcome of magnet metadata cleanup attempt. `removed` means aria2
 *  has confirmed the GID is no longer alive — safe for callers to
 *  drop the persistent DB row. `quarantined` means RPC cleanup failed
 *  in a way that does not confirm removal; the cache tombstone is
 *  retained for observe() shielding, and callers MUST keep the DB
 *  row so primeFromDatabase can restore the tombstone across restart. */
export type CleanupResult = 'removed' | 'quarantined'

export interface MagnetTrackerLifecycle {
  /**
   * Coalesced / immediate TaskUpdated publication (TaskUpdatePublisher).
   * Metadata-lifecycle progress rides the trailing window; transitions that
   * commit a terminal occurrence flush immediately so the occurrence
   * dispatch below them never precedes the snapshot.
   */
  publishTaskUpdate: () => void
  publishTaskUpdateNow: () => void
  parentTaskCreated?: (
    task: DownloadTask,
    persistParent: () => void | Promise<void>
  ) => Promise<void>
  recordTransition?: (input: TaskTransitionRecordInput) => void | Promise<void>
  deleteParentTask?: (
    taskId: string,
    deleteParent: () => void | Promise<void>
  ) => Promise<void>
  runTaskMutation?: <T>(
    taskIds: readonly string[],
    operation: () => Promise<T>
  ) => Promise<T>
  runExclusivePersistence?: <T>(operation: () => T | Promise<T>) => Promise<T>
  wallNow?: () => number
  monotonicNow?: () => number
  /** Trusted application-owned root for persisted `.torrent` metadata.
   * Failed-swap cleanup refuses torrent paths outside this directory. */
  torrentMetaDir?: string
  /** Delivers a just-committed terminal occurrence to in-process consumers.
   *  Optional; every terminal write here still commits durably without it —
   *  only at-least-once delivery to consumers is skipped. Narrowed to
   *  `dispatch` so tests can supply a plain `{ dispatch }` double. */
  occurrenceDispatcher?: Pick<OccurrenceDispatcher, 'dispatch'>
}

export interface FailedSwapCleanupRegistration {
  taskId: string
  instanceId: string
  gid: string
  magnetUri: string
  saveDir: string
  metadataDir: string
  torrentMetaPath: string | null
  artifactPaths: string[]
  deleteParentOnSuccess: boolean
  retireEngineGidReservationOnCleanup?: boolean
  restoreGraph?: TaskWithInstancesAndFiles
}

export type FailedSwapCleanupReservation = Omit<
  FailedSwapCleanupRegistration,
  'deleteParentOnSuccess'
>

// Backoff schedule for cleanup retry: 5s, 10s, 20s, 40s, 80s, then
// give up at attempt 6. Total elapsed time before quarantine ≈ 155s
// (5 + 10 + 20 + 40 + 80), covering one engine restart but short
// enough that a permanently-stuck task surfaces to the user.
const RETRY_DELAY_MS = 5_000
const MAX_CLEANUP_ATTEMPTS = 6
const BACKOFF_MULTIPLIER = 2

interface MetadataInstanceCache {
  // aria2 GID — duplicated with the Map key so cleanup paths can call
  // RPC with the correct identifier without reverse-lookup. Passing
  // instanceId (e.g. `meta:${taskId}`) into forceRemove silently no-ops
  // on aria2 (Codex finding #2).
  gid: string
  taskId: string
  instanceId: string
  magnetUri: string
  saveDir: string
  metadataDir: string
  torrentMetaPath: string | null
  torrentMetaDir: string | null
  cleanupArtifactPaths: string[]
  failedSwapCleanup: boolean
  hiddenTombstone: boolean
  restoreGraph?: TaskWithInstancesAndFiles
  timeoutMultiplier: number
  timer: ReturnType<typeof setTimeout>
  cleanupAttempts: number
  cleanupFirstFailureAt?: number
  // Quarantine tombstone flag (Codex finding #6). When cleanup gives
  // up after MAX_CLEANUP_ATTEMPTS we mark the entry quarantined and
  // keep it in the cache so observe() continues shielding the GID
  // from normal task adoption. Without this, the next polling cycle
  // would adopt the still-alive aria2 GID as a `[METADATA]...` task.
  quarantined: boolean
  // Re-entrancy guard (Codex finding #14). cancel / timeout / onError
  // can race for the same entry — without coalescing, each clears the
  // timer, awaits its own RPC, bumps cleanupAttempts independently,
  // and sets a new timer; only the last `entry.timer` survives, so
  // earlier orphan timers leak past dispose().
  cleanupInFlight?: Promise<void>
  // User-delete intent (Codex finding #15). Set by `cancel(taskId)`
  // before invoking cleanupCacheEntry. When cleanup eventually
  // succeeds — either on the first try or via the background retry
  // timer that fired after cancel returned 'quarantined' — the
  // success branch deletes the persistent DB row. Without this,
  // retry-success would silently leave the Error tombstone (written
  // by removeTask for the 'quarantined' path) in the DB forever and
  // primeFromDatabase would keep rebuilding a quarantine entry for
  // a GID aria2 no longer has.
  pendingUserDelete?: boolean
  // A submit that failed after addUri may have made its caller-reserved GID
  // visible to polling. Once compensation confirms engine removal and deletes
  // the durable parent, atomically convert the reservation into TaskManager's
  // bounded retired shield before dropping this cache entry.
  retireEngineGidReservationOnCleanup?: boolean
}

export class MagnetTracker {
  // In-memory cache keyed by aria2 GID. Source of truth lives in
  // task_instances rows with phase=magnet_metadata_resolution; this
  // cache exists for polling-hot-path lookups without round-tripping
  // the db.
  private cache = new Map<string, MetadataInstanceCache>()
  private readonly asyncWork = new AsyncWorkTracker()
  private readonly unsubscribeRpc: Array<() => void> = []
  private stopped = false
  private stopPromise: Promise<void> | null = null

  constructor(
    private rpcClient: Aria2RpcClient,
    private eventBus: EventBus,
    private settingsManager: SettingsManager,
    private db: MotrixDatabase,
    private taskManager: TaskManager,
    private torrentParser: TorrentParser,
    private activityRecorder: TaskActivityRecorder,
    private lifecycle: MagnetTrackerLifecycle
  ) {
    this.storeUnsubscribe(
      this.rpcClient.onDownloadComplete((event) =>
        this.trackCallback(() => this.onComplete(event.gid))
      )
    )
    this.storeUnsubscribe(
      this.rpcClient.onBtDownloadComplete((event) =>
        this.trackCallback(() => this.onComplete(event.gid))
      )
    )
    this.storeUnsubscribe(
      this.rpcClient.onDownloadError((event) =>
        this.trackCallback(() => this.onError(event.gid))
      )
    )
  }

  /** Re-prime the cache from db after restart. Called by the bootstrap
   *  after SessionManager.restore() finishes. */
  primeFromDatabase(): void {
    if (this.stopped) return
    const all = this.db.getAllTasks()
    for (const pair of all) {
      const metaInst = pair.instances.find(
        (i) => i.phase === TaskInstancePhase.MagnetMetadataResolution
      )
      if (!metaInst?.gid) continue
      const isHiddenTombstone = isMagnetCleanupTombstoneHidden(metaInst)
      // MetadataReady rows have no live aria2 GID (removeMetadataResult
      // ran in onComplete before the user dialog opened). Polling won't
      // see the gid, so the cache shield is unnecessary. Re-emitting
      // MagnetFileSelection on restart is a separate UX (the dialog
      // can be re-triggered from the Downloads row's context menu);
      // here we just skip the prime so we don't arm a phantom timer.
      if (
        pair.task.aggStatus === TaskStatus.MetadataReady &&
        !isHiddenTombstone
      ) {
        continue
      }
      const metadataDir =
        typeof metaInst.payload.metadataDir === 'string'
          ? metaInst.payload.metadataDir
          : ''
      const magnetUri = metaInst.uris[0] ?? ''
      // Error is also the normal, user-visible metadata-failure state.
      // Cleanup quarantine and hidden user-delete intent are persisted as
      // separate discriminators. Both kinds still need a cache shield in case
      // aria2 retained the GID across restart; only a hidden tombstone resumes
      // bounded cleanup, because it has no UI entry through which the user
      // could retry.
      const isQuarantined = isMagnetCleanupQuarantined(metaInst)
      const isTerminalError = pair.task.aggStatus === TaskStatus.Error
      const cleanupArtifactPaths = getMagnetCleanupArtifactPaths(metaInst)
      const restoreGraph = getMagnetCleanupRestoreGraph(
        metaInst,
        pair.task.motrixId
      )
      const cleanupTorrentMetaPath =
        cleanupArtifactPaths.find(
          (artifactPath) =>
            basename(artifactPath) === `${pair.task.motrixId}.torrent`
        ) ?? pair.task.torrentMetaPath
      const entry: MetadataInstanceCache = {
        gid: metaInst.gid,
        taskId: pair.task.motrixId,
        instanceId: metaInst.instanceId,
        magnetUri,
        // The parent row is the durable, structured cleanup root. Do not
        // authorize recursive deletion from the embedded restore payload,
        // whose finalPath is intentionally the pre-swap location.
        saveDir: pair.task.finalPath,
        metadataDir,
        torrentMetaPath: cleanupTorrentMetaPath,
        torrentMetaDir: this.lifecycle.torrentMetaDir ?? null,
        cleanupArtifactPaths,
        failedSwapCleanup: isHiddenTombstone && cleanupArtifactPaths.length > 0,
        hiddenTombstone: isHiddenTombstone,
        restoreGraph: restoreGraph ?? undefined,
        timeoutMultiplier: metadataTimeoutMultiplier(metaInst.payload),
        timer: setTimeout(() => {}, 0),
        cleanupAttempts:
          isQuarantined && !isHiddenTombstone ? MAX_CLEANUP_ATTEMPTS : 0,
        quarantined: isQuarantined,
        pendingUserDelete: isHiddenTombstone && !restoreGraph,
        retireEngineGidReservationOnCleanup:
          isHiddenTombstone && Boolean(restoreGraph),
      }
      this.cache.set(metaInst.gid, entry)
      clearTimeout(entry.timer)
      if (isHiddenTombstone) {
        this.taskManager.remove(pair.task.motrixId)
        entry.timer = setTimeout(
          () => void this.trackCallback(() => this.cleanupCacheEntry(entry)),
          RETRY_DELAY_MS
        )
      } else if (!isTerminalError) {
        entry.timer = this.armTimeout(metaInst.gid, entry.timeoutMultiplier)
      }
    }
  }

  /**
   * True while a failed metadata -> BT swap still owns a GID or local
   * artifacts that have not been durably cleaned. This is an in-process
   * admission guard; the persisted hidden tombstone is the restart-safe
   * source of truth.
   */
  hasPendingSwapCleanup(taskId: string): boolean {
    return this.findCacheEntryByTaskId(taskId)?.failedSwapCleanup === true
  }

  /**
   * Adopt a newly-created BT GID after the swap's graph transaction and
   * immediate compensation both failed. The caller first persists the same
   * ownership as a hidden DB tombstone, then registers it here so polling
   * shields the GID and bounded cleanup starts without waiting for restart.
   */
  registerFailedSwapCleanup(input: FailedSwapCleanupRegistration): void {
    this.replaceFailedSwapCleanupEntry(input, true)
  }

  /**
   * Shield a just-created BT GID before awaiting compensation RPC. Without
   * this synchronous reservation, a polling tick can adopt the uncommitted
   * GID while forceRemove is in flight.
   */
  reserveFailedSwapCleanup(input: FailedSwapCleanupReservation): void {
    this.replaceFailedSwapCleanupEntry(
      { ...input, deleteParentOnSuccess: false },
      false
    )
  }

  releaseFailedSwapCleanup(taskId: string, gid: string): void {
    const entry = this.cache.get(gid)
    if (!entry || entry.taskId !== taskId || entry.failedSwapCleanup !== true) {
      return
    }
    clearTimeout(entry.timer)
    this.cache.delete(gid)
  }

  private replaceFailedSwapCleanupEntry(
    input: FailedSwapCleanupRegistration,
    scheduleCleanup: boolean
  ): void {
    if (this.stopped) return

    for (const [gid, cached] of this.cache) {
      if (cached.taskId !== input.taskId) continue
      clearTimeout(cached.timer)
      this.cache.delete(gid)
    }

    const entry: MetadataInstanceCache = {
      gid: input.gid,
      taskId: input.taskId,
      instanceId: input.instanceId,
      magnetUri: input.magnetUri,
      saveDir: input.saveDir,
      metadataDir: input.metadataDir,
      torrentMetaPath: input.torrentMetaPath,
      torrentMetaDir: this.lifecycle.torrentMetaDir ?? null,
      cleanupArtifactPaths: [...input.artifactPaths],
      failedSwapCleanup: true,
      hiddenTombstone: scheduleCleanup,
      restoreGraph: input.restoreGraph,
      timeoutMultiplier: INITIAL_METADATA_TIMEOUT_MULTIPLIER,
      timer: setTimeout(() => {}, 0),
      cleanupAttempts: 0,
      quarantined: scheduleCleanup,
      pendingUserDelete: input.deleteParentOnSuccess,
      retireEngineGidReservationOnCleanup:
        input.retireEngineGidReservationOnCleanup,
    }
    this.cache.set(input.gid, entry)
    clearTimeout(entry.timer)
    if (scheduleCleanup) {
      entry.timer = setTimeout(
        () => void this.trackCallback(() => this.cleanupCacheEntry(entry)),
        RETRY_DELAY_MS
      )
    }
  }

  /** Submit a magnet for metadata-only fetch. Returns the motrixId of
   *  the task that owns the pending instance — callers (commands.ts)
   *  surface this to the renderer so the resolved-magnet confirmation
   *  can reference the same task. Returns '' when magnetFileSelection
   *  is disabled (callers fall through to a normal create-task).
   *
   *  `provenance` attributes the metadata task to its origin. Defaults to
   *  `{ source: 'user', sourceMeta: null }` so the renderer/UI path is
   *  unchanged. The bridge passes `{ source: 'bridge', sourceMeta }` so the
   *  attribution survives onto the swapped bt_download instance and
   *  ProgressPublisher keeps forwarding progress to the extension. */
  async submit(
    uri: string,
    saveDir: string,
    provenance?: { source?: TaskSource; sourceMeta?: SourceMeta }
  ): Promise<string> {
    const requestedInfoHash = extractInfoHash(uri)
    if (requestedInfoHash === UNKNOWN_INFO_HASH) {
      return this.submitUnderAdmission(uri, saveDir, provenance)
    }

    const release = await acquireBtInfoHashAdmission(requestedInfoHash)
    try {
      return await this.submitUnderAdmission(uri, saveDir, provenance)
    } finally {
      release()
    }
  }

  private async submitUnderAdmission(
    uri: string,
    saveDir: string,
    provenance?: { source?: TaskSource; sourceMeta?: SourceMeta }
  ): Promise<string> {
    if (this.stopped) {
      throw new Error('MagnetTracker is stopped')
    }
    const { magnetFileSelection } = this.settingsManager.getApp()

    if (!magnetFileSelection) {
      const gid = await this.rpcClient.addUri([uri], { dir: saveDir })
      if (this.stopped) return ''
      log.info({ gid, uri }, 'magnet added (file selection disabled)')
      return ''
    }

    const requestedInfoHash = extractInfoHash(uri)
    if (requestedInfoHash !== UNKNOWN_INFO_HASH) {
      const requestedDir = canonicalBtPath(saveDir)
      const sameContent = this.taskManager
        .getAll()
        .filter(
          (task) =>
            normalizeBtInfoHash(task.infoHash ?? '') === requestedInfoHash &&
            task.status !== TaskStatus.Removed
        )
      const sameDirectory = sameContent.find(
        (task) => btTaskTargetDir(task) === requestedDir
      )
      if (sameDirectory) {
        log.info(
          { infoHash: requestedInfoHash, taskId: sameDirectory.id },
          'magnet submit reused existing content owner'
        )
        return sameDirectory.id
      }

      const active = sameContent.find(isBtInfoHashRegistered)
      if (active) {
        throw new TorrentDuplicateConflictError({
          reason: 'active-info-hash',
          infoHash: requestedInfoHash,
          targetDir: requestedDir,
          existingTaskId: active.id,
          existingTaskName: active.name,
          existingTaskStatus: active.status,
          canCreateCopy: false,
        })
      }
    }

    const metadataDir = await mkdtemp(join(tmpdir(), 'motrix-magnet-metadata-'))
    if (this.stopped) {
      await this.cleanupMetadataDir(metadataDir)
      return ''
    }
    const taskId = newTaskId()
    const instanceId = `meta:${taskId}`
    let reservedGid: string
    try {
      reservedGid = this.reserveNewEngineGid()
    } catch (err) {
      await this.cleanupMetadataDir(metadataDir)
      throw err
    }
    const now = Date.now()
    const infoHash = extractInfoHash(uri)

    const task: TaskRow = {
      motrixId: taskId,
      name: `[METADATA] ${truncateName(uri)}`,
      kind: TaskKind.Bt,
      taskType: TaskType.Magnet,
      category: null,
      priority: 0,
      tags: null,
      createdAt: now,
      updatedAt: now,
      finalPath: saveDir,
      finalName: '',
      torrentMetaPath: null,
      infoHash: infoHash === UNKNOWN_INFO_HASH ? null : infoHash,
      totalBytes: 0,
      downloadedBytes: 0,
      sizeWhenDone: 0,
      fileCount: 0,
      isPrivate: false,
      trackers: [],
      pieceLength: 0,
      aggStatus: TaskStatus.FetchingMetadata,
      finishedAt: null,
      errorMessage: null,
      errorCode: null,
      errorDetailKey: null,
      errorDetailParams: null,
      diagnosisRevision: 0,
      uploadedBytesBaseline: 0,
      source: provenance?.source ?? 'user',
      sourceMeta: provenance?.sourceMeta ?? null,
    }

    const instance: TaskInstanceRow = {
      instanceId,
      motrixId: taskId,
      gid: reservedGid,
      phase: TaskInstancePhase.MagnetMetadataResolution,
      status: TaskStatus.FetchingMetadata,
      progress: 0,
      totalBytes: 0,
      downloadedBytes: 0,
      uploadedBytes: 0,
      diskPath: metadataDir,
      transitionPhase: TransitionPhase.Idle,
      uris: [uri],
      uriHash: null,
      payload: withMagnetCleanupTombstoneHidden(
        withMagnetCleanupQuarantined({ metadataDir }, false),
        false
      ),
      createdAt: now,
      updatedAt: now,
    }

    let operationEntered = false
    try {
      return await this.runTaskMutation(taskId, async () => {
        operationEntered = true
        let activeInstance = instance
        let entry: MetadataInstanceCache | null = null
        let engineDispatchStarted = false
        let ownerPublished = false
        let reservedOwnerInstalled = false

        try {
          if (this.stopped) {
            await this.rollbackMetadataSubmitBeforeDispatch(
              taskId,
              reservedGid,
              metadataDir
            )
            return ''
          }

          const downloadTask = taskRowToDownloadTask(task, [activeInstance])
          const persistParent = (): Promise<void> =>
            this.runExclusivePersistence(() => {
              this.db.saveTaskWithInstances({
                task,
                instances: [activeInstance],
              })
            })
          if (this.lifecycle.parentTaskCreated) {
            await this.lifecycle.parentTaskCreated(downloadTask, persistParent)
          } else {
            await persistParent()
          }
          if (this.stopped) {
            await this.rollbackMetadataSubmitBeforeDispatch(
              taskId,
              reservedGid,
              metadataDir
            )
            return ''
          }

          // The parent + Added activity barrier is durable before this owner
          // becomes publicly observable through getAll(). Keep the GID
          // reservation active while installing the owner, then dispatch
          // without another await so polling cannot see an ownerless row.
          this.taskManager.setReservedEngineTaskOwner(
            taskId,
            downloadTask,
            reservedGid
          )
          reservedOwnerInstalled = true

          // Install the callback/observe owner before addUri. A very small
          // magnet can complete before the RPC response reaches us; the cache
          // lets that callback queue behind this task mutation instead of
          // disappearing. TaskManager's reservation independently blocks a
          // polling snapshot until set() publishes the same owner.
          entry = {
            gid: reservedGid,
            taskId,
            instanceId,
            magnetUri: uri,
            saveDir,
            metadataDir,
            torrentMetaPath: null,
            torrentMetaDir: this.lifecycle.torrentMetaDir ?? null,
            cleanupArtifactPaths: [],
            failedSwapCleanup: false,
            hiddenTombstone: false,
            timeoutMultiplier: INITIAL_METADATA_TIMEOUT_MULTIPLIER,
            timer: this.armTimeout(reservedGid),
            cleanupAttempts: 0,
            quarantined: false,
          }
          this.cache.set(reservedGid, entry)

          engineDispatchStarted = true
          const returnedGid = await this.rpcClient.addUri([uri], {
            'bt-load-saved-metadata': 'false',
            'bt-metadata-only': 'true',
            dir: metadataDir,
            'follow-torrent': 'false',
            gid: reservedGid,
          })
          if (returnedGid !== entry.gid) {
            activeInstance = await this.rebindSubmittedMetadataGid(
              task,
              activeInstance,
              entry,
              returnedGid
            )
          }
          if (this.stopped) {
            await this.compensateMetadataSubmitAfterDispatch(
              entry,
              new Error('MagnetTracker stopped during metadata submission')
            )
            return ''
          }

          const publishedTask = taskRowToDownloadTask(task, [activeInstance])
          // Mirror to TaskManager so Downloads list immediately shows the
          // task in fetching_metadata state. set() atomically claims the
          // caller-reserved engine GID.
          this.taskManager.set(taskId, publishedTask)
          ownerPublished = true
          this.activityRecorder.recordSubmitted({
            taskId,
            occurredAt: task.createdAt,
          })

          // useTaskList (renderer) listens on TaskUpdated to refresh the
          // Downloads list. Without this publication, the magnet metadata
          // row only appears after a manual navigation away + back (which
          // forces a ListTasks re-fetch). Polling SKIPS the metadata GID via
          // shouldSkipForPendingMagnetMetadata, so it never publishes
          // either — the responsibility lives here.
          this.lifecycle.publishTaskUpdate()

          log.info(
            { gid: activeInstance.gid, uri, taskId },
            'magnet metadata fetch started'
          )
          return taskId
        } catch (err) {
          if (engineDispatchStarted && entry && !ownerPublished) {
            await this.compensateMetadataSubmitAfterDispatch(entry, err)
          } else if (!engineDispatchStarted) {
            await this.rollbackMetadataSubmitBeforeDispatch(
              taskId,
              reservedGid,
              metadataDir,
              reservedOwnerInstalled
            )
          }
          throw err
        }
      })
    } catch (err) {
      // A disposed lifecycle runtime can reject admission before invoking the
      // operation. No engine call was possible, so plain reservation release
      // is safe.
      if (!operationEntered) {
        await this.rollbackMetadataSubmitBeforeDispatch(
          taskId,
          reservedGid,
          metadataDir
        )
      }
      throw err
    }
  }

  /**
   * Retry a failed pre-sidecar magnet metadata resolution in place. The
   * durable parent identity and magnet URI are retained, while the engine GID
   * and temporary directory are always replaced. Manual retries receive
   * twice the configured metadata timeout; later retries stay at 2x.
   */
  async retryMetadata(taskId: string): Promise<void> {
    if (this.stopped) {
      throw new Error('MagnetTracker is stopped')
    }
    await this.runTaskMutation(taskId, () =>
      this.retryMetadataUnderMutation(taskId)
    )
  }

  private async retryMetadataUnderMutation(taskId: string): Promise<void> {
    const pair = this.db.getTask(taskId)
    const metaInst = pair?.instances.find(
      (instance) =>
        instance.phase === TaskInstancePhase.MagnetMetadataResolution
    )
    const magnetUri = metaInst?.uris.find((uri) =>
      uri.toLowerCase().startsWith('magnet:?')
    )
    if (
      !pair ||
      pair.task.taskType !== TaskType.Magnet ||
      pair.task.aggStatus !== TaskStatus.Error ||
      pair.task.torrentMetaPath !== null ||
      pair.instances.length !== 1 ||
      !metaInst ||
      !magnetUri ||
      isMagnetCleanupTombstoneHidden(metaInst)
    ) {
      throw new AppError(
        ErrorCode.TaskNotRetryable,
        `task ${taskId} is not a retryable magnet metadata task`
      )
    }

    // A timeout publishes Error before it attempts engine cleanup, so a fast
    // click can arrive while the old GID is still shielded. Serialize behind
    // that cleanup and require authoritative absence before creating a new
    // sibling GID.
    const previousEntry = this.findCacheEntryByTaskId(taskId)
    if (previousEntry) {
      previousEntry.cleanupAttempts = 0
      previousEntry.cleanupFirstFailureAt = undefined
      previousEntry.quarantined = false
      await this.cleanupCacheEntryUnderMutation(previousEntry)
      if (this.cache.get(previousEntry.gid) === previousEntry) {
        throw new AppError(
          ErrorCode.MagnetCleanupPending,
          `previous magnet metadata attempt for task ${taskId} is still being cleaned up`
        )
      }
    }

    const metadataDir = await mkdtemp(join(tmpdir(), 'motrix-magnet-metadata-'))
    let reservedGid: string
    try {
      reservedGid = this.reserveNewEngineGid()
    } catch (err) {
      await this.cleanupMetadataDir(metadataDir)
      throw err
    }

    const now = Date.now()
    const terminal = applyTerminalTransition(
      terminalFieldsFromRow(pair.task),
      TaskStatus.FetchingMetadata,
      {},
      now
    )
    const updatedTask: TaskRow = {
      ...pair.task,
      aggStatus: terminal.status,
      finishedAt: terminal.finishedAt,
      errorMessage: terminal.errorMessage,
      errorCode: terminal.errorCode,
      errorDetailKey: terminal.errorDetailKey,
      errorDetailParams: terminal.errorDetailParams,
      diagnosisRevision: terminal.diagnosisRevision,
      updatedAt: now,
    }
    const updatedInstance: TaskInstanceRow = {
      ...metaInst,
      gid: reservedGid,
      status: TaskStatus.FetchingMetadata,
      progress: 0,
      totalBytes: 0,
      downloadedBytes: 0,
      uploadedBytes: 0,
      diskPath: metadataDir,
      transitionPhase: TransitionPhase.Idle,
      payload: metadataFetchPayload(
        metadataDir,
        RETRY_METADATA_TIMEOUT_MULTIPLIER
      ),
      updatedAt: now,
    }
    const previousDownloadTask = taskRowToDownloadTask(
      pair.task,
      pair.instances
    )
    let activeInstance = updatedInstance
    let retryTask = taskRowToDownloadTask(updatedTask, [activeInstance])
    let entry: MetadataInstanceCache | null = null
    let persisted = false
    let reservedOwnerInstalled = false
    let engineDispatchStarted = false

    try {
      await this.runExclusivePersistence(async () => {
        this.db.saveTaskWithInstances({
          task: updatedTask,
          instances: [activeInstance],
        })
        await this.recordExactTransition(previousDownloadTask, retryTask, now)
      })
      persisted = true

      this.taskManager.setReservedEngineTaskOwner(
        taskId,
        retryTask,
        reservedGid
      )
      reservedOwnerInstalled = true
      entry = {
        gid: reservedGid,
        taskId,
        instanceId: activeInstance.instanceId,
        magnetUri,
        saveDir: pair.task.finalPath,
        metadataDir,
        torrentMetaPath: null,
        torrentMetaDir: this.lifecycle.torrentMetaDir ?? null,
        cleanupArtifactPaths: [],
        failedSwapCleanup: false,
        hiddenTombstone: false,
        timeoutMultiplier: RETRY_METADATA_TIMEOUT_MULTIPLIER,
        timer: this.armTimeout(reservedGid, RETRY_METADATA_TIMEOUT_MULTIPLIER),
        cleanupAttempts: 0,
        quarantined: false,
      }
      this.cache.set(reservedGid, entry)

      engineDispatchStarted = true
      const returnedGid = await this.rpcClient.addUri([magnetUri], {
        'bt-load-saved-metadata': 'false',
        'bt-metadata-only': 'true',
        dir: metadataDir,
        'follow-torrent': 'false',
        gid: reservedGid,
      })
      if (returnedGid !== entry.gid) {
        activeInstance = await this.rebindSubmittedMetadataGid(
          updatedTask,
          activeInstance,
          entry,
          returnedGid
        )
        retryTask = taskRowToDownloadTask(updatedTask, [activeInstance])
      }

      this.taskManager.set(taskId, retryTask)
      this.lifecycle.publishTaskUpdate()
      log.info(
        {
          gid: activeInstance.gid,
          taskId,
          timeoutMultiplier: RETRY_METADATA_TIMEOUT_MULTIPLIER,
        },
        'magnet metadata retry started'
      )
    } catch (err) {
      if (engineDispatchStarted && entry) {
        const marked = await this.markMetadataFailure(
          entry,
          'Magnet metadata retry submission failed',
          DownloadErrorCode.BtMetadataFailed
        )
        if (marked) await this.cleanupCacheEntryUnderMutation(entry)
      } else {
        const cached = this.cache.get(reservedGid)
        if (cached?.taskId === taskId) {
          clearTimeout(cached.timer)
          this.cache.delete(reservedGid)
        }
        const ownerRolledBack =
          reservedOwnerInstalled &&
          this.taskManager.rollbackReservedEngineTaskOwner(
            taskId,
            reservedGid,
            previousDownloadTask
          )
        if (!ownerRolledBack) {
          this.taskManager.releaseEngineTaskIdReservation(reservedGid)
        }
        if (persisted) {
          await this.runExclusivePersistence(() => {
            this.db.saveTaskWithInstances(pair)
            this.taskManager.set(taskId, previousDownloadTask)
          })
        }
        await this.cleanupMetadataDir(metadataDir)
      }
      throw err
    }
  }

  observe(raw: Aria2RawStatus): boolean {
    // Source of truth for "this gid is metadata-only, polling should
    // skip it" is the cache Map. Returning true here makes the
    // PollingScheduler's shouldSkipForPendingMagnetMetadata helper
    // bypass adoption — the metadata fetch row is owned by
    // MagnetTracker, not the generic task list. No fields read from
    // `raw` because onComplete sources its meta from the parsed
    // .torrent file (see Bug 2 regression test).
    const entry = this.cache.get(raw.gid)
    if (!entry) return false

    if (entry.failedSwapCleanup) {
      const owner = this.taskManager.getByEngineTaskId(raw.gid)
      const ownsCommittedBtInstance =
        owner?.id === entry.taskId &&
        owner.instances.some(
          (instance) =>
            instance.gid === raw.gid &&
            instance.phase === TaskInstancePhase.BtDownload
        )
      if (ownsCommittedBtInstance) {
        // The successful swap installs TaskManager ownership before releasing
        // this temporary shield. If that explicit release unexpectedly
        // failed, the next poll heals the stale cache instead of suppressing
        // legitimate BT updates forever.
        clearTimeout(entry.timer)
        this.cache.delete(raw.gid)
        return false
      }
    }

    return true
  }

  /** Cancels the metadata fetch for a task. Returns 'removed' when
   *  aria2 has confirmed the GID is gone and the cache entry has been
   *  dropped; returns 'quarantined' when the RPC cleanup failed
   *  transiently and the cache entry is retained as a tombstone for
   *  observe() to keep shielding the GID. Callers must NOT delete the
   *  persistent DB row when the result is 'quarantined', otherwise
   *  restart loses the tombstone and orphan adoption returns
   *  (Codex finding #9).
   *
   *  `options.deleteTaskRow` controls whether the cleanup-success
   *  branch should also call `db.deleteTask(taskId)`. Default true
   *  preserves the `removeTask` contract (Codex finding #15):
   *  user-initiated removal deletes the row, and a retry that
   *  succeeds after a 'quarantined' cancel still drops the Error
   *  tombstone. Set to **false** when the caller is
   *  `swapMagnetMetadataForBt` — swap reuses cancel only to drop the
   *  cache entry + tear down the aria2 metadata GID, and immediately
   *  writes a new bt_download instance under the same motrixId.
   *  Deleting the row mid-swap trips the FK constraint after
   *  `adapter.addTorrent` already accepted the new BT GID, leaving
   *  aria2 with a live orphan and the renderer with an open add-task
   *  dialog. */
  async cancel(
    taskId: string,
    options?: { deleteTaskRow?: boolean }
  ): Promise<CleanupResult> {
    if (this.stopped) return 'quarantined'
    const entry = this.findCacheEntryByTaskId(taskId)
    if (!entry) return 'removed'
    // Reset retry budget on explicit user cancel — they're asking for
    // another cleanup attempt even if the entry was previously
    // quarantined.
    entry.cleanupAttempts = 0
    entry.quarantined = false
    entry.cleanupFirstFailureAt = undefined
    entry.pendingUserDelete = options?.deleteTaskRow ?? true
    entry.hiddenTombstone = entry.pendingUserDelete
    await this.cleanupCacheEntry(entry)
    return this.cache.has(entry.gid) ? 'quarantined' : 'removed'
  }

  /**
   * Commit deferred parent deletion after the caller has durably recorded its
   * hidden removal tombstone (including Activity). removeTask initially calls
   * cancel(deleteTaskRow:false) so MagnetTracker cannot delete the parent
   * before that barrier; once the barrier completes, this intent makes an
   * in-process cleanup retry delete the parent instead of merely dropping its
   * cache shield. Restart derives the same intent from the hidden tombstone.
   */
  markPendingUserDelete(taskId: string): void {
    const entry = this.findCacheEntryByTaskId(taskId)
    if (!entry) return
    entry.pendingUserDelete = true
    entry.hiddenTombstone = true
  }

  /** Re-emit Events.MagnetFileSelection for a task whose metadata already
   *  resolved (aggStatus=MetadataReady) but whose file-selection dialog was
   *  dismissed — so the user can re-open it without re-adding the magnet.
   *  Cache-first (the entry survives onComplete); falls back to the
   *  persisted metadataDir or durable task.torrentMetaPath after a restart
   *  (primeFromDatabase skips MetadataReady rows, so there is no cache entry
   *  then). A no-op
   *  when the task is not MetadataReady (the UI button gates on this state;
   *  this guards a stale click). Throws MagnetResolveFailed when the saved
   *  .torrent is no longer on disk (e.g. an OS reboot cleared the temp dir).
   *  Routing/window handling is identical to the first emit: the bootstrap
   *  forwards MagnetFileSelection to the add-task window. */
  async reopenFileSelection(taskId: string): Promise<void> {
    const pair = this.db.getTask(taskId)
    if (!pair) {
      throw new AppError(ErrorCode.TaskNotFound, `task ${taskId} not found`)
    }
    if (pair.task.aggStatus !== TaskStatus.MetadataReady) {
      log.warn(
        { taskId, status: pair.task.aggStatus },
        'reopenFileSelection ignored: task not in MetadataReady'
      )
      return
    }

    const metaInst = pair.instances.find(
      (i) => i.phase === TaskInstancePhase.MagnetMetadataResolution
    )
    const cached = this.findCacheEntryByTaskId(taskId)
    const metadataDir =
      cached?.metadataDir ??
      (typeof metaInst?.payload.metadataDir === 'string'
        ? metaInst.payload.metadataDir
        : '')
    const magnetUri = cached?.magnetUri ?? metaInst?.uris[0] ?? ''
    const saveDir = cached?.saveDir ?? pair.task.finalPath

    let torrentBase64: string | undefined
    let sourceError: unknown
    if (metadataDir) {
      try {
        torrentBase64 = await this.readSavedTorrentBase64(metadataDir)
        if (this.stopped) return
      } catch (err) {
        sourceError = err
      }
    }
    if (torrentBase64 === undefined && pair.task.torrentMetaPath) {
      try {
        const bytes = await readFile(pair.task.torrentMetaPath)
        torrentBase64 = bytes.toString('base64')
        if (this.stopped) return
      } catch (err) {
        sourceError = err
      }
    }
    if (torrentBase64 === undefined) {
      throw new AppError(
        ErrorCode.MagnetResolveFailed,
        `saved torrent metadata is no longer available for task ${taskId}`,
        sourceError
      )
    }

    const meta = await this.torrentParser.parse(torrentBase64)
    if (this.stopped) return
    this.eventBus.emit(Events.MagnetFileSelection, {
      taskId,
      meta,
      magnetUri,
      torrentBase64,
      saveDir,
    })
    log.info({ taskId }, 'magnet file selection reopened')
  }

  /** Cancel all in-flight cleanup retry timers. Called on app shutdown
   *  so we don't leak Node timer handles or block process exit. After
   *  dispose the tracker is no longer usable; primeFromDatabase on the
   *  next session reconstructs cache + timers from persisted state. */
  dispose(): void {
    void this.stopAndDrain()
  }

  stopAndDrain(): Promise<void> {
    if (this.stopPromise) return this.stopPromise
    this.stopped = true
    for (const unsubscribe of this.unsubscribeRpc.splice(0)) {
      unsubscribe()
    }
    for (const entry of this.cache.values()) {
      clearTimeout(entry.timer)
    }
    this.cache.clear()
    this.stopPromise = this.asyncWork.stopAndDrain()
    return this.stopPromise
  }

  private armTimeout(
    gid: string,
    timeoutMultiplier = INITIAL_METADATA_TIMEOUT_MULTIPLIER
  ): ReturnType<typeof setTimeout> {
    const timeoutSec = this.settingsManager.getEngine().magnetResolveTimeout
    return setTimeout(
      () => void this.trackCallback(() => this.handleTimeout(gid)),
      timeoutSec * timeoutMultiplier * 1000
    )
  }

  private runTaskMutation<T>(
    taskId: string,
    operation: () => Promise<T>
  ): Promise<T> {
    return this.lifecycle.runTaskMutation
      ? this.lifecycle.runTaskMutation([taskId], operation)
      : operation()
  }

  private runExclusivePersistence<T>(
    operation: () => T | Promise<T>
  ): Promise<T> {
    return this.lifecycle.runExclusivePersistence
      ? this.lifecycle.runExclusivePersistence(operation)
      : Promise.resolve().then(operation)
  }

  private reserveNewEngineGid(): string {
    let lastError: unknown
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const gid = randomBytes(8).toString('hex')
      try {
        this.taskManager.reserveEngineTaskId(gid)
        return gid
      } catch (err) {
        lastError = err
      }
    }
    throw new Error('Unable to reserve a magnet metadata engine GID', {
      cause: lastError,
    })
  }

  private async rollbackMetadataSubmitBeforeDispatch(
    taskId: string,
    gid: string,
    metadataDir: string,
    reservedOwnerInstalled = false
  ): Promise<void> {
    const entry = this.cache.get(gid)
    if (entry?.taskId === taskId) {
      clearTimeout(entry.timer)
      this.cache.delete(gid)
    }

    const ownerRolledBack =
      reservedOwnerInstalled &&
      this.taskManager.rollbackReservedEngineTaskOwner(taskId, gid)
    try {
      if (this.db.getTask(taskId)) {
        const deleteParent = (): Promise<void> =>
          this.runExclusivePersistence(() => {
            this.db.deleteTask(taskId)
          })
        if (this.lifecycle.deleteParentTask) {
          await this.lifecycle.deleteParentTask(taskId, deleteParent)
        } else {
          await deleteParent()
        }
      }
    } catch (err) {
      log.error(
        { err, taskId, gid },
        'failed to roll back durable magnet parent before engine dispatch'
      )
    } finally {
      if (!ownerRolledBack) {
        this.taskManager.releaseEngineTaskIdReservation(gid)
      }
      await this.cleanupMetadataDir(metadataDir)
    }
  }

  private async rebindSubmittedMetadataGid(
    task: TaskRow,
    instance: TaskInstanceRow,
    entry: MetadataInstanceCache,
    returnedGid: string
  ): Promise<TaskInstanceRow> {
    if (!returnedGid) {
      throw new Error('aria2 returned an empty metadata GID')
    }

    const reservedGid = entry.gid
    this.taskManager.reserveEngineTaskId(returnedGid)

    // Shield the authoritative returned GID before releasing the requested
    // one. This fallback is primarily defensive (aria2 honors options.gid),
    // but it also keeps test doubles and alternative engines safe.
    clearTimeout(entry.timer)
    this.cache.delete(reservedGid)
    entry.gid = returnedGid
    entry.timer = this.armTimeout(returnedGid, entry.timeoutMultiplier)
    this.cache.set(returnedGid, entry)

    const reboundInstance: TaskInstanceRow = {
      ...instance,
      gid: returnedGid,
      updatedAt: Date.now(),
    }
    const reboundTask = taskRowToDownloadTask(
      {
        ...task,
        updatedAt: reboundInstance.updatedAt,
      },
      [reboundInstance]
    )
    this.taskManager.rollbackReservedEngineTaskOwner(entry.taskId, reservedGid)
    this.taskManager.setReservedEngineTaskOwner(
      entry.taskId,
      reboundTask,
      returnedGid
    )
    await this.runExclusivePersistence(() =>
      this.db.saveTaskWithInstances({
        task: {
          ...task,
          updatedAt: reboundInstance.updatedAt,
        },
        instances: [reboundInstance],
      })
    )
    return reboundInstance
  }

  private async compensateMetadataSubmitAfterDispatch(
    entry: MetadataInstanceCache,
    cause: unknown
  ): Promise<void> {
    entry.pendingUserDelete = true
    entry.hiddenTombstone = true
    entry.quarantined = true
    entry.retireEngineGidReservationOnCleanup = true

    try {
      await this.persistSubmitCleanupTombstone(entry, cause)
    } catch (err) {
      // The original parent is already durable and the in-memory reservation
      // remains authoritative. Continue engine compensation even if enriching
      // that parent as a hidden tombstone fails.
      log.error(
        { err, taskId: entry.taskId, gid: entry.gid },
        'failed to persist magnet submit cleanup tombstone'
      )
    }
    await this.cleanupCacheEntry(entry)
  }

  /**
   * Build the terminal occurrence for a `TaskRow`-level transition — the
   * `TaskRow`-shaped counterpart of `buildTerminalOccurrence`'s DownloadTask
   * callers elsewhere in the core/task tree. Every terminal transition this
   * class commits is engine-driven (magnet metadata fetch/submit failure),
   * so `cause` is fixed to `'engine'`.
   */
  private buildEngineOccurrence(
    task: TaskRow,
    fromStatus: TaskStatus
  ): TaskTerminalOccurrence | null {
    return buildTerminalOccurrence(
      {
        taskId: task.motrixId,
        status: task.aggStatus,
        finishedAt: task.finishedAt,
        errorCode: task.errorCode,
        errorMessage: task.errorMessage,
        errorDetailKey: task.errorDetailKey,
        errorDetailParams: task.errorDetailParams,
      },
      fromStatus,
      'engine'
    )
  }

  private async persistSubmitCleanupTombstone(
    entry: MetadataInstanceCache,
    cause: unknown
  ): Promise<void> {
    const pair = this.getCurrentFetchingMetadataPair(entry.gid, entry)
    if (!pair) return

    const now = Date.now()
    const errorMessage =
      cause instanceof Error
        ? `Magnet metadata submission failed: ${cause.message}`
        : 'Magnet metadata submission failed after engine dispatch'
    const terminal = applyTerminalTransition(
      terminalFieldsFromRow(pair.task),
      TaskStatus.Error,
      {
        errorMessage,
        errorCode: DownloadErrorCode.BtMetadataFailed,
      },
      now
    )
    const updatedTask: TaskRow = {
      ...pair.task,
      aggStatus: terminal.status,
      finishedAt: terminal.finishedAt,
      errorMessage: terminal.errorMessage,
      errorCode: terminal.errorCode,
      updatedAt: now,
    }
    const updatedInstances = pair.instances.map((instance) =>
      instance.instanceId === entry.instanceId
        ? {
            ...instance,
            status: TaskStatus.Error,
            payload: withMagnetCleanupTombstoneHidden(
              withMagnetCleanupQuarantined(instance.payload, true),
              true
            ),
            updatedAt: now,
          }
        : instance
    )
    const updatedDownloadTask = taskRowToDownloadTask(
      updatedTask,
      updatedInstances
    )
    // Hidden tombstone — no user-visible occurrence; aligned with
    // removeTask/swap behavior. `persistSubmitCleanupTombstone` is only ever
    // called from `compensateMetadataSubmitAfterDispatch`, which always sets
    // `entry.hiddenTombstone = true` first, so this write never represents a
    // user-facing terminal transition worth surfacing.
    await this.runExclusivePersistence(async () => {
      this.db.persistTaskWithOccurrence(
        { task: updatedTask, instances: updatedInstances },
        null
      )
      await this.recordExactTransition(
        taskRowToDownloadTask(pair.task, pair.instances),
        updatedDownloadTask,
        now
      )
      if (this.stopped) return
      this.taskManager.setReservedEngineTaskOwner(
        entry.taskId,
        updatedDownloadTask,
        entry.gid
      )
    })
  }

  private findCacheEntryByTaskId(
    taskId: string
  ): MetadataInstanceCache | undefined {
    for (const entry of this.cache.values()) {
      if (entry.taskId === taskId) return entry
    }
    return undefined
  }

  private getCurrentFetchingMetadataPair(
    gid: string,
    entry: MetadataInstanceCache
  ): TaskWithInstances | null {
    if (this.cache.get(gid) !== entry) return null
    const pair = this.db.getTask(entry.taskId)
    if (
      !pair ||
      pair.task.taskType !== TaskType.Magnet ||
      pair.task.aggStatus !== TaskStatus.FetchingMetadata ||
      pair.instances.length !== 1
    ) {
      return null
    }
    const instance = pair.instances[0]
    if (
      instance.instanceId !== entry.instanceId ||
      instance.gid !== gid ||
      instance.phase !== TaskInstancePhase.MagnetMetadataResolution ||
      instance.status !== TaskStatus.FetchingMetadata
    ) {
      return null
    }
    return pair
  }

  private async onComplete(gid: string): Promise<void> {
    const entry = this.cache.get(gid)
    if (!entry) return
    await this.runTaskMutation(entry.taskId, () =>
      this.onCompleteUnderMutation(gid, entry)
    )
  }

  private async onCompleteUnderMutation(
    gid: string,
    entry: MetadataInstanceCache
  ): Promise<void> {
    if (!this.getCurrentFetchingMetadataPair(gid, entry)) return

    let torrentBase64: string
    let meta: Awaited<ReturnType<TorrentParser['parse']>>
    try {
      // The file list MUST come from parsing the saved .torrent
      // bencode, not from aria2's `tellStatus.files`. For a
      // bt-metadata-only=true task, aria2 reports `files` as the
      // single .torrent file it was downloading (1 entry) — not the
      // torrent's contained files. Trusting raw.files emitted a
      // truncated meta and the add-task dialog showed only 1 file
      // even for multi-file torrents (the user could then only
      // download that one file). Parsing the actual .torrent bytes
      // is the canonical source of truth.
      torrentBase64 = await this.readSavedTorrentBase64(entry.metadataDir)
      if (this.stopped) return
      meta = await this.torrentParser.parse(torrentBase64)
      if (this.stopped) return
    } catch (err) {
      log.error({ err, gid }, 'failed to process magnet metadata')
      // aria2 completed the metadata transfer, but the saved .torrent could
      // not be read or parsed. This is still a terminal, user-visible metadata
      // failure: commit DB → TaskManager → TaskUpdated before cleanup so the
      // current session can never remain stuck on FetchingMetadata.
      const marked = await this.markMetadataFailure(
        entry,
        'Magnet metadata processing failed',
        DownloadErrorCode.BtMetadataFailed
      )
      if (marked) await this.cleanupCacheEntry(entry)
      return
    }

    // Parsing succeeded. Everything below belongs to the MetadataReady success
    // path and intentionally sits outside the processing-failure catch.
    // EventBus follows synchronous propagation semantics; if a listener throws,
    // the callback rejects without reversing durable state or running cleanup.
    const metadataResultRemoved = await this.removeMetadataResult(gid)
    if (!metadataResultRemoved) {
      // Never publish MetadataReady while aria2 may still retain the metadata
      // GID. primeFromDatabase intentionally skips ordinary Ready rows, so a
      // restart would otherwise lose the adoption shield and let polling
      // merge the surviving engine row over the resolved selection. Surface a
      // recoverable Error/quarantine owner instead; cleanup retries retain the
      // cache now and primeFromDatabase restores it after restart.
      const marked = await this.markMetadataFailure(
        entry,
        'Magnet metadata result cleanup could not be confirmed',
        DownloadErrorCode.BtMetadataFailed,
        true
      )
      if (marked) await this.cleanupCacheEntry(entry)
      return
    }
    if (this.stopped) return
    const pair = this.getCurrentFetchingMetadataPair(gid, entry)
    if (!pair) return
    clearTimeout(entry.timer)

    // Promote DB + TaskManager state to MetadataReady so the
    // Downloads list pill flips from "Fetching" to "Ready". The
    // cache entry + task_instances row stay alive (still
    // phase=magnet_metadata_resolution) so a crash during the
    // confirmation dialog can resume.
    const now = Date.now()
    const updatedTask: TaskRow = {
      ...pair.task,
      aggStatus: TaskStatus.MetadataReady,
      // Carry the resolved torrent name through to the row so the
      // user sees "video.mp4" instead of "[METADATA] magnet:?…"
      // while reviewing files in the dialog.
      name: meta.name || pair.task.name,
      updatedAt: now,
    }
    const updatedInstances: TaskInstanceRow[] = pair.instances.map((i) =>
      i.instanceId === entry.instanceId
        ? {
            ...i,
            status: TaskStatus.MetadataReady,
            updatedAt: now,
          }
        : i
    )
    const updatedDownloadTask = taskRowToDownloadTask(
      updatedTask,
      updatedInstances
    )
    await this.runExclusivePersistence(async () => {
      this.db.saveTaskWithInstances({
        task: updatedTask,
        instances: updatedInstances,
      })
      await this.recordExactTransition(
        taskRowToDownloadTask(pair.task, pair.instances),
        updatedDownloadTask,
        now
      )
      if (this.stopped) return
      this.taskManager.set(entry.taskId, updatedDownloadTask)
      this.lifecycle.publishTaskUpdate()
    })
    if (this.stopped) return

    this.eventBus.emit(Events.MagnetFileSelection, {
      taskId: entry.taskId,
      meta,
      magnetUri: entry.magnetUri,
      torrentBase64,
      saveDir: entry.saveDir,
    })

    log.info(
      { gid, taskId: entry.taskId, name: meta.name },
      'magnet metadata resolved'
    )
  }

  private async onError(gid: string): Promise<void> {
    const entry = this.cache.get(gid)
    if (!entry) return
    await this.runTaskMutation(entry.taskId, () =>
      this.onErrorUnderMutation(gid, entry)
    )
  }

  private async onErrorUnderMutation(
    gid: string,
    entry: MetadataInstanceCache
  ): Promise<void> {
    if (!this.getCurrentFetchingMetadataPair(gid, entry)) return
    log.warn({ gid, taskId: entry.taskId }, 'magnet metadata fetch failed')
    const marked = await this.markMetadataFailure(
      entry,
      'Magnet metadata fetch failed',
      DownloadErrorCode.BtMetadataFailed
    )
    if (marked) await this.cleanupCacheEntry(entry)
  }

  private async handleTimeout(gid: string): Promise<void> {
    const entry = this.cache.get(gid)
    if (!entry) return
    await this.runTaskMutation(entry.taskId, () =>
      this.handleTimeoutUnderMutation(gid, entry)
    )
  }

  private async handleTimeoutUnderMutation(
    gid: string,
    entry: MetadataInstanceCache
  ): Promise<void> {
    if (!this.getCurrentFetchingMetadataPair(gid, entry)) return
    log.warn({ gid, taskId: entry.taskId }, 'magnet metadata fetch timed out')
    const marked = await this.markMetadataFailure(
      entry,
      'Magnet metadata fetch timed out',
      DownloadErrorCode.Timeout
    )
    if (marked) await this.cleanupCacheEntry(entry)
  }

  private async markMetadataFailure(
    entry: MetadataInstanceCache,
    errorMessage: string,
    errorCode: DownloadErrorCode,
    cleanupQuarantined = false
  ): Promise<boolean> {
    const pair = this.getCurrentFetchingMetadataPair(entry.gid, entry)
    if (!pair) return false

    const now = Date.now()
    const terminal = applyTerminalTransition(
      terminalFieldsFromRow(pair.task),
      TaskStatus.Error,
      { errorMessage, errorCode },
      now
    )
    const updatedTask: TaskRow = {
      ...pair.task,
      aggStatus: terminal.status,
      finishedAt: terminal.finishedAt,
      errorMessage: terminal.errorMessage,
      errorCode: terminal.errorCode,
      updatedAt: now,
    }
    const updatedInstances: TaskInstanceRow[] = pair.instances.map(
      (instance) =>
        instance.instanceId === entry.instanceId
          ? {
              ...instance,
              status: TaskStatus.Error,
              payload: cleanupQuarantined
                ? withMagnetCleanupQuarantined(instance.payload, true)
                : instance.payload,
              updatedAt: now,
            }
          : instance
    )

    const updatedDownloadTask = taskRowToDownloadTask(
      updatedTask,
      updatedInstances
    )
    const occurrence = this.buildEngineOccurrence(
      updatedTask,
      pair.task.aggStatus
    )
    await this.runExclusivePersistence(async () => {
      this.db.persistTaskWithOccurrence(
        { task: updatedTask, instances: updatedInstances },
        occurrence
      )
      await this.recordExactTransition(
        taskRowToDownloadTask(pair.task, pair.instances),
        updatedDownloadTask,
        now,
        occurrence?.occurrenceId ?? null
      )
      if (this.stopped) return
      this.taskManager.set(entry.taskId, updatedDownloadTask)
      if (occurrence) {
        this.lifecycle.publishTaskUpdateNow()
      } else {
        this.lifecycle.publishTaskUpdate()
      }
    })
    if (occurrence) {
      if (!this.lifecycle.occurrenceDispatcher) {
        warnOccurrenceUndispatchable(
          log,
          { taskId: entry.taskId, occurrenceId: occurrence.occurrenceId },
          'markMetadataFailure'
        )
      }
      await this.lifecycle.occurrenceDispatcher?.dispatch(occurrence)
    }
    if (cleanupQuarantined) entry.quarantined = true
    if (this.stopped) return true
    return true
  }

  /** Re-entrancy guard (Codex finding #14). If another cleanup for
   *  the same entry is in flight (e.g. timeout fired while user
   *  cancel was already running), coalesce by awaiting the same
   *  Promise instead of starting a parallel run. */
  private async cleanupCacheEntry(entry: MetadataInstanceCache): Promise<void> {
    await this.runTaskMutation(entry.taskId, () =>
      this.cleanupCacheEntryUnderMutation(entry)
    )
  }

  private async cleanupCacheEntryUnderMutation(
    entry: MetadataInstanceCache
  ): Promise<void> {
    if (entry.cleanupInFlight) {
      return entry.cleanupInFlight
    }
    entry.cleanupInFlight = this.doCleanupCacheEntry(entry)
    try {
      await entry.cleanupInFlight
    } finally {
      entry.cleanupInFlight = undefined
    }
  }

  private async doCleanupCacheEntry(
    entry: MetadataInstanceCache
  ): Promise<void> {
    clearTimeout(entry.timer)

    // Codex finding #3: only drop cache + local state when aria2 is
    // confirmed to no longer have the GID. Codex finding #5: bounded
    // retry — unbounded retry on a long aria2 outage pins memory,
    // hides failure from the user, and survives across restart
    // because primeFromDatabase would re-arm the timer.
    const ariaRemoved = await this.tryRemoveFromAria2(entry.gid)
    if (this.stopped) return
    const artifactsRemoved =
      ariaRemoved && entry.cleanupArtifactPaths.length > 0
        ? await this.tryCleanupArtifactPaths(entry)
        : ariaRemoved
    if (this.stopped) return
    if (!ariaRemoved || !artifactsRemoved) {
      await this.deferCleanup(
        entry,
        'aria2 or failed-swap artifact cleanup did not complete'
      )
      return
    }

    let restoredGraphPublished = false
    try {
      if (entry.restoreGraph) {
        // A pre-add failed-swap reservation is not a user deletion. Restore
        // the exact MetadataReady parent/instances/files graph that existed
        // before the reservation; only this durable write releases ownership.
        const restoreGraph = entry.restoreGraph
        const restoredTask = taskRowToDownloadTask(
          restoreGraph.task,
          restoreGraph.instances
        )
        await this.runExclusivePersistence(() => {
          this.db.saveTaskWithInstancesAndFiles(restoreGraph)
          this.taskManager.set(entry.taskId, restoredTask)
          if (entry.retireEngineGidReservationOnCleanup) {
            this.taskManager.retireEngineTaskIdReservation(entry.gid)
          }
        })
        restoredGraphPublished = true
      } else if (entry.pendingUserDelete) {
        // Codex finding #15: the user removed this task via the
        // Downloads UI. A removed task should never linger as an Error
        // tombstone.
        const deleteParent = (): Promise<void> =>
          this.runExclusivePersistence(() => {
            this.db.deleteTask(entry.taskId)
            if (entry.retireEngineGidReservationOnCleanup) {
              this.taskManager.remove(entry.taskId)
              this.taskManager.retireEngineTaskIdReservation(entry.gid)
            }
          })
        if (this.lifecycle.deleteParentTask) {
          await this.lifecycle.deleteParentTask(entry.taskId, deleteParent)
        } else {
          await deleteParent()
        }
      }
    } catch (err) {
      await this.deferCleanup(entry, 'durable cleanup finalization failed', err)
      return
    }
    if (this.stopped) return

    this.cache.delete(entry.gid)
    if (restoredGraphPublished) {
      this.lifecycle.publishTaskUpdate()
    } else if (!entry.pendingUserDelete && entry.failedSwapCleanup) {
      const pair = entry.restoreGraph ?? this.db.getTask(entry.taskId)
      if (pair) {
        this.taskManager.set(
          entry.taskId,
          taskRowToDownloadTask(pair.task, pair.instances)
        )
        this.lifecycle.publishTaskUpdate()
      }
    }
    if (entry.cleanupArtifactPaths.length === 0) {
      await this.cleanupMetadataDir(entry.metadataDir)
    }
  }

  private async deferCleanup(
    entry: MetadataInstanceCache,
    reason: string,
    err?: unknown
  ): Promise<void> {
    entry.cleanupAttempts += 1
    entry.cleanupFirstFailureAt ??= Date.now()

    if (entry.cleanupAttempts >= MAX_CLEANUP_ATTEMPTS) {
      // Give up automatic retries — but DO NOT drop the cache entry
      // (Codex finding #6). aria2 may still own the GID, or the durable
      // reservation may still need restoration. Keeping the entry shields
      // polling, while the DB reservation re-arms cleanup after restart.
      log.error(
        {
          err,
          reason,
          gid: entry.gid,
          taskId: entry.taskId,
          attempts: entry.cleanupAttempts,
          firstFailureAt: entry.cleanupFirstFailureAt,
        },
        'magnet metadata cleanup quarantined: max attempts reached'
      )
      entry.quarantined = true
      const pair = this.db.getTask(entry.taskId)
      if (pair) {
        const now = Date.now()
        const terminal = applyTerminalTransition(
          terminalFieldsFromRow(pair.task),
          TaskStatus.Error,
          {
            errorMessage:
              pair.task.errorMessage ??
              'Magnet metadata cleanup is quarantined',
          },
          now
        )
        const updatedTask: TaskRow = {
          ...pair.task,
          torrentMetaPath: entry.failedSwapCleanup
            ? entry.torrentMetaPath
            : pair.task.torrentMetaPath,
          aggStatus: terminal.status,
          finishedAt: terminal.finishedAt,
          errorMessage: terminal.errorMessage,
          errorCode: terminal.errorCode,
          updatedAt: now,
        }
        const updatedInstances = pair.instances.map((instance) => {
          if (instance.instanceId !== entry.instanceId) return instance
          let payload = withMagnetCleanupTombstoneHidden(
            withMagnetCleanupQuarantined(instance.payload, true),
            entry.hiddenTombstone
          )
          if (entry.failedSwapCleanup) {
            payload = withMagnetCleanupArtifactPaths(
              { ...payload, metadataDir: entry.metadataDir },
              entry.cleanupArtifactPaths
            )
          }
          return {
            ...instance,
            gid: entry.failedSwapCleanup ? entry.gid : instance.gid,
            diskPath: entry.failedSwapCleanup
              ? entry.metadataDir
              : instance.diskPath,
            status: TaskStatus.Error,
            payload,
            updatedAt: now,
          }
        })
        try {
          if (
            entry.failedSwapCleanup &&
            entry.hiddenTombstone &&
            !entry.restoreGraph
          ) {
            entry.pendingUserDelete = true
          }
          const updatedDownloadTask = taskRowToDownloadTask(
            updatedTask,
            updatedInstances
          )
          // Hidden tombstone — no user-visible occurrence; aligned with
          // removeTask/swap behavior. A hidden tombstone is removed from
          // taskManager right below (never shown to the user), so it must
          // not also surface as a terminal occurrence. A non-hidden
          // quarantine (the normal "cleanup stuck" Error the user still
          // sees in their Downloads list) still gets one.
          const occurrence = entry.hiddenTombstone
            ? null
            : this.buildEngineOccurrence(updatedTask, pair.task.aggStatus)
          await this.runExclusivePersistence(async () => {
            this.db.persistTaskWithOccurrence(
              { task: updatedTask, instances: updatedInstances },
              occurrence
            )
            await this.recordExactTransition(
              taskRowToDownloadTask(pair.task, pair.instances),
              updatedDownloadTask,
              now,
              occurrence?.occurrenceId ?? null
            )
            if (this.stopped) return
            if (entry.hiddenTombstone) {
              this.taskManager.remove(entry.taskId)
            } else {
              this.taskManager.set(entry.taskId, updatedDownloadTask)
            }
            if (occurrence) {
              this.lifecycle.publishTaskUpdateNow()
            } else {
              this.lifecycle.publishTaskUpdate()
            }
          })
          if (occurrence) {
            if (!this.lifecycle.occurrenceDispatcher) {
              warnOccurrenceUndispatchable(
                log,
                { taskId: entry.taskId, occurrenceId: occurrence.occurrenceId },
                'deferCleanup'
              )
            }
            await this.lifecycle.occurrenceDispatcher?.dispatch(occurrence)
          }
        } catch (persistError) {
          log.error(
            { err: persistError, gid: entry.gid, taskId: entry.taskId },
            'failed to persist terminal magnet cleanup quarantine'
          )
        }
      }
      return
    }

    const backoffMs =
      RETRY_DELAY_MS * BACKOFF_MULTIPLIER ** (entry.cleanupAttempts - 1)
    log.warn(
      {
        err,
        reason,
        gid: entry.gid,
        taskId: entry.taskId,
        attempt: entry.cleanupAttempts,
        backoffMs,
      },
      'metadata cleanup deferred, retrying with backoff'
    )
    entry.timer = setTimeout(
      () => void this.trackCallback(() => this.cleanupCacheEntry(entry)),
      backoffMs
    )
  }

  private async recordExactTransition(
    previous: DownloadTask,
    next: DownloadTask,
    occurredAt: number,
    occurrenceId: string | null = null
  ): Promise<void> {
    if (!this.lifecycle.recordTransition || previous.status === next.status) {
      return
    }
    try {
      await this.lifecycle.recordTransition({
        taskId: next.id,
        previousStatus: previous.status,
        nextStatus: next.status,
        occurredAt,
        monotonicAt: this.lifecycle.monotonicNow?.() ?? performance.now(),
        accuracy: 'exact',
        errorCode: next.errorCode,
        errorMessage: next.errorMessage,
        errorDetailKey: next.errorDetailKey,
        errorDetailParams: next.errorDetailParams,
        occurrenceId,
      })
    } catch (err) {
      log.error(
        { err, taskId: next.id },
        'magnet Activity transition recording failed'
      )
    }
  }

  private storeUnsubscribe(unsubscribe: unknown): void {
    if (typeof unsubscribe === 'function') {
      this.unsubscribeRpc.push(unsubscribe as () => void)
    }
  }

  private trackCallback(operation: () => Promise<void>): Promise<void> {
    if (this.stopped) return Promise.resolve()
    const work = this.asyncWork.run(operation)
    void work.catch((err) => {
      log.error({ err }, 'magnet callback failed')
    })
    return work
  }

  /** Best-effort removal of `gid` from aria2. Returns true when aria2
   *  is confirmed to no longer have the GID — either explicit success
   *  or a not-found error (treated as "already removed"). Returns
   *  false on transient RPC failures; the caller must keep the cache
   *  entry and retry. */
  private async tryRemoveFromAria2(gid: string): Promise<boolean> {
    let forceRemoveError: unknown
    try {
      await this.rpcClient.forceRemove(gid)
    } catch (err) {
      if (!isAria2NotFoundError(err, gid)) {
        forceRemoveError = err
        log.warn({ err, gid }, 'forceRemove failed with transient error')
      }
      // not-found ⇒ aria2 already discarded the active row.
    }

    try {
      await this.rpcClient.removeDownloadResult(gid)
    } catch (err) {
      if (!isAria2NotFoundError(err, gid)) {
        log.warn(
          { err, gid, forceRemoveError },
          'removeDownloadResult failed with transient error'
        )
        return false
      }
      // not-found ⇒ history row already purged.
    }

    // A successful result purge (or its explicit GID-not-found response) is
    // authoritative absence even if forceRemove raced a stopped/completed row
    // and failed. Do not strand that already-absent GID in quarantine.
    return true
  }

  private async tryCleanupArtifactPaths(
    entry: MetadataInstanceCache
  ): Promise<boolean> {
    let removed = true
    for (const artifactPath of entry.cleanupArtifactPaths) {
      if (!isSafeSwapCleanupArtifactPath(entry, artifactPath)) {
        log.error(
          { artifactPath, taskId: entry.taskId, gid: entry.gid },
          'refusing unsafe failed-swap artifact cleanup path'
        )
        removed = false
        continue
      }
      try {
        await rm(artifactPath, { recursive: true, force: true })
      } catch (err) {
        log.warn(
          { err, artifactPath, taskId: entry.taskId, gid: entry.gid },
          'failed-swap artifact cleanup deferred'
        )
        removed = false
      }
    }
    return removed
  }

  private async removeMetadataResult(gid: string): Promise<boolean> {
    let firstResultError: unknown
    try {
      await this.rpcClient.removeDownloadResult(gid)
      return true
    } catch (err) {
      if (isAria2NotFoundError(err, gid)) return true
      firstResultError = err
      // Complete notifications can still arrive before aria2 moves the row
      // to history. Ask it to stop the row, then retry the authoritative
      // result purge below.
    }

    let removeError: unknown
    try {
      await this.rpcClient.remove(gid)
    } catch (err) {
      if (!isAria2NotFoundError(err, gid)) removeError = err
    }
    try {
      await this.rpcClient.removeDownloadResult(gid)
      return true
    } catch (err) {
      if (isAria2NotFoundError(err, gid)) return true
      log.warn(
        { err, gid, firstResultError, removeError },
        'metadata result cleanup could not confirm aria2 absence'
      )
      return false
    }
  }

  private async cleanupMetadataDir(metadataDir: string): Promise<void> {
    if (!metadataDir) return
    try {
      await rm(metadataDir, { recursive: true, force: true })
    } catch {
      /* Temporary metadata directory cleanup is best-effort. */
    }
  }

  private async readSavedTorrentBase64(metadataDir: string): Promise<string> {
    const entries = await readdir(metadataDir)
    const torrentFiles = await Promise.all(
      entries
        .filter((name) => name.toLowerCase().endsWith('.torrent'))
        .map(async (name) => {
          const filePath = join(metadataDir, name)
          const fileStat = await stat(filePath)
          return fileStat.isFile()
            ? { filePath, mtimeMs: fileStat.mtimeMs }
            : null
        })
    )

    const newest = torrentFiles
      .filter((file): file is { filePath: string; mtimeMs: number } =>
        Boolean(file)
      )
      .sort((a, b) => b.mtimeMs - a.mtimeMs)[0]

    if (!newest) {
      throw new Error(
        `resolved magnet torrent metadata file not found in ${metadataDir}`
      )
    }

    const bytes = await readFile(newest.filePath)
    return Buffer.from(bytes).toString('base64')
  }
}

// ─── helpers ─────────────────────────────────────────────────

function metadataFetchPayload(
  metadataDir: string,
  timeoutMultiplier: number
): Record<string, unknown> {
  return withMagnetCleanupTombstoneHidden(
    withMagnetCleanupQuarantined(
      {
        metadataDir,
        [METADATA_TIMEOUT_MULTIPLIER_PAYLOAD_KEY]: timeoutMultiplier,
      },
      false
    ),
    false
  )
}

function metadataTimeoutMultiplier(payload: Record<string, unknown>): number {
  return payload[METADATA_TIMEOUT_MULTIPLIER_PAYLOAD_KEY] ===
    RETRY_METADATA_TIMEOUT_MULTIPLIER
    ? RETRY_METADATA_TIMEOUT_MULTIPLIER
    : INITIAL_METADATA_TIMEOUT_MULTIPLIER
}

function truncateName(uri: string): string {
  if (uri.length <= 64) return uri
  return `${uri.slice(0, 60)}…`
}

function isAria2NotFoundError(err: unknown, gid: string): boolean {
  if (!(err instanceof Error)) return false
  // aria2 has no structured error code for missing GIDs in JSON-RPC,
  // so we have to substring-match the message.
  //
  // Codex finding #10: a bare not-found match conflates aria2's own
  // "GID#abc is not found" with HTTP 404, JSON-RPC method-not-found,
  // and DNS no-such-host. Treating any of those as "GID gone" causes
  // orphan adoption. Require the message to also reference either
  // this specific gid or one of the aria2 GID-specific keywords.
  const msg = err.message.toLowerCase()
  const gidLower = gid.toLowerCase()

  const hasNotFoundPhrase =
    msg.includes('not found') ||
    msg.includes('cannot find') ||
    msg.includes('no such')
  if (!hasNotFoundPhrase) return false

  return (
    msg.includes(gidLower) || msg.includes('gid') || msg.includes('download')
  )
}

function isSafeSwapCleanupArtifactPath(
  entry: MetadataInstanceCache,
  artifactPath: string
): boolean {
  if (!isAbsolute(artifactPath)) return false
  const normalized = resolve(artifactPath)
  if (normalized === parse(normalized).root) return false

  const metadataDir = entry.metadataDir ? resolve(entry.metadataDir) : ''
  const saveDir = entry.saveDir ? resolve(entry.saveDir) : ''
  if (
    normalized === metadataDir &&
    dirname(normalized) === saveDir &&
    basename(normalized).length > '.motrix'.length &&
    normalized.toLowerCase().endsWith('.motrix')
  ) {
    return true
  }

  const indexedWorkspace = saveDir
    ? resolve(btWorkspacePath(entry.taskId, saveDir))
    : ''
  if (
    normalized === metadataDir &&
    normalized === indexedWorkspace &&
    dirname(normalized) === resolve(saveDir, '.motrix')
  ) {
    return true
  }

  const torrentMetaPath = entry.torrentMetaPath
    ? resolve(entry.torrentMetaPath)
    : ''
  const torrentMetaDir = entry.torrentMetaDir
    ? resolve(entry.torrentMetaDir)
    : ''
  return (
    normalized === torrentMetaPath &&
    torrentMetaDir.length > 0 &&
    dirname(normalized) === torrentMetaDir &&
    basename(normalized) === `${entry.taskId}.torrent`
  )
}

function extractInfoHash(magnetUri: string): string {
  try {
    const params = new URL(magnetUri).searchParams
    for (const xt of params.getAll('xt')) {
      const normalized = normalizeBtih(xt)
      if (normalized) return normalized
    }
  } catch {
    /* Fall through to schema-safe placeholder. */
  }

  return UNKNOWN_INFO_HASH
}

function normalizeBtih(xt: string): string | null {
  const prefix = 'urn:btih:'
  if (!xt.toLowerCase().startsWith(prefix)) return null

  const hash = xt.slice(prefix.length).trim()
  if (HEX_INFO_HASH_RE.test(hash)) return hash.toLowerCase()
  if (BASE32_INFO_HASH_RE.test(hash)) return base32ToHex(hash)

  return null
}

function base32ToHex(input: string): string {
  let bits = ''
  for (const char of input.toUpperCase()) {
    const value = BASE32_ALPHABET.indexOf(char)
    bits += value.toString(2).padStart(5, '0')
  }

  let hex = ''
  for (let i = 0; i < bits.length; i += 4) {
    hex += Number.parseInt(bits.slice(i, i + 4), 2).toString(16)
  }

  return hex
}
