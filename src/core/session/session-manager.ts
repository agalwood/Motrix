import fs from 'node:fs'
import { newEngineTaskId, newTaskId } from '@core/lib/ids'
import { getLogger } from '@core/logger'
import { parseDirectReplayRecipe } from '@shared/schemas/direct-replay-recipe'
import type { DownloadTask } from '@shared/types/task'
import {
  makeDefaultBtExtension,
  TaskInstancePhase,
  TaskStatus,
  TaskType,
  TransitionPhase,
} from '@shared/types/task'
import {
  isMediaKind,
  isTorrentLike,
  isTorrentLikeType,
} from '@shared/types/task-actions'
import type { TaskOccurrence } from '@shared/types/task-occurrence'
import type { Aria2RpcClient } from '../engine/aria2/aria2-rpc-client'
import {
  computeEta,
  derivePathsFromRaw,
  extractUris,
  translateBtExtension,
  translateErrorCode,
  translateRawToTask,
  translateStatus,
} from '../engine/aria2/translate'
import type { Aria2RawStatus } from '../engine/aria2/types'
import type {
  DirectResourceMetadataProfile,
  EngineAdapter,
} from '../engine/engine-adapter'
import {
  buildTerminalOccurrence,
  terminalSnapshotFromTask,
} from '../task/actions/shared'
import {
  applyTerminalTransition,
  terminalFieldsFromRow,
} from '../task/apply-terminal-transition'
import { shouldPrioritizeBtPreviewPiecesFromMetadata } from '../task/bt-storage-layout'
import {
  canMirrorAria2MetadataHeaders,
  type DirectResourceProxyOptionsProvider,
  DirectResourceValidatorService,
} from '../task/direct-resource-validator'
import { isTempPath } from '../task/paths'
import { setTaskTransitionPhase } from '../task/task-instance'
import type { TaskManager } from '../task/task-manager'
import { taskRowToDownloadTask } from '../task/task-row-to-download-task'
import { isMagnetCleanupTombstoneHidden } from '../torrent/magnet-cleanup-quarantine'
import { computeUriHash, deriveInfoHash } from './content-key'
import { DirectRecoveryPlanner } from './direct-recovery-planner'
import type {
  MotrixDatabase,
  TaskInstanceRow,
  TaskRow,
  TaskWithInstances,
} from './motrix-database'

const log = getLogger('SessionManager')

async function fetchAll(
  fetcher: (offset: number, num: number) => Promise<Aria2RawStatus[]>,
  pageSize = 1000
): Promise<Aria2RawStatus[]> {
  const all: Aria2RawStatus[] = []
  let offset = 0
  while (true) {
    const page = await fetcher(offset, pageSize)
    all.push(...page)
    if (page.length < pageSize) break
    offset += pageSize
  }
  return all
}

/**
 * aria2's live task store and stopped-history store can contain the same GID
 * at the same time. This happens when a resumable HTTP task has a historical
 * error row but its current task row is paused/waiting. tellStopped is history,
 * not a newer lifecycle observation, so a stopped duplicate must never
 * overwrite the active/waiting row during restore.
 *
 * The caller supplies rows in fallback order: active, then waiting, then
 * stopped. Conflicting GIDs are re-read through tellStatus so a task that
 * genuinely completed during the concurrent list snapshots still settles to
 * its terminal state. First row wins only when that arbitration fails.
 */
const DUPLICATE_GID_ARBITRATION_CONCURRENCY = 16

async function resolveCurrentAria2Rows(
  rpc: Pick<Aria2RpcClient, 'tellStatus'>,
  activeTasks: readonly Aria2RawStatus[],
  waitingTasks: readonly Aria2RawStatus[],
  stoppedTasks: readonly Aria2RawStatus[]
): Promise<{
  tasks: Aria2RawStatus[]
  ignoredDuplicateCount: number
  duplicateGidCount: number
  arbitrationFailureCount: number
  ignoredDuplicateSample: Array<{
    gid: string
    keptStatus: string
    ignoredStatus: string
  }>
}> {
  const tasks: Aria2RawStatus[] = []
  const ignoredDuplicateSample: Array<{
    gid: string
    keptStatus: string
    ignoredStatus: string
  }> = []
  const currentStatusByGid = new Map<string, string>()
  const taskIndexByGid = new Map<string, number>()
  const duplicateGids = new Set<string>()
  let ignoredDuplicateCount = 0

  for (const group of [activeTasks, waitingTasks, stoppedTasks]) {
    for (const task of group) {
      const currentStatus = currentStatusByGid.get(task.gid)
      if (currentStatus !== undefined) {
        ignoredDuplicateCount += 1
        duplicateGids.add(task.gid)
        if (ignoredDuplicateSample.length < 20) {
          ignoredDuplicateSample.push({
            gid: task.gid,
            keptStatus: currentStatus,
            ignoredStatus: task.status,
          })
        }
        continue
      }
      currentStatusByGid.set(task.gid, task.status)
      taskIndexByGid.set(task.gid, tasks.length)
      tasks.push(task)
    }
  }

  // The three list RPCs above are concurrent snapshots. A task can complete
  // between tellActive and tellStopped, so fixed source priority alone could
  // discard a genuinely newer terminal row. Resolve only conflicting GIDs
  // through tellStatus, which is aria2's current authoritative view. Bound the
  // fan-out so a large retained history cannot create an RPC burst at startup.
  const gids = [...duplicateGids]
  let arbitrationFailureCount = 0
  for (
    let offset = 0;
    offset < gids.length;
    offset += DUPLICATE_GID_ARBITRATION_CONCURRENCY
  ) {
    const batch = gids.slice(
      offset,
      offset + DUPLICATE_GID_ARBITRATION_CONCURRENCY
    )
    const results = await Promise.allSettled(
      batch.map((gid) => rpc.tellStatus(gid))
    )
    for (let i = 0; i < results.length; i++) {
      const gid = batch[i]
      const result = results[i]
      const taskIndex = taskIndexByGid.get(gid)
      if (
        result.status === 'fulfilled' &&
        result.value.gid === gid &&
        taskIndex !== undefined
      ) {
        tasks[taskIndex] = result.value
      } else {
        arbitrationFailureCount += 1
      }
    }
  }

  for (const duplicate of ignoredDuplicateSample) {
    const taskIndex = taskIndexByGid.get(duplicate.gid)
    if (taskIndex !== undefined) {
      duplicate.keptStatus = tasks[taskIndex].status
    }
  }

  return {
    tasks,
    ignoredDuplicateCount,
    duplicateGidCount: duplicateGids.size,
    arbitrationFailureCount,
    ignoredDuplicateSample,
  }
}

// Trailing-edge debounce window for requestSave(). 50ms is large enough
// that a synchronous burst of identity/transition writes (e.g. pasting
// 100 URLs in AddTaskWindow → 100 createAndPersist calls in the same
// IPC tick) collapses into a single SQLite transaction, but small
// enough that a user-initiated single-task add still feels durable
// when the IPC call resolves.
const REQUEST_SAVE_DEBOUNCE_MS = 50

export class SessionManager {
  private autoSaveTimer: ReturnType<typeof setInterval> | null = null
  /**
   * Serializes every task persistence mutation. The tail is deliberately
   * converted back to a resolved promise after each operation so one failed
   * write cannot poison later saves or history deletion.
   */
  private persistenceTail: Promise<void> = Promise.resolve()
  // Auto-save is gated on engine activity. The periodic save only flushes
  // in-progress byte counts, which change exclusively while the engine has
  // active/seeding tasks (aria2 getGlobalStat.numActive > 0). Discrete state
  // changes (transitions, completion, discovery) persist immediately via
  // requestSave/persist, so while the engine is idle the periodic tick has
  // nothing to flush — arming it would just rewrite the whole task history
  // every interval for nothing.
  private autoSaveIntervalMs: number | null = null
  private engineActive = false
  // Pending requestSave promise. Multiple requestSave() calls inside
  // the 50ms window all `await` the same promise — guarantees
  // "function returned ⟹ a save covering at least your changes has
  // committed". Cleared as soon as the underlying save() resolves so
  // a subsequent burst opens a new window.
  private requestedSave: Promise<void> | null = null
  private requestedSaveTimer: ReturnType<typeof setTimeout> | null = null
  private resolveRequestedSave: (() => void) | null = null
  private stopping = false
  private stopPromise: Promise<void> | null = null

  constructor(
    private taskManager: TaskManager,
    private rpc: Aria2RpcClient,
    private db: MotrixDatabase,
    private adapter: EngineAdapter,
    /**
     * Root dir under which media (hls/dash/mux) segment downloads are written
     * (app temp/motrix-media). Segment downloads run on the shared aria2 daemon
     * and get persisted in aria2's session; on restart `restore()` must skip
     * them so they are not adopted as phantom standalone tasks. Optional so test
     * and non-media callers can omit it.
     */
    private mediaTmpRoot?: string,
    private directRecoveryPlanner: Pick<
      DirectRecoveryPlanner,
      'plan'
    > = new DirectRecoveryPlanner(),
    private directResourceValidator: Pick<
      DirectResourceValidatorService,
      'verify'
    > = new DirectResourceValidatorService(),
    private getDirectResourceProxyOptions: DirectResourceProxyOptionsProvider = () =>
      null
  ) {}

  runExclusivePersistence<T>(operation: () => T | Promise<T>): Promise<T> {
    if (this.stopping) {
      return Promise.reject(new Error('SessionManager is stopping'))
    }
    return this.enqueuePersistence(operation)
  }

  private enqueuePersistence<T>(operation: () => T | Promise<T>): Promise<T> {
    const result = this.persistenceTail.then(operation)
    this.persistenceTail = result.then(
      () => undefined,
      () => undefined
    )
    return result
  }

  save(): Promise<void> {
    if (this.stopping) return this.stopPromise ?? Promise.resolve()
    return this.runExclusivePersistence(() => this.saveNow())
  }

  /**
   * Persist a single task through the same serialized, rejecting barrier as
   * save(), without rebuilding the payload for every task in memory. Discrete
   * lifecycle transitions (completion, reseed, error, adopt) use this path.
   */
  saveTask(taskId: string): Promise<void> {
    if (this.stopping) {
      return Promise.reject(new Error('SessionManager is stopping'))
    }
    return this.runExclusivePersistence(async () => {
      // Re-read at the front of the persistence queue for the same reason
      // saveNow() does: a task deleted while this operation was queued must
      // not be resurrected from a stale snapshot.
      const task = this.taskManager.getById(taskId)
      if (!task || task.status === TaskStatus.Removed) return
      this.db.saveTaskWithInstances(
        await this.buildTaskPayload(task, Date.now())
      )
    })
  }

  /**
   * Durable barrier for a candidate that has not been published to
   * TaskManager yet. Core actions use this to make the order
   * engine mutation -> persistence -> publication observable and testable.
   */
  persistTask(task: DownloadTask): Promise<void> {
    if (this.stopping) {
      return Promise.reject(new Error('SessionManager is stopping'))
    }
    return this.runExclusivePersistence(async () => {
      if (task.status === TaskStatus.Removed) return
      this.db.saveTaskWithInstances(
        await this.buildTaskPayload(task, Date.now())
      )
    })
  }

  /**
   * Same durable barrier as `persistTask`, but additionally appends the
   * task's terminal occurrence (when non-null) to the outbox in the SAME
   * SQLite transaction — `MotrixDatabase.persistTaskWithOccurrence` is
   * synchronous, so the async `DownloadTask -> TaskWithInstances` conversion
   * (`buildTaskPayload`, which touches the filesystem for the info hash)
   * must happen here, one layer above the synchronous DB primitive.
   */
  persistTaskWithOccurrence(
    task: DownloadTask,
    occurrence: TaskOccurrence | null
  ): Promise<void> {
    if (this.stopping) {
      return Promise.reject(new Error('SessionManager is stopping'))
    }
    return this.runExclusivePersistence(async () => {
      if (task.status === TaskStatus.Removed) return
      this.db.persistTaskWithOccurrence(
        await this.buildTaskPayload(task, Date.now()),
        occurrence
      )
    })
  }

  private async saveNow(): Promise<void> {
    // Capture the task snapshot only after this operation reaches the front of
    // the persistence queue. Clear Stopped can therefore delete memory + DB
    // atomically without an older queued snapshot resurrecting the rows.
    const tasks = this.taskManager.getAll()
    const now = Date.now()

    const payloads: TaskWithInstances[] = await Promise.all(
      tasks
        .filter((task) => task.status !== TaskStatus.Removed)
        .map((task) => this.buildTaskPayload(task, now))
    )

    this.db.saveTasksBatch(payloads)
  }

  private async buildTaskPayload(
    task: DownloadTask,
    now: number
  ): Promise<TaskWithInstances> {
    const taskRow: TaskRow = {
      motrixId: task.id,
      name: task.name,
      kind: task.kind,
      taskType: task.type,
      category: task.category,
      priority: task.priority,
      tags: null,
      createdAt: task.createdAt,
      updatedAt: task.updatedAt,
      finalPath: task.finalPath,
      finalName: task.finalName,
      torrentMetaPath: task.torrentMetaPath,
      infoHash: await deriveInfoHash(task),
      totalBytes: task.totalBytes,
      downloadedBytes: task.downloadedBytes,
      sizeWhenDone: task.sizeWhenDone,
      fileCount: task.fileCount,
      isPrivate: task.bt?.isPrivate ?? false,
      // .torrent-native announceList from polling
      // (translateBtExtension reads tellStatus.bittorrent.announceList).
      // We deliberately do NOT persist `bt-tracker` option content
      // (effective trackers, ~200 rows of global trackers) — that's
      // runtime state, reconstructible from settings.
      trackers: task.bt?.announceList ?? [],
      pieceLength: task.pieceLength,
      aggStatus: task.status,
      finishedAt: task.finishedAt,
      errorMessage: task.errorMessage,
      errorCode: task.errorCode,
      errorDetailKey: task.errorDetailKey,
      errorDetailParams: task.errorDetailParams,
      diagnosisRevision: task.diagnosisRevision,
      uploadedBytesBaseline: task.uploadedBytesBaseline,
      source: task.source,
      sourceMeta: task.sourceMeta,
    }

    const instances: TaskInstanceRow[] =
      task.instances.length > 0
        ? // Keep the instance's own updatedAt; do NOT re-stamp it to the
          // save time. The field has no consumer (write-only) and the
          // gratuitous per-save now-stamp made every persisted instance
          // look changed, defeating the unchanged-row skip in
          // saveTasksBatch.
          task.instances.map((inst) => ({ ...inst, motrixId: task.id }))
        : [synthesizePrimaryInstance(task, now)]

    return { task: taskRow, instances }
  }

  async restore(assertProxyCurrent?: () => void): Promise<void> {
    // aria2 is the source of truth for engine lifecycle. motrix.db is a
    // metadata sidecar tracking task identity and the relationship between
    // a task and its instances. The loop is driven by aria2: every live
    // GID is looked up against task_instances.gid; if found, we
    // reconstruct the parent task by reading all its sibling instances.
    // Anything left over in motrix.db after Pass 1 is an orphan.

    const persisted = this.db.getAllTasks()
    const byMotrixId = new Map<string, TaskWithInstances>()
    const instanceByGid = new Map<
      string,
      { motrixId: string; instance: TaskInstanceRow }
    >()
    const instancesByUriHash = new Map<
      string,
      Array<{ motrixId: string; instance: TaskInstanceRow }>
    >()
    const tasksByInfoHash = new Map<string, TaskWithInstances[]>()

    for (const pair of persisted) {
      byMotrixId.set(pair.task.motrixId, pair)
      if (pair.task.infoHash) {
        const infoHash = pair.task.infoHash.toLowerCase()
        const candidates = tasksByInfoHash.get(infoHash) ?? []
        candidates.push(pair)
        tasksByInfoHash.set(infoHash, candidates)
      }
      for (const inst of pair.instances) {
        if (inst.gid) {
          instanceByGid.set(inst.gid, {
            motrixId: pair.task.motrixId,
            instance: inst,
          })
        }
        if (inst.uriHash) {
          const candidates = instancesByUriHash.get(inst.uriHash) ?? []
          candidates.push({
            motrixId: pair.task.motrixId,
            instance: inst,
          })
          instancesByUriHash.set(inst.uriHash, candidates)
        }
      }
    }

    const [activeTasks, waitingTasks, stoppedTasks] = await Promise.all([
      this.rpc.tellActive(),
      fetchAll((offset, num) => this.rpc.tellWaiting(offset, num)),
      fetchAll((offset, num) => this.rpc.tellStopped(offset, num)),
    ])
    const {
      tasks: aria2Tasks,
      ignoredDuplicateCount,
      duplicateGidCount,
      arbitrationFailureCount,
      ignoredDuplicateSample,
    } = await resolveCurrentAria2Rows(
      this.rpc,
      activeTasks,
      waitingTasks,
      stoppedTasks
    )
    if (ignoredDuplicateCount > 0) {
      log.warn(
        {
          duplicateCount: ignoredDuplicateCount,
          duplicateGidCount,
          arbitrationFailureCount,
          duplicates: ignoredDuplicateSample,
        },
        'restore: reconciled duplicate aria2 rows'
      )
    }
    const aria2GidSet = new Set(aria2Tasks.map((t) => t.gid))

    this.taskManager.clear()
    const consumedMotrixIds = new Set<string>()

    // Engine-row evictions collected during Pass 1. Each chain preserves
    // its own force-remove → purge order and never rejects; batching them
    // lets N evictions overlap each other and the later passes instead of
    // serializing 2×N RPC round-trips inline.
    const evictions: Promise<void>[] = []

    // Pass 1 — drive from aria2 rows.
    for (const aria2 of aria2Tasks) {
      // Skip media segment downloads. They run on the shared aria2 daemon for
      // an hls/dash/mux task and get persisted in aria2's session; on restart
      // aria2 restores them, and adopting them here surfaces phantom
      // "000000.seg" tasks. They always write under mediaTmpRoot. The owning
      // MediaTaskCoordinator task is restored from motrix.db separately.
      if (this.mediaTmpRoot && aria2.dir.startsWith(this.mediaTmpRoot)) {
        continue
      }

      let parent: TaskWithInstances | undefined
      let matchedInstance: TaskInstanceRow | null = null

      const direct = instanceByGid.get(aria2.gid)
      if (direct) {
        parent = byMotrixId.get(direct.motrixId)
        matchedInstance = direct.instance
      }
      if (!parent && aria2.infoHash) {
        const candidates =
          tasksByInfoHash.get(aria2.infoHash.toLowerCase()) ?? []
        // infoHash identifies torrent content, not a user's independent task.
        // Only use it as a fallback when it is globally unambiguous and the
        // candidate is not already represented by another live GID. Duplicate
        // downloads of the same torrent must retain separate ownership.
        if (candidates.length === 1) {
          const candidate = candidates[0]
          const hasDifferentLiveGid = candidate.instances.some(
            (instance) =>
              instance.gid !== null &&
              instance.gid !== aria2.gid &&
              aria2GidSet.has(instance.gid)
          )
          if (
            !consumedMotrixIds.has(candidate.task.motrixId) &&
            !hasDifferentLiveGid
          ) {
            parent = candidate
          }
        }
      }
      if (!parent) {
        const ariaUris = extractUris(aria2)
        const uh = computeUriHash(ariaUris)
        if (uh) {
          const candidates = instancesByUriHash.get(uh) ?? []
          // URI hashes have the same identity limitation as torrent hashes:
          // repeated downloads are valid, so ambiguous content matches must
          // never steal another task's GID.
          if (candidates.length === 1) {
            const hit = candidates[0]
            const hasDifferentLiveGid =
              hit.instance.gid !== null &&
              hit.instance.gid !== aria2.gid &&
              aria2GidSet.has(hit.instance.gid)
            if (!consumedMotrixIds.has(hit.motrixId) && !hasDifferentLiveGid) {
              parent = byMotrixId.get(hit.motrixId)
              matchedInstance = hit.instance
            }
          }
        }
      }

      if (parent) {
        if (parent.instances.some(isMagnetCleanupTombstoneHidden)) {
          // A quarantined metadata GID may still be live in aria2. It is a
          // hidden cleanup tombstone, not a download to merge or adopt.
          consumedMotrixIds.add(parent.task.motrixId)
          continue
        }
        if (parent.task.aggStatus === TaskStatus.Error) {
          // Error is durable history and motrix.db owns it. An engine row
          // still carrying this GID is the engine's session store
          // resurrecting the failed download — merging would flip the task
          // back to an active status and re-mint the Error notification on
          // the next failure. Keep the persisted row (see
          // shouldEvictFromEngine for the --force-save invariant behind
          // this).
          const task = taskRowToDownloadTask(parent.task, parent.instances)
          this.taskManager.set(task.id, task)
          consumedMotrixIds.add(parent.task.motrixId)
          // Metadata Errors keep their GID: MagnetTracker primes a cache
          // shield for it after restore. Every other Error evicts the
          // engine's copy so the next launch stays clean.
          const isMetadataError = parent.instances.some(
            (instance) =>
              instance.phase === TaskInstancePhase.MagnetMetadataResolution
          )
          if (!isMetadataError) {
            evictions.push(this.evictResurrectedErrorRow(aria2))
          }
          continue
        }
        const task = this.mergeTaskFromPair(parent, matchedInstance, aria2)
        // Merging a persisted non-terminal task with aria2's stopped row can
        // settle it into Completed/Error. That is a real terminal transition
        // and owes an occurrence, not just an in-memory status flip that the
        // end-of-restore batch save happens to flush. cause 'engine' — the
        // engine's own stopped row is what settled it. Persisted
        // undispatched for the same reason markRecoverErrorFromPair does:
        // restore always precedes drainAtStartup() in both shells.
        const occurrence = buildTerminalOccurrence(
          terminalSnapshotFromTask(task),
          parent.task.aggStatus,
          'engine'
        )
        if (occurrence) {
          await this.persistTaskWithOccurrence(task, occurrence)
        }
        this.taskManager.set(task.id, task)
        consumedMotrixIds.add(parent.task.motrixId)
      } else {
        const task = this.adoptTask(aria2)
        this.taskManager.set(task.id, task)
      }
    }

    // Pass 2 — motrix.db tasks that have no live aria2 GID anywhere.
    //   • Completed and user-visible Error: retain durable history.
    //   • Magnet cleanup quarantine: keep hidden as a persistence tombstone.
    //   • Anything else: aria2 truly lost the task; re-add (BT via
    //     adapter.addTorrent with checkIntegrity, HTTP via createDownload).
    for (const pair of persisted) {
      if (consumedMotrixIds.has(pair.task.motrixId)) continue
      if (pair.instances.some((i) => i.gid && aria2GidSet.has(i.gid))) continue

      const primary = pair.instances[0]
      const isHiddenMagnetTombstone = pair.instances.some(
        isMagnetCleanupTombstoneHidden
      )
      if (isHiddenMagnetTombstone) {
        continue
      }

      const hasDurableTransitionIntent =
        pair.task.aggStatus === TaskStatus.Finalizing ||
        pair.instances.some(
          (instance) => instance.transitionPhase !== TransitionPhase.Idle
        )
      if (hasDurableTransitionIntent) {
        // Startup recovery runs immediately after restore(). Preserve the
        // exact persisted state here so its filesystem intent remains visible
        // to TaskRecoveryService. Re-adding a no-longer-live HTTP/BT GID, or
        // converting a media task to Error first, would destroy the marker
        // before recovery could replay the rename/reseed operation.
        const task = taskRowToDownloadTask(pair.task, pair.instances)
        if (
          task.status === TaskStatus.Finalizing &&
          task.transitionPhase === TransitionPhase.Idle
        ) {
          // Defensive repair for an inconsistent snapshot: Finalizing is
          // itself durable evidence that output finalization began. Treat the
          // missing phase as Renaming so recovery cannot strand the task in a
          // permanent Finalizing + Idle no-op state.
          setTaskTransitionPhase(task, TransitionPhase.Renaming)
        }
        this.taskManager.set(task.id, task)
        continue
      }

      if (
        pair.task.aggStatus === TaskStatus.Completed ||
        pair.task.aggStatus === TaskStatus.Error
      ) {
        const task = this.adoptByPair(pair, primary?.gid ?? '')
        // A Completed task is 100% by definition. adoptByPair now derives this
        // (Edit 3), but pin it here too so the Pass-2 completion path is correct
        // independently — a media task persists totalBytes:0, which would
        // otherwise make a finished bilibili mux restore at 0%.
        if (task.status === TaskStatus.Completed) {
          task.progress = 1
        }
        // Heal rows persisted before finalizeTask synced instance
        // diskPath: their task_instances row still holds the in-flight
        // `.motrix` placeholder while the tasks row carries the correct
        // finalPath (finalize's rename target, including plugin renames).
        // Restoring the placeholder verbatim breaks reveal-in-folder and
        // delete-with-files. Instances heal too, so the next save()
        // rewrites the DB row and the stale path is gone for good.
        if (
          task.status === TaskStatus.Completed &&
          isTempPath(task.diskPath) &&
          task.finalPath
        ) {
          task.diskPath = task.finalPath
          task.saveDir = task.finalPath
          for (const inst of task.instances) {
            inst.diskPath = task.finalPath
          }
        }
        this.taskManager.set(task.id, task)
        continue
      }

      // In-progress media task (mux/hls/dash). Its coordinator segment
      // downloads + ffmpeg pipeline did not survive the restart, and its
      // instances carry no resumable aria2 uris (mux instance uris:[], gid:null),
      // so it cannot be re-added. Intercept BEFORE the magnet/reAdd paths (an
      // hls seg instance could hold a lone segment uri that reAdd would bogusly
      // createDownload). Keep a pre-existing coordinator Error message; otherwise
      // mark a clear "interrupted by restart, re-add to retry" error.
      if (isMediaKind(pair.task.kind)) {
        const task = await this.markRecoverErrorFromPair(
          pair,
          'task.recovery.startup.mediaInterrupted'
        )
        this.taskManager.set(task.id, task)
        continue
      }

      // Magnet metadata pending — re-issue the metadata-only fetch
      // instead of reAdd. The metadata directory survives across
      // restart because it lives under the OS tmpdir but is recorded
      // in the instance payload.
      if (
        primary &&
        primary.phase === TaskInstancePhase.MagnetMetadataResolution
      ) {
        // MetadataReady: aria2 already finished the metadata fetch
        // (removeMetadataResult ran in MagnetTracker.onComplete before
        // the user closed the app). Don't re-issue — just register
        // the row in TaskManager so the Downloads list still shows
        // it as "Ready" + lets the user retrigger the dialog or
        // remove the task.
        if (pair.task.aggStatus === TaskStatus.MetadataReady) {
          const task = taskRowToDownloadTask(pair.task, pair.instances)
          this.taskManager.set(task.id, task)
          continue
        }
        const task = await this.recoverMagnetMetadata(pair)
        this.taskManager.set(task.id, task)
        continue
      }

      const task = await this.reAddOrMarkErrorFromPair(pair, assertProxyCurrent)
      this.taskManager.set(task.id, task)
    }

    // Pass 3 — reseed bt.selectedFiles from persisted task_files. aria2
    // only reports selected[] when files metadata has been fetched; this
    // preserves user edits made in a prior session, including for tasks
    // that are paused or whose engine view hasn't fully recovered yet.
    for (const task of this.taskManager.getAll()) {
      const fileRows = this.db.getTaskFiles(task.id)
      if (fileRows.length > 0 && task.bt) {
        task.bt.selectedFiles = fileRows
          .filter((r) => r.selected)
          .map((r) => r.fileIndex)
      }
    }

    // Recovery-created terminal state is already durable at this point: every
    // path that lands a task in Error during this pass goes through
    // `markRecoverErrorFromPair`, which persists via the occurrence-aware
    // `persistTaskWithOccurrence` before returning (directly for the media
    // and Pass-2 default cases, or nested inside `recoverMagnetMetadata` /
    // `reAddOrMarkErrorFromPair` for their failure branches). No separate
    // end-of-restore batch save is needed to make that state crash-safe.

    // Nothing above depends on the evictions (aria2GidSet was snapshotted
    // before Pass 1); they only need to settle before restore() returns so
    // startup proceeds against a clean engine.
    await Promise.allSettled(evictions)
  }

  private static readonly LEGACY_LOST_MESSAGE =
    'Task lost: aria2 engine no longer has this download'

  async recoverLegacyTaskLost(assertProxyCurrent?: () => void): Promise<void> {
    const tasks = this.taskManager.getAll()
    for (const task of tasks) {
      if (
        task.status !== TaskStatus.Error ||
        task.errorMessage !== SessionManager.LEGACY_LOST_MESSAGE
      ) {
        continue
      }
      const pair = this.db.getTask(task.id)
      if (!pair) continue
      const fresh = await this.reAddOrMarkErrorFromPair(
        pair,
        assertProxyCurrent
      )
      // reAddOrMarkErrorFromPair's Error outcome already persisted itself via
      // markRecoverErrorFromPair's persistTaskWithOccurrence; only its
      // successful-re-add outcome (adoptByPair alone, which never returns
      // Error) still needs this write.
      if (fresh.status !== TaskStatus.Error) {
        await this.runExclusivePersistence(async () => {
          this.db.saveTaskWithInstances(
            await this.buildTaskPayload(fresh, Date.now())
          )
        })
      }
      this.taskManager.set(fresh.id, fresh)
    }
  }

  /**
   * Coalescing alternative to `save()`. Multiple calls within the
   * debounce window are folded into a single underlying save, and
   * all callers receive the same promise so they can `await`
   * durability without burning extra SQLite transactions.
   *
   * Safe to use anywhere `save()` was being invoked as
   * fire-and-forget — semantics improve, cost decreases.
   */
  requestSave(): Promise<void> {
    if (this.stopping) return this.stopPromise ?? Promise.resolve()
    if (this.requestedSave) return this.requestedSave
    this.requestedSave = new Promise<void>((resolve) => {
      this.resolveRequestedSave = resolve
      this.requestedSaveTimer = setTimeout(() => {
        this.requestedSaveTimer = null
        const inFlight = this.save().catch((err) => {
          log.error({ err }, 'requestSave failed')
        })
        // Clear the slot as soon as the save settles so the next
        // burst opens a fresh window. Using `finally`-style chaining
        // on the inFlight promise (.then with both branches) keeps
        // the resolve symmetric across success and failure.
        inFlight.then(
          () => {
            this.requestedSave = null
            this.resolveRequestedSave = null
            resolve()
          },
          () => {
            this.requestedSave = null
            this.resolveRequestedSave = null
            resolve()
          }
        )
      }, REQUEST_SAVE_DEBOUNCE_MS)
    })
    return this.requestedSave
  }

  startAutoSave(intervalMs: number): void {
    if (this.stopping) return
    this.autoSaveIntervalMs = intervalMs
    this.armAutoSaveTimer()
  }

  /**
   * Engine active/idle signal — the polling scheduler derives it from aria2
   * getGlobalStat.numActive and broadcasts Events.EngineActiveChanged. The
   * periodic auto-save only runs while the engine is active; on the
   * active→idle edge it flushes once (so the last byte-count mirror, and any
   * terminal state that falls back to the periodic save, is durable) then
   * stops the timer to avoid rewriting the whole history while idle.
   */
  setEngineActive(active: boolean): void {
    if (this.stopping) return
    if (active === this.engineActive) return
    this.engineActive = active
    if (active) {
      this.armAutoSaveTimer()
    } else {
      void this.save().catch((err) => {
        log.error({ err }, 'idle-flush save failed')
      })
      this.stopAutoSave()
    }
  }

  private armAutoSaveTimer(): void {
    this.stopAutoSave()
    if (!this.engineActive || this.autoSaveIntervalMs === null) return
    this.autoSaveTimer = setInterval(() => {
      void this.save().catch((err) => {
        log.error({ err }, 'auto-save failed')
      })
    }, this.autoSaveIntervalMs)
  }

  stopAutoSave(): void {
    if (this.autoSaveTimer !== null) {
      clearInterval(this.autoSaveTimer)
      this.autoSaveTimer = null
    }
  }

  stopAndDrain(): Promise<void> {
    if (this.stopPromise) return this.stopPromise
    this.stopping = true
    this.stopAutoSave()
    if (this.requestedSaveTimer !== null) {
      clearTimeout(this.requestedSaveTimer)
      this.requestedSaveTimer = null
    }
    const resolvePending = this.resolveRequestedSave
    this.stopPromise = this.enqueuePersistence(() => this.saveNow()).finally(
      () => {
        this.requestedSave = null
        this.resolveRequestedSave = null
        resolvePending?.()
      }
    )
    return this.stopPromise
  }

  // ─── Private: pair-based restore helpers (Plan A Task 7) ────

  /**
   * Best-effort removal of an engine row whose task is already durably
   * Error in motrix.db. A live row (the session store re-queued the failed
   * download) must leave the active/waiting sets before its stopped result
   * can be purged; a row that already re-failed only needs the purge.
   * Failures are logged and swallowed — restore must finish, and a row
   * that survives here is retried by the same shield on the next launch.
   */
  private async evictResurrectedErrorRow(aria2: Aria2RawStatus): Promise<void> {
    const stopped =
      aria2.status === 'error' ||
      aria2.status === 'complete' ||
      aria2.status === 'removed'
    try {
      if (!stopped) {
        await this.adapter.forceRemoveTask(aria2.gid)
      }
      await this.adapter.removeDownloadResult(aria2.gid)
    } catch (err) {
      log.warn(
        { err, gid: aria2.gid, engineStatus: aria2.status },
        'restore: failed to evict resurrected errored engine row'
      )
    }
  }

  private mergeTaskFromPair(
    pair: TaskWithInstances,
    matchedInstance: TaskInstanceRow | null,
    aria2: Aria2RawStatus
  ): DownloadTask {
    const now = Date.now()
    const taskPart = pair.task
    const primary = matchedInstance ?? pair.instances[0]
    const derived = derivePathsFromRaw(aria2)
    const diskPath = primary?.diskPath || derived.diskPath
    const finalPath = taskPart.finalPath || derived.finalPath
    const finalName = taskPart.finalName || derived.finalName

    const totalBytes = Number(aria2.totalLength) || taskPart.totalBytes
    const downloadedBytes =
      Number(aria2.completedLength) || taskPart.downloadedBytes
    const sizeWhenDone = Number(aria2.totalLength) || taskPart.sizeWhenDone
    const uploadedBytesBaseline = taskPart.uploadedBytesBaseline
    const uploadedBytes =
      uploadedBytesBaseline + Number(aria2.uploadLength || 0)
    const fileCount = aria2.files?.length || taskPart.fileCount

    let bt = translateBtExtension(aria2)
    if (bt) {
      bt.isPrivate = taskPart.isPrivate
      if (bt.announceList.length === 0 && taskPart.trackers.length > 0) {
        bt.announceList = taskPart.trackers
        bt.trackers = taskPart.trackers.flat()
      }
    } else if (taskPart.infoHash || taskPart.torrentMetaPath) {
      bt = makeDefaultBtExtension({
        trackers: taskPart.trackers.flat(),
        announceList: taskPart.trackers,
        isPrivate: taskPart.isPrivate,
      })
    }

    const status = translateStatus(aria2)
    const terminalFields = applyTerminalTransition(
      terminalFieldsFromRow(taskPart),
      status,
      {
        finishedAt: aria2.status === 'complete' ? now : null,
        errorMessage: aria2.errorMessage ?? null,
        errorCode: translateErrorCode(aria2.errorCode),
      },
      now
    )

    const updatedInstances = pair.instances.map((inst) => {
      if (matchedInstance && inst.instanceId === matchedInstance.instanceId) {
        return {
          ...inst,
          gid: aria2.gid,
          status,
          progress:
            totalBytes > 0
              ? Math.min(100, Math.round((downloadedBytes * 100) / totalBytes))
              : 0,
          totalBytes,
          downloadedBytes,
          uploadedBytes: Number(aria2.uploadLength || 0),
          updatedAt: now,
        }
      }
      return inst
    })

    return {
      id: taskPart.motrixId,
      engineTaskId: aria2.gid,
      name: taskPart.name,
      kind: taskPart.kind,
      type: taskPart.taskType,
      ...terminalFields,
      progress:
        status === TaskStatus.Completed
          ? 1
          : totalBytes > 0
            ? Math.min(1, downloadedBytes / totalBytes)
            : 0,
      totalBytes,
      downloadedBytes,
      downloadSpeed: Number(aria2.downloadSpeed),
      uploadSpeed: Number(aria2.uploadSpeed),
      etaSeconds: computeEta(
        String(totalBytes),
        String(downloadedBytes),
        aria2.downloadSpeed
      ),
      saveDir: aria2.dir,
      createdAt: taskPart.createdAt,
      updatedAt: now,
      uris: extractUris(aria2),
      uploadedBytes,
      uploadedBytesBaseline,
      fileCount,
      connections: Number(aria2.connections),
      pieceLength: Number(aria2.pieceLength) || taskPart.pieceLength,
      infoHash: aria2.infoHash ?? taskPart.infoHash,
      metadataProgress: 0,
      priority: taskPart.priority,
      category: taskPart.category,
      dlLimit: 0,
      ulLimit: 0,
      filename: taskPart.name,
      sizeWhenDone,
      bt,
      diskPath,
      finalPath,
      finalName,
      transitionPhase: primary?.transitionPhase ?? TransitionPhase.Idle,
      torrentMetaPath: taskPart.torrentMetaPath,
      source: taskPart.source,
      sourceMeta: taskPart.sourceMeta,
      instances: updatedInstances,
    }
  }

  private adoptByPair(
    pair: TaskWithInstances,
    newGid: string,
    nextStatus = pair.task.aggStatus
  ): DownloadTask {
    const now = Date.now()
    const taskPart = pair.task
    const primary = pair.instances[0]
    const taskType = taskPart.taskType
    const isBtLike = isTorrentLikeType(taskType)
    // gid swap: lift baseline so cumulative upload survives across reAdd
    // (the new aria2 row starts uploadLength at 0). When newGid === primary
    // gid (Pass-2 Completed retention) keep baseline as is.
    const uploadedBytesBaseline =
      newGid !== primary?.gid
        ? Math.max(taskPart.uploadedBytesBaseline, primary?.uploadedBytes ?? 0)
        : taskPart.uploadedBytesBaseline
    const bt = isBtLike
      ? makeDefaultBtExtension({
          ratio:
            taskPart.totalBytes > 0
              ? (primary?.uploadedBytes ?? 0) / taskPart.totalBytes
              : 0,
          trackers: taskPart.trackers.flat(),
          announceList: taskPart.trackers,
          isPrivate: taskPart.isPrivate,
        })
      : undefined
    const terminalFields = applyTerminalTransition(
      terminalFieldsFromRow(taskPart),
      nextStatus,
      {},
      now
    )
    const retainedIdentity = newGid === primary?.gid

    return {
      id: taskPart.motrixId,
      engineTaskId: newGid,
      name: taskPart.name,
      kind: taskPart.kind,
      type: taskType,
      ...terminalFields,
      // Completed ⇒ 100% even with no byte counts (media tasks persist
      // totalBytes:0; a 0-byte file is also legitimately complete). For a
      // normal completed task downloaded/total already equals 1, so this only
      // changes the totalBytes===0 completed case. Non-completed: byte-derived.
      progress:
        nextStatus === TaskStatus.Completed
          ? 1
          : taskPart.totalBytes > 0
            ? taskPart.downloadedBytes / taskPart.totalBytes
            : 0,
      totalBytes: taskPart.totalBytes,
      downloadedBytes: taskPart.downloadedBytes,
      downloadSpeed: 0,
      uploadSpeed: 0,
      etaSeconds: 0,
      saveDir: primary?.diskPath || taskPart.finalPath || '',
      createdAt: taskPart.createdAt,
      updatedAt: retainedIdentity ? taskPart.updatedAt : now,
      uris: primary?.uris ?? [],
      uploadedBytes:
        newGid !== primary?.gid
          ? uploadedBytesBaseline
          : (primary?.uploadedBytes ?? 0),
      uploadedBytesBaseline,
      fileCount: taskPart.fileCount,
      connections: 0,
      pieceLength: taskPart.pieceLength,
      infoHash: taskPart.infoHash,
      metadataProgress: 0,
      priority: taskPart.priority,
      category: taskPart.category,
      dlLimit: 0,
      ulLimit: 0,
      filename: taskPart.name,
      sizeWhenDone: taskPart.sizeWhenDone,
      diskPath: primary?.diskPath ?? '',
      finalPath: taskPart.finalPath,
      finalName: taskPart.finalName,
      transitionPhase: primary?.transitionPhase ?? TransitionPhase.Idle,
      torrentMetaPath: taskPart.torrentMetaPath,
      bt,
      source: taskPart.source,
      sourceMeta: taskPart.sourceMeta,
      instances: pair.instances.map((inst) =>
        inst.instanceId === primary?.instanceId
          ? {
              ...inst,
              gid: newGid,
              status: nextStatus,
              updatedAt: retainedIdentity ? inst.updatedAt : now,
            }
          : inst
      ),
    }
  }

  private async reAddOrMarkErrorFromPair(
    pair: TaskWithInstances,
    assertProxyCurrent?: () => void
  ): Promise<DownloadTask> {
    const taskPart = pair.task
    const primary = pair.instances[0]

    if (taskPart.infoHash || taskPart.torrentMetaPath) {
      if (
        !taskPart.torrentMetaPath ||
        !fs.existsSync(taskPart.torrentMetaPath)
      ) {
        return this.markRecoverErrorFromPair(
          pair,
          'task.recovery.startup.torrentMetaMissing'
        )
      }
      try {
        const bytes = fs.readFileSync(taskPart.torrentMetaPath)
        const prioritizePreviewPieces =
          await shouldPrioritizeBtPreviewPiecesFromMetadata(bytes)
        return this.dispatchRecoveryCandidate(pair, (gid) =>
          this.adapter.addTorrent({
            metadata: bytes,
            gid,
            saveDir: primary?.diskPath || taskPart.finalPath || '/',
            pause: taskPart.aggStatus === TaskStatus.Paused,
            checkIntegrity: true,
            ...(prioritizePreviewPieces
              ? { prioritizePreviewPieces: true }
              : {}),
          })
        )
      } catch (err) {
        log.warn(
          { err, motrixId: taskPart.motrixId },
          'BT re-add failed during restore'
        )
        return this.markRecoverErrorFromPair(
          pair,
          'task.recovery.startup.reAddFailed'
        )
      }
    }

    if (primary && primary.uris.length > 0) {
      const recipe = parseDirectReplayRecipe(primary.payload)
      if (recipe?.replayability === 'requires-credentials') {
        return this.markRecoverErrorFromPair(
          pair,
          'task.recovery.startup.resumeCredentialsRequired'
        )
      }
      const requestOptions = this.getDirectResourceProxyOptions()

      const plan = await this.directRecoveryPlanner.plan({
        primary,
        finalPath: taskPart.finalPath,
      })
      if (plan.kind === 'finalization-candidate') {
        return this.promoteDirectFinalizationCandidate(pair)
      }
      if (plan.kind === 'blocked') {
        return this.markRecoverErrorFromPair(
          pair,
          plan.reason === 'checkpoint-missing'
            ? 'task.recovery.startup.resumeCheckpointMissing'
            : 'task.recovery.startup.resumePathInvalid'
        )
      }
      if (
        plan.kind === 'invalid' ||
        !plan.diskPath ||
        !plan.saveDir ||
        !plan.filename
      ) {
        return this.markRecoverErrorFromPair(
          pair,
          'task.recovery.startup.resumePathInvalid'
        )
      }

      const resumePolicy =
        plan.kind === 'checkpoint'
          ? 'checkpoint'
          : plan.reason === 'temp-file-empty'
            ? 'sequential-prefix'
            : 'none'
      let ifRange: string | null = null
      const metadataProfile = canMirrorAria2MetadataHeaders(
        this.adapter.getFeatureReport?.()
      )
        ? resolveDirectResourceMetadataProfile(this.adapter)
        : null
      if (plan.kind === 'checkpoint' && metadataProfile === null) {
        return this.markRecoverErrorFromPair(
          pair,
          'task.recovery.startup.resumeValidationFailed'
        )
      }
      if (plan.kind === 'checkpoint' && !recipe?.resourceValidator) {
        return this.markRecoverErrorFromPair(
          pair,
          'task.recovery.startup.resumeValidationFailed'
        )
      }
      if (plan.kind === 'checkpoint' && recipe?.resourceValidator) {
        if (primary.uris.length !== 1) {
          return this.markRecoverErrorFromPair(
            pair,
            'task.recovery.startup.resumeValidationFailed'
          )
        }
        const validation =
          requestOptions &&
          canMirrorAria2MetadataHeaders(this.adapter.getFeatureReport?.())
            ? await this.directResourceValidator.verify(
                primary.uris[0] as string,
                recipe.resourceValidator,
                requestOptions
              )
            : { outcome: 'unverifiable' as const, ifRange: null }
        assertProxyCurrent?.()
        if (validation.outcome !== 'unchanged') {
          const errorDetailKey =
            validation.outcome === 'source-changed'
              ? 'task.recovery.startup.resumeSourceChanged'
              : validation.outcome === 'range-unsupported'
                ? 'task.recovery.startup.resumeRangeUnsupported'
                : 'task.recovery.startup.resumeValidationFailed'
          return this.markRecoverErrorFromPair(pair, errorDetailKey)
        }
        ifRange = validation.ifRange
      }
      return this.dispatchRecoveryCandidate(pair, (gid) => {
        assertProxyCurrent?.()
        return this.adapter.createDownload({
          uris: primary.uris,
          gid,
          saveDir: plan.saveDir as string,
          filename: plan.filename as string,
          connections: recipe?.connections,
          ...(plan.kind !== 'checkpoint' || metadataProfile === null
            ? {}
            : { directResourceMetadataProfile: metadataProfile }),
          ...(requestOptions?.userAgent === undefined
            ? {}
            : { userAgent: requestOptions.userAgent }),
          ...(ifRange ? { headers: { 'If-Range': ifRange } } : {}),
          pause: taskPart.aggStatus === TaskStatus.Paused,
          resumePolicy,
        })
      })
    }

    return this.markRecoverErrorFromPair(
      pair,
      'task.recovery.startup.dirtyMetadata'
    )
  }

  /**
   * A final output with no remaining temporary file means the prior process
   * crossed the filesystem boundary but crashed before persisting completion.
   * Recreate the durable rename intent so TaskRecoveryService can reconcile
   * it instead of dispatching a second download.
   */
  private async promoteDirectFinalizationCandidate(
    pair: TaskWithInstances
  ): Promise<DownloadTask> {
    const now = Date.now()
    const task = taskRowToDownloadTask(pair.task, pair.instances)
    task.status = TaskStatus.Finalizing
    task.updatedAt = now
    for (const instance of task.instances) {
      instance.status = TaskStatus.Finalizing
      instance.updatedAt = now
    }
    setTaskTransitionPhase(task, TransitionPhase.Renaming)
    await this.persistTask(task)
    return task
  }

  /**
   * Persist the replacement GID before dispatching it. If the app crashes
   * after aria2 accepts the task (or the RPC response is lost), the next
   * restore pass owns that exact GID and cannot mint a duplicate public task.
   */
  private async dispatchRecoveryCandidate(
    pair: TaskWithInstances,
    dispatch: (gid: string) => Promise<string>
  ): Promise<DownloadTask> {
    const gid = newEngineTaskId(undefined, 'SessionManager recovery')
    const nextStatus = this.statusAfterSuccessfulReAdd(pair)
    const candidate = this.adoptByPair(pair, gid, nextStatus)
    await this.persistTask(candidate)

    try {
      const actualGid = await dispatch(gid)
      if (actualGid.toLowerCase() !== gid.toLowerCase()) {
        throw new Error(
          `Engine returned gid ${actualGid} instead of reserved gid ${gid}`
        )
      }
      return candidate
    } catch (err) {
      log.warn(
        { err, motrixId: pair.task.motrixId, gid },
        'engine re-add failed during restore'
      )

      let cleanupComplete = false
      try {
        await this.adapter.forceRemoveTask(gid)
      } catch (cleanupError) {
        log.debug(
          { err: cleanupError, motrixId: pair.task.motrixId, gid },
          'restore re-add force-remove did not settle'
        )
      }
      try {
        await this.adapter.removeDownloadResult(gid)
        cleanupComplete = true
      } catch (cleanupError) {
        log.warn(
          { err: cleanupError, motrixId: pair.task.motrixId, gid },
          'restore re-add result cleanup failed'
        )
      }

      return cleanupComplete
        ? this.markRecoverErrorFromPair(
            pair,
            'task.recovery.startup.reAddFailed'
          )
        : this.markRecoverErrorTask(
            candidate,
            pair.task.aggStatus,
            'task.recovery.startup.reAddFailed'
          )
    }
  }

  /**
   * Land a restored task in Error with a specific, localized detail key —
   * used by every startup-recovery site that gives up on resuming a task
   * (BT re-add failed, torrent metadata missing, dirty/unidentifiable
   * metadata, an interrupted media pipeline, magnet metadata re-issue
   * failed). Persists the transition through the occurrence path (cause
   * 'recovery') instead of relying solely on restore()'s end-of-pass batch
   * saveNow(). SessionManager holds no OccurrenceDispatcher reference —
   * restore() always completes before drainAtStartup() runs in both
   * shells' bootstrap (main/index.ts, server/index.ts), so persisting the
   * occurrence undispatched here is safe: drainAtStartup() delivers it once
   * the dispatcher drains the outbox.
   */
  private async markRecoverErrorFromPair(
    pair: TaskWithInstances,
    errorDetailKey: string
  ): Promise<DownloadTask> {
    const previousStatus = pair.task.aggStatus
    const primary = pair.instances[0]
    const task = this.adoptByPair(pair, primary?.gid ?? '')
    return this.markRecoverErrorTask(task, previousStatus, errorDetailKey)
  }

  private async markRecoverErrorTask(
    task: DownloadTask,
    previousStatus: TaskStatus,
    errorDetailKey: string
  ): Promise<DownloadTask> {
    const now = Date.now()
    const errored: DownloadTask = {
      ...task,
      ...applyTerminalTransition(
        task,
        TaskStatus.Error,
        { errorDetailKey, errorMessage: null, errorDetailParams: null },
        now
      ),
      updatedAt: now,
      transitionPhase: TransitionPhase.Idle,
      instances: task.instances.map((instance) => ({
        ...instance,
        status: TaskStatus.Error,
        transitionPhase: TransitionPhase.Idle,
        updatedAt: now,
      })),
    }

    const occurrence = buildTerminalOccurrence(
      terminalSnapshotFromTask(errored),
      previousStatus,
      'recovery'
    )
    await this.persistTaskWithOccurrence(errored, occurrence)

    return errored
  }

  private statusAfterSuccessfulReAdd(pair: TaskWithInstances): TaskStatus {
    if (pair.task.aggStatus === TaskStatus.Paused) return TaskStatus.Paused
    if (
      pair.task.aggStatus === TaskStatus.Completed ||
      pair.task.aggStatus === TaskStatus.Error
    ) {
      return isTorrentLikeType(pair.task.taskType)
        ? TaskStatus.Seeding
        : TaskStatus.Downloading
    }
    return pair.task.aggStatus
  }

  /** Re-issue the aria2 metadata-only fetch for a persisted
   *  magnet_metadata_resolution instance. The metadata directory
   *  (recorded in `instance.payload.metadataDir`) is re-used so the
   *  partial metadata aria2 may have saved last session is honoured.
   *  Updates the instance gid in db (the old gid is dead — aria2 does
   *  not preserve metadata-only gids across restart). Returns the
   *  DownloadTask to install in TaskManager so the Downloads list
   *  shows the task in fetching_metadata state immediately. */
  private async recoverMagnetMetadata(
    pair: TaskWithInstances
  ): Promise<DownloadTask> {
    const now = Date.now()
    const taskPart = pair.task
    const primary = pair.instances[0]
    const magnetUri = primary.uris[0]
    const metadataDir =
      typeof primary.payload.metadataDir === 'string'
        ? primary.payload.metadataDir
        : ''

    if (!magnetUri || !metadataDir) {
      return this.markRecoverErrorFromPair(
        pair,
        'task.recovery.startup.dirtyMetadata'
      )
    }

    try {
      const newGid = await this.rpc.addUri([magnetUri], {
        'bt-load-saved-metadata': 'false',
        'bt-metadata-only': 'true',
        dir: metadataDir,
        'follow-torrent': 'false',
      })

      const updatedInstance: TaskInstanceRow = {
        ...primary,
        gid: newGid,
        updatedAt: now,
      }
      this.db.replaceInstances(taskPart.motrixId, [updatedInstance])

      return {
        id: taskPart.motrixId,
        engineTaskId: newGid,
        name: taskPart.name,
        kind: taskPart.kind,
        type: taskPart.taskType,
        status: TaskStatus.FetchingMetadata,
        progress: 0,
        totalBytes: 0,
        downloadedBytes: 0,
        downloadSpeed: 0,
        uploadSpeed: 0,
        etaSeconds: 0,
        saveDir: taskPart.finalPath,
        createdAt: taskPart.createdAt,
        updatedAt: now,
        finishedAt: null,
        errorMessage: null,
        uris: primary.uris,
        uploadedBytes: 0,
        uploadedBytesBaseline: 0,
        fileCount: 0,
        connections: 0,
        pieceLength: taskPart.pieceLength,
        infoHash: taskPart.infoHash,
        errorCode: null,
        errorDetailKey: null,
        errorDetailParams: null,
        diagnosisRevision: 0,
        metadataProgress: 0,
        priority: taskPart.priority,
        category: taskPart.category,
        dlLimit: 0,
        ulLimit: 0,
        filename: taskPart.name,
        sizeWhenDone: 0,
        source: taskPart.source,
        sourceMeta: taskPart.sourceMeta,
        diskPath: primary.diskPath,
        finalPath: taskPart.finalPath,
        finalName: '',
        transitionPhase: TransitionPhase.Idle,
        torrentMetaPath: null,
        instances: [updatedInstance],
      }
    } catch (err) {
      log.warn(
        { err, motrixId: taskPart.motrixId },
        'magnet metadata re-issue failed during restore'
      )
      return this.markRecoverErrorFromPair(
        pair,
        'task.recovery.startup.reAddFailed'
      )
    }
  }

  private adoptTask(aria2: Aria2RawStatus): DownloadTask {
    const base = translateRawToTask(aria2)
    const now = Date.now()
    const id = newTaskId()
    return {
      ...base,
      id,
      createdAt: now,
      updatedAt: now,
      priority: 0,
      category: null,
      instances: base.instances.map((i) => ({ ...i, motrixId: id })),
    }
  }
}

function resolveDirectResourceMetadataProfile(
  adapter: EngineAdapter
): DirectResourceMetadataProfile | null {
  if (!adapter.getDirectResourceMetadataProfile) return null
  try {
    return adapter.getDirectResourceMetadataProfile()
  } catch {
    return null
  }
}

function synthesizePrimaryInstance(
  task: DownloadTask,
  now: number
): TaskInstanceRow {
  const isHttpLike =
    task.type === TaskType.Http ||
    task.type === TaskType.Ftp ||
    task.type === TaskType.Metalink
  const isBtLike = isTorrentLike(task)
  return {
    instanceId: `synth:${task.id}`,
    motrixId: task.id,
    gid: task.engineTaskId,
    phase: isBtLike
      ? TaskInstancePhase.BtDownload
      : TaskInstancePhase.HttpDownload,
    status: task.status,
    progress: Math.min(100, Math.round(task.progress * 100)),
    totalBytes: task.totalBytes,
    downloadedBytes: task.downloadedBytes,
    uploadedBytes: task.uploadedBytes,
    diskPath: task.diskPath,
    transitionPhase: task.transitionPhase,
    uris: task.uris,
    uriHash: isHttpLike ? computeUriHash(task.uris) : null,
    payload: {},
    createdAt: task.createdAt,
    updatedAt: now,
  }
}
