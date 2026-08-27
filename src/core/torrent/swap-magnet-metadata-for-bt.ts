import { randomBytes } from 'node:crypto'
import { mkdir, rm } from 'node:fs/promises'
import path from 'node:path'
import type { EngineAdapter } from '@core/engine/engine-adapter'
import { getLogger } from '@core/logger'
import type {
  MotrixDatabase,
  TaskInstanceRow,
  TaskRow,
  TaskWithInstancesAndFiles,
} from '@core/session/motrix-database'
import type { TaskTransitionRecordInput } from '@core/task/actions/shared'
import {
  existingFilesConflict,
  reservedBtFinalNames,
} from '@core/task/bt-duplicate-policy'
import {
  type BtStoragePlan,
  btStoragePayload,
  createBtStoragePlan,
  type ParsedBtFileLayout,
  parseBtFileLayout,
  shouldPrioritizeBtPreviewPieces,
  UnsafeTorrentPathError,
} from '@core/task/bt-storage-layout'
import type { FinalNamePicker } from '@core/task/final-name-picker'
import { toTempPath } from '@core/task/paths'
import type { TaskManager } from '@core/task/task-manager'
import { taskRowToDownloadTask } from '@core/task/task-row-to-download-task'
import type { TorrentMetaStore } from '@core/task/torrent-meta-store'
import { AppError, ErrorCode } from '@shared/errors'
import type { TaskCreateSuccessResult } from '@shared/schemas/add-task'
import type { DownloadTask } from '@shared/types/task'
import {
  TaskInstancePhase,
  TaskStatus,
  TaskType,
  TransitionPhase,
} from '@shared/types/task'
import {
  isMagnetCleanupTombstoneHidden,
  withMagnetCleanupArtifactPaths,
  withMagnetCleanupQuarantined,
  withMagnetCleanupRestoreGraph,
  withMagnetCleanupTombstoneHidden,
} from './magnet-cleanup-quarantine'
import type { MagnetTracker } from './magnet-tracker'

const log = getLogger('swap-magnet-metadata')

// MagnetTracker.submit names the pending row `[METADATA] <uri>`; strip the
// prefix before deriving the on-disk name in case onComplete hasn't already
// replaced it with the resolved torrent name.
const METADATA_NAME_PREFIX = /^\[METADATA\] /

export interface SwapMagnetMetadataInput {
  taskId: string
  base64: string
  selectedFiles: number[]
  saveDir: string
  /** Resolved torrent display name. When provided, replaces the
   *  `[METADATA] …` placeholder name on the task row. */
  name?: string
  duplicatePolicy?: 'reuse' | 'create-copy'
}

export interface SwapMagnetMetadataDeps {
  db: MotrixDatabase
  taskManager: TaskManager
  adapter: EngineAdapter
  magnetTracker: MagnetTracker
  /** Collision-safe final on-disk name picker shared with createTaskHandler. */
  finalNamePicker: FinalNamePicker
  /** Persists the resolved .torrent bytes so finalize's reseed and
   *  reAddTask can recover them (they read `torrentMetaPath`). */
  torrentMetaStore: TorrentMetaStore
  /**
   * Coalesced / immediate TaskUpdated publication (TaskUpdatePublisher).
   * The successful swap publishes through the trailing window; the
   * failed-swap quarantine (an Error the user must see) flushes now.
   */
  publishTaskUpdate: () => void
  publishTaskUpdateNow: () => void
  recordTransition?: (input: TaskTransitionRecordInput) => void | Promise<void>
  runTaskMutation: <T>(
    taskIds: readonly string[],
    operation: () => Promise<T>
  ) => Promise<T>
  runExclusivePersistence: <T>(operation: () => T | Promise<T>) => Promise<T>
  monotonicNow?: () => number
}

/** Swap a task's `magnet_metadata_resolution` instance for a fresh
 *  `bt_download` instance in place. Preserves the task's identity
 *  (motrixId, createdAt, Downloads list position) so the user sees
 *  the same row transition from "Fetching metadata" to "Downloading"
 *  instead of a duplicate appearing.
 *
 *  Aborts with `MagnetCleanupPending` (Codex finding #12) if
 *  MagnetTracker.cancel returned 'quarantined': the aria2 metadata
 *  GID may still be alive, so creating a new BT instance now would
 *  leave two GIDs in aria2 and overwrite the DB metadata tombstone.
 *  Callers (commands.ts) surface this as a retryable error so the
 *  user can re-confirm after aria2 recovers. */
export async function swapMagnetMetadataForBt(
  input: SwapMagnetMetadataInput,
  deps: SwapMagnetMetadataDeps
): Promise<TaskCreateSuccessResult> {
  return deps.runTaskMutation([input.taskId], () =>
    swapMagnetMetadataForBtUnderMutation(input, deps)
  )
}

/**
 * Keep validation, the metadata-GID teardown, durable reservations, engine
 * creation, and publication under one public-task admission. A duplicate
 * confirmation must observe the committed BT graph before it can inspect the
 * task; otherwise two confirmations can both replace the same metadata owner
 * and leave the losing GID orphaned in aria2.
 */
async function swapMagnetMetadataForBtUnderMutation(
  input: SwapMagnetMetadataInput,
  deps: SwapMagnetMetadataDeps
): Promise<TaskCreateSuccessResult> {
  const {
    taskId,
    base64,
    selectedFiles,
    saveDir,
    name,
    duplicatePolicy = 'reuse',
  } = input
  const {
    db,
    taskManager,
    adapter,
    magnetTracker,
    finalNamePicker,
    torrentMetaStore,
    publishTaskUpdate,
    publishTaskUpdateNow,
    recordTransition,
  } = deps

  const existing = db.getTask(taskId)
  if (!existing) {
    throw new AppError(
      ErrorCode.TaskNotFound,
      `task ${taskId} not found for magnet metadata swap`
    )
  }

  if (
    magnetTracker.hasPendingSwapCleanup(taskId) ||
    existing.instances.some(isMagnetCleanupTombstoneHidden)
  ) {
    throw new AppError(
      ErrorCode.MagnetCleanupPending,
      `aria2 cleanup for a failed magnet swap is still pending for ` +
        `task ${taskId}; please retry confirmation shortly.`
    )
  }
  const previousMetadataInstance =
    existing.instances.length === 1 ? existing.instances[0] : undefined
  if (
    existing.task.taskType !== TaskType.Magnet ||
    existing.task.aggStatus !== TaskStatus.MetadataReady ||
    previousMetadataInstance?.phase !==
      TaskInstancePhase.MagnetMetadataResolution ||
    previousMetadataInstance.status !== TaskStatus.MetadataReady
  ) {
    throw new AppError(
      ErrorCode.InvalidSelection,
      `task ${taskId} is not a MetadataReady magnet selection`
    )
  }
  const existingFiles = db.getTaskFiles(taskId)
  const originalGraph = {
    task: existing.task,
    instances: existing.instances,
    files: existingFiles,
  }
  const originalDownloadTask = taskRowToDownloadTask(
    existing.task,
    existing.instances
  )
  const originalOwner = taskManager.getById(taskId)
  const torrentBytes = Buffer.from(base64, 'base64')

  // Complete every fallible local preparation step before destructively
  // cancelling the metadata fetch. If picker/mkdir/persist rejects, the
  // original cache + metadataDir remain usable and the selection can retry.
  //
  // Mirror createTaskHandler's BT branch: collision-safe final name, a short
  // indexed workspace when metadata is valid, and durable `.torrent` bytes.
  let btStoragePlan: BtStoragePlan | null = null
  let parsedBtLayout: ParsedBtFileLayout | null = null
  try {
    parsedBtLayout = await parseBtFileLayout(torrentBytes)
  } catch (err) {
    if (err instanceof UnsafeTorrentPathError) {
      throw new AppError(
        ErrorCode.TorrentParseFailed,
        'Torrent contains an unsafe file path',
        err
      )
    }
    log.warn(
      { err, taskId },
      'failed to parse resolved magnet metadata for indexed staging; using legacy layout'
    )
  }
  const desiredName = (name ?? existing.task.name).replace(
    METADATA_NAME_PREFIX,
    ''
  )
  if (
    parsedBtLayout &&
    duplicatePolicy === 'reuse' &&
    finalNamePicker.isTaken &&
    (await finalNamePicker.isTaken(saveDir, desiredName))
  ) {
    throw existingFilesConflict(parsedBtLayout.infoHash, saveDir)
  }
  const finalName = await finalNamePicker.pick(
    saveDir,
    desiredName,
    reservedBtFinalNames(taskManager.getAll(), saveDir, taskId)
  )
  const finalPath = path.join(saveDir, finalName)
  if (parsedBtLayout) {
    btStoragePlan = createBtStoragePlan(taskId, saveDir, parsedBtLayout)
  }
  const diskPath = btStoragePlan?.layout.workspacePath ?? toTempPath(finalPath)
  let torrentMetaPath: string
  try {
    await mkdir(diskPath, { recursive: true })

    // Persist the .torrent bytes so finalize's reseed + reAddTask can recover
    // them (both read torrentMetaPath); the pre-fix swap left it null and
    // threw TaskFinalizeMetaMissing on completion.
    torrentMetaPath = await torrentMetaStore.persist(taskId, torrentBytes)
  } catch (cause) {
    // Preparation precedes the durable GID reservation, so there is no
    // tombstone/retry owner yet. Remove a directory that mkdir may have
    // created before rejecting (or that was left after metadata persistence
    // failed) so a retry does not acquire a collision-suffixed final name.
    try {
      await rm(diskPath, { recursive: true, force: true })
    } catch (cleanupError) {
      log.error(
        { err: cleanupError, diskPath, taskId },
        'failed to remove prepared download directory after preparation failure'
      )
    }
    throw cause
  }

  // Make the durable `.torrent` a part of the MetadataReady rollback graph
  // before cancelling the old metadata GID. cancel() removes metadataDir; a
  // later reservation/engine failure (or a crash between those steps) must
  // still leave a restart-readable selection source. The TaskManager mirror
  // moves under the same persistence tail so a queued autosave cannot write
  // the old null torrentMetaPath over this fallback.
  const previousGraph = {
    task: {
      ...existing.task,
      torrentMetaPath,
    },
    instances: existing.instances,
    files: existingFiles,
  }
  const previousDownloadTask = taskRowToDownloadTask(
    previousGraph.task,
    previousGraph.instances
  )
  try {
    await deps.runExclusivePersistence(() => {
      db.saveTaskWithInstancesAndFiles(previousGraph)
      if (originalOwner) {
        taskManager.set(taskId, previousDownloadTask)
      }
    })
  } catch (cause) {
    await rollbackPreparedSwapBeforeMetadataCancel({
      db,
      taskManager,
      originalGraph,
      originalDownloadTask,
      originalOwnerPresent: Boolean(originalOwner),
      diskPath,
      torrentMetaStore,
      torrentMetaPath,
      taskId,
      runExclusivePersistence: deps.runExclusivePersistence,
    })
    throw cause
  }

  // Cancel the metadata fetch only after the durable fallback above exists.
  // Pass deleteTaskRow:false because swap reuses cancel solely to tear down
  // the aria2 metadata GID + cache entry; the persistent parent identity must
  // survive for either BT commit or rollback.
  let cancelResult: Awaited<ReturnType<MagnetTracker['cancel']>>
  try {
    cancelResult = await magnetTracker.cancel(taskId, {
      deleteTaskRow: false,
    })
  } catch (cause) {
    await rollbackPreparedSwapBeforeMetadataCancel({
      db,
      taskManager,
      originalGraph,
      originalDownloadTask,
      originalOwnerPresent: Boolean(originalOwner),
      diskPath,
      torrentMetaStore,
      torrentMetaPath,
      taskId,
      runExclusivePersistence: deps.runExclusivePersistence,
    })
    throw cause
  }
  if (cancelResult === 'quarantined') {
    await rollbackPreparedSwapBeforeMetadataCancel({
      db,
      taskManager,
      originalGraph,
      originalDownloadTask,
      originalOwnerPresent: Boolean(originalOwner),
      diskPath,
      torrentMetaStore,
      torrentMetaPath,
      taskId,
      runExclusivePersistence: deps.runExclusivePersistence,
    })
    throw new AppError(
      ErrorCode.MagnetCleanupPending,
      `aria2 cleanup for magnet metadata fetch is still pending for ` +
        `task ${taskId}; please retry confirmation shortly.`
    )
  }

  // The fallback torrent belongs to previousGraph now. Failed-swap cleanup
  // removes only the new `.motrix` container; deleting torrentMetaPath would
  // restore a MetadataReady row whose only readable selection source is gone.
  const artifactPaths = [diskPath]
  const newGid = randomBytes(8).toString('hex')
  const now = Date.now()
  // The confirmation dialog lets the user change saveDir after metadata
  // resolution. Persist that validated root on the hidden reservation so a
  // restarted cleanup can authorize the new task-derived artifact without
  // trusting an arbitrary path embedded only in instance payload. Cleanup restores
  // previousGraph (including the original finalPath) when it completes.
  const reservationTask: TaskRow = {
    ...previousGraph.task,
    finalPath: saveDir,
    updatedAt: now,
  }
  const reservationInstance: TaskInstanceRow = {
    instanceId: previousMetadataInstance.instanceId,
    motrixId: taskId,
    gid: newGid,
    phase: TaskInstancePhase.MagnetMetadataResolution,
    status: previousMetadataInstance.status,
    progress: previousMetadataInstance.progress,
    totalBytes: previousMetadataInstance.totalBytes,
    downloadedBytes: previousMetadataInstance.downloadedBytes,
    uploadedBytes: previousMetadataInstance.uploadedBytes,
    diskPath,
    transitionPhase: previousMetadataInstance.transitionPhase,
    uris: previousMetadataInstance.uris,
    uriHash: previousMetadataInstance.uriHash,
    payload: withMagnetCleanupRestoreGraph(
      withMagnetCleanupArtifactPaths(
        withMagnetCleanupTombstoneHidden(
          withMagnetCleanupQuarantined(
            {
              ...previousMetadataInstance.payload,
              ...(btStoragePlan ? btStoragePayload(btStoragePlan.layout) : {}),
              metadataDir: diskPath,
            },
            true
          ),
          true
        ),
        artifactPaths
      ),
      previousGraph
    ),
    createdAt: previousMetadataInstance.createdAt,
    updatedAt: now,
  }
  const reservationInstances = [reservationInstance]
  const cleanupReservation = {
    taskId,
    instanceId: reservationInstance.instanceId,
    gid: newGid,
    magnetUri: reservationInstance.uris[0] ?? '',
    saveDir,
    metadataDir: diskPath,
    torrentMetaPath,
    artifactPaths,
    restoreGraph: previousGraph,
    retireEngineGidReservationOnCleanup: true,
  }
  const reservationDownloadTask = taskRowToDownloadTask(
    reservationTask,
    reservationInstances
  )

  // Reserve the caller-selected GID in both TaskManager and MagnetTracker
  // before engine dispatch. The silent TaskManager owner is installed before
  // the serialized DB barrier so a queued SessionManager autosave cannot
  // overwrite the reservation with the old metadata graph.
  let trackerReservationInstalled = false
  try {
    taskManager.reserveEngineTaskId(newGid)
    taskManager.setReservedEngineTaskOwner(
      taskId,
      reservationDownloadTask,
      newGid
    )
    magnetTracker.reserveFailedSwapCleanup(cleanupReservation)
    trackerReservationInstalled = true
    await deps.runExclusivePersistence(() => {
      db.saveTaskWithInstancesAndFiles({
        task: reservationTask,
        instances: reservationInstances,
        files: existingFiles,
      })
    })
  } catch (cause) {
    taskManager.rollbackReservedEngineTaskOwner(
      taskId,
      newGid,
      previousDownloadTask
    )
    if (trackerReservationInstalled) {
      try {
        magnetTracker.releaseFailedSwapCleanup(taskId, newGid)
      } catch (releaseError) {
        log.error(
          { err: releaseError, taskId, newGid },
          'failed to release pre-dispatch magnet swap cleanup shield'
        )
      }
    } else {
      taskManager.releaseEngineTaskIdReservation(newGid)
    }
    try {
      await deps.runExclusivePersistence(() => {
        db.saveTaskWithInstancesAndFiles(previousGraph)
      })
    } catch (restoreError) {
      log.error(
        { err: restoreError, taskId, newGid },
        'failed to roll back durable swap reservation before engine dispatch'
      )
    }
    await cleanupPreparedSwapArtifacts({
      diskPath,
      torrentMetaStore,
      torrentMetaPath,
      previousTorrentMetaPath: previousGraph.task.torrentMetaPath,
      taskId,
    })
    throw cause
  }

  const newInstance: TaskInstanceRow = {
    instanceId: `bt:${taskId}`,
    motrixId: taskId,
    gid: newGid,
    phase: TaskInstancePhase.BtDownload,
    status: TaskStatus.Downloading,
    progress: 0,
    totalBytes: 0,
    downloadedBytes: 0,
    uploadedBytes: 0,
    diskPath,
    transitionPhase: TransitionPhase.Idle,
    uris: [],
    uriHash: null,
    payload: btStoragePlan ? btStoragePayload(btStoragePlan.layout) : {},
    createdAt: now,
    updatedAt: now,
  }

  const updatedTask: TaskRow = {
    ...existing.task,
    name: finalName,
    taskType: TaskType.Bt,
    finalPath,
    finalName,
    torrentMetaPath,
    infoHash: parsedBtLayout?.infoHash ?? existing.task.infoHash,
    isPrivate: parsedBtLayout?.isPrivate ?? existing.task.isPrivate,
    aggStatus: TaskStatus.Downloading,
    finishedAt: null,
    errorMessage: null,
    errorCode: null,
    updatedAt: now,
  }
  // This is only a crash-safe fallback for the narrow window between engine
  // acceptance and the authoritative getFiles read below. The former code
  // persisted these placeholders as the final graph, while the background
  // sync treated any existing row as complete; Files then showed blank names
  // and 0 B forever.
  let taskFileRows = selectedFiles.map((fileIndex) => ({
    fileIndex,
    path: '',
    size: 0,
    selected: true,
  }))
  const restoredDownloadTask = taskRowToDownloadTask(updatedTask, [newInstance])
  const updatedDownloadTask = {
    ...restoredDownloadTask,
    bt: restoredDownloadTask.bt
      ? {
          ...restoredDownloadTask.bt,
          selectedFiles: [...selectedFiles],
        }
      : undefined,
    // Carry over original createdAt so the row stays in its list slot.
    createdAt: existing.task.createdAt,
  }
  try {
    const addedGid = await adapter.addTorrent({
      metadata: torrentBytes,
      saveDir: diskPath,
      gid: newGid,
      // TorrentParser emits 0-based indices, but aria2's --select-file uses
      // 1-based indices; passing `0` makes aria2 reject the option.
      selectedFiles: selectedFiles.map((i) => i + 1),
      outputFilePaths: btStoragePlan?.outputFilePaths,
      pause: false,
      isPrivate: parsedBtLayout?.isPrivate ?? false,
      ...(parsedBtLayout && shouldPrioritizeBtPreviewPieces(parsedBtLayout)
        ? { prioritizePreviewPieces: true }
        : {}),
    })
    if (addedGid !== newGid) {
      throw new Error(
        `engine returned gid ${addedGid} instead of reserved gid ${newGid}`
      )
    }
    try {
      const liveFiles = await adapter.getTaskFiles(newGid)
      if (liveFiles.length > 0) {
        // Persist every torrent file, including unselected rows, so the Files
        // tab can render the complete structure and selection state before
        // the first polling tick.
        taskFileRows = liveFiles.map((file) => ({
          fileIndex: file.index,
          path: file.path,
          size: file.size,
          selected: file.selected,
        }))
      }
    } catch (err) {
      // Engine acceptance already succeeded. Keep the durable placeholder
      // graph and let the polling repair path retry rather than turning a
      // transient read failure into a destructive swap rollback.
      log.warn(
        { err, taskId, newGid },
        'could not hydrate magnet swap file metadata; polling will retry'
      )
    }
    await deps.runExclusivePersistence(async () => {
      db.saveTaskWithInstancesAndFiles({
        task: updatedTask,
        instances: [newInstance],
        files: taskFileRows,
      })
      if (
        recordTransition &&
        existing.task.aggStatus !== updatedTask.aggStatus
      ) {
        try {
          await recordTransition({
            taskId,
            previousStatus: existing.task.aggStatus,
            nextStatus: updatedTask.aggStatus,
            occurredAt: now,
            monotonicAt: deps.monotonicNow?.() ?? performance.now(),
            accuracy: 'exact',
            errorCode: updatedTask.errorCode,
            errorMessage: updatedTask.errorMessage,
            errorDetailKey: updatedTask.errorDetailKey,
            errorDetailParams: updatedTask.errorDetailParams,
          })
        } catch (err) {
          log.error(
            { err, taskId },
            'magnet swap Activity transition recording failed'
          )
        }
      }
      // Ordinary set() claims the reservation only after graph + Activity are
      // durable. Holding the persistence tail through publication prevents a
      // queued autosave from writing the silent reservation back over success.
      taskManager.set(taskId, updatedDownloadTask)
    })
  } catch (cause) {
    const cleanupAt = Date.now()
    const cleanupInstance: TaskInstanceRow = {
      ...reservationInstance,
      status: TaskStatus.Error,
      updatedAt: cleanupAt,
    }
    const cleanupTask: TaskRow = {
      ...reservationTask,
      taskType: TaskType.Magnet,
      torrentMetaPath,
      aggStatus: TaskStatus.Error,
      finishedAt: cleanupAt,
      errorMessage: 'Magnet swap cleanup is quarantined',
      errorCode: null,
      updatedAt: cleanupAt,
    }

    const compensation = await compensateFailedSwap({
      adapter,
      gid: newGid,
      diskPath,
      torrentMetaStore,
      torrentMetaPath,
      previousTorrentMetaPath: previousGraph.task.torrentMetaPath,
      taskId,
    })
    let quarantineRequired = !compensation.complete
    let tombstonePersisted = false

    if (compensation.complete) {
      try {
        await deps.runExclusivePersistence(() => {
          db.saveTaskWithInstancesAndFiles(previousGraph)
          // Replace the silent reserved owner before atomically converting the
          // new GID reservation into a bounded retired shield. A poll snapshot
          // captured before forceRemove can now finish without orphan-adopting.
          taskManager.set(taskId, previousDownloadTask)
          taskManager.retireEngineTaskIdReservation(newGid)
        })
      } catch (restoreError) {
        quarantineRequired = true
        log.error(
          { err: restoreError, taskId, newGid },
          'failed magnet swap could not restore its pre-swap graph'
        )
      }
    }

    if (!quarantineRequired) {
      try {
        magnetTracker.releaseFailedSwapCleanup(taskId, newGid)
      } catch (releaseError) {
        log.error(
          { err: releaseError, taskId, newGid },
          'failed magnet swap could not release its cleanup shield'
        )
      }
    } else {
      try {
        const cleanupDownloadTask = taskRowToDownloadTask(cleanupTask, [
          cleanupInstance,
        ])
        await deps.runExclusivePersistence(async () => {
          db.saveTaskWithInstancesAndFiles({
            task: cleanupTask,
            instances: [cleanupInstance],
            files: existingFiles,
          })
          if (
            recordTransition &&
            existing.task.aggStatus !== cleanupTask.aggStatus
          ) {
            try {
              await recordTransition({
                taskId,
                previousStatus: existing.task.aggStatus,
                nextStatus: cleanupTask.aggStatus,
                occurredAt: cleanupAt,
                monotonicAt: deps.monotonicNow?.() ?? performance.now(),
                accuracy: 'exact',
                errorCode: cleanupTask.errorCode,
                errorMessage: cleanupTask.errorMessage,
                errorDetailKey: cleanupTask.errorDetailKey,
                errorDetailParams: cleanupTask.errorDetailParams,
              })
            } catch (activityError) {
              log.error(
                { err: activityError, taskId },
                'failed-swap quarantine Activity transition recording failed'
              )
            }
          }
          // Keep the non-evictable reservation while hiding the failed owner.
          // MagnetTracker's cache + durable tombstone continue cleanup.
          taskManager.setReservedEngineTaskOwner(
            taskId,
            cleanupDownloadTask,
            newGid
          )
          taskManager.remove(taskId)
        })
        tombstonePersisted = true
      } catch (quarantineError) {
        // The pre-add reservation is already durable and still owns newGid.
        // This Error-state write is presentation metadata, not the ownership
        // boundary, so failure cannot make the engine task ownerless.
        log.error(
          { err: quarantineError, taskId, newGid },
          'failed magnet swap could not promote its durable reservation to an Error tombstone'
        )
      }

      try {
        magnetTracker.registerFailedSwapCleanup({
          ...cleanupReservation,
          deleteParentOnSuccess: false,
        })
      } catch (registrationError) {
        log.error(
          { err: registrationError, taskId, newGid },
          'failed magnet swap could not register in-process cleanup'
        )
      }

      if (tombstonePersisted) {
        try {
          publishTaskUpdateNow()
        } catch (publicationError) {
          log.error(
            { err: publicationError, taskId, newGid },
            'failed-swap quarantine publication failed'
          )
        }
      }
    }
    throw cause
  }

  // Keep the temporary MagnetTracker shield through the Activity await.
  // A poll may have captured newGid immediately after aria2 accepted it; the
  // shield must not be released until TaskManager has installed the durable
  // BT graph as its authoritative in-process owner, or that late poll can
  // mint a duplicate orphan taskId.
  try {
    magnetTracker.releaseFailedSwapCleanup(taskId, newGid)
  } catch (releaseError) {
    // TaskManager already owns newGid, so an unexpected release failure
    // cannot create an orphan. MagnetTracker.observe also self-clears a stale
    // failed-swap shield once it sees this exact BT owner.
    log.error(
      { err: releaseError, taskId, newGid },
      'successful magnet swap could not release its temporary cleanup shield'
    )
  }

  // Publish the swapped snapshot so the renderer drops the
  // [METADATA]… name + Fetching pill and renders the bt_download
  // state within one coalescing window instead of waiting for the
  // next poll tick.
  publishTaskUpdate()

  log.info(
    { taskId, newGid, name: updatedTask.name },
    'magnet metadata swapped for bt_download instance'
  )

  return { outcome: 'created', gid: newGid, taskId }
}

interface FailedSwapArtifacts {
  adapter: EngineAdapter
  gid: string
  diskPath: string
  torrentMetaStore: TorrentMetaStore
  torrentMetaPath: string
  previousTorrentMetaPath: string | null
  taskId: string
}

interface FailedSwapCompensation {
  complete: boolean
}

interface PreparedMetadataFallbackRollback {
  db: MotrixDatabase
  taskManager: TaskManager
  originalGraph: TaskWithInstancesAndFiles
  originalDownloadTask: DownloadTask
  originalOwnerPresent: boolean
  diskPath: string
  torrentMetaStore: TorrentMetaStore
  torrentMetaPath: string
  taskId: string
  runExclusivePersistence: SwapMagnetMetadataDeps['runExclusivePersistence']
}

async function rollbackPreparedSwapBeforeMetadataCancel(
  input: PreparedMetadataFallbackRollback
): Promise<void> {
  let graphRestored = false
  try {
    await input.runExclusivePersistence(() => {
      input.db.saveTaskWithInstancesAndFiles(input.originalGraph)
      if (input.originalOwnerPresent) {
        input.taskManager.set(input.taskId, input.originalDownloadTask)
      }
    })
    graphRestored = true
  } catch (restoreError) {
    // Keep the staged durable torrent when the DB rollback fails: that graph
    // may already point at it, and deleting the file would make restart
    // recovery strictly worse.
    log.error(
      { err: restoreError, taskId: input.taskId },
      'failed to restore metadata graph after metadata cancellation rejection'
    )
  }

  await cleanupPreparedSwapArtifacts({
    diskPath: input.diskPath,
    torrentMetaStore: input.torrentMetaStore,
    torrentMetaPath: input.torrentMetaPath,
    previousTorrentMetaPath: graphRestored
      ? input.originalGraph.task.torrentMetaPath
      : input.torrentMetaPath,
    taskId: input.taskId,
  })
}

async function cleanupPreparedSwapArtifacts(
  artifacts: Omit<FailedSwapArtifacts, 'adapter' | 'gid'>
): Promise<void> {
  const {
    diskPath,
    torrentMetaStore,
    torrentMetaPath,
    previousTorrentMetaPath,
    taskId,
  } = artifacts

  if (torrentMetaPath !== previousTorrentMetaPath) {
    try {
      await torrentMetaStore.remove(torrentMetaPath)
    } catch (err) {
      log.error(
        { err, torrentMetaPath, taskId },
        'failed to remove prepared torrent metadata after reservation rejection'
      )
    }
  }
  try {
    await rm(diskPath, { recursive: true, force: true })
  } catch (err) {
    log.error(
      { err, diskPath, taskId },
      'failed to remove prepared download directory after reservation rejection'
    )
  }
}

async function compensateFailedSwap(
  artifacts: FailedSwapArtifacts
): Promise<FailedSwapCompensation> {
  const {
    adapter,
    gid,
    diskPath,
    torrentMetaStore,
    torrentMetaPath,
    previousTorrentMetaPath,
    taskId,
  } = artifacts

  try {
    await adapter.forceRemoveTask(gid)
  } catch (err) {
    log.error(
      { err, gid, taskId },
      'failed magnet swap could not force-remove its new aria2 gid'
    )
  }

  try {
    await adapter.removeDownloadResult(gid)
  } catch (err) {
    log.error(
      { err, gid, taskId },
      'failed magnet swap could not remove its new aria2 result'
    )
    return { complete: false }
  }
  // removeDownloadResult success (including the adapter's explicit
  // not-found idempotence) is authoritative absence. forceRemove may have
  // raced a row that was already stopped, so its failure alone must not turn
  // a fully removed swap into a permanent cleanup quarantine.

  let artifactCleanupComplete = true
  if (torrentMetaPath !== previousTorrentMetaPath) {
    try {
      await torrentMetaStore.remove(torrentMetaPath)
    } catch (err) {
      artifactCleanupComplete = false
      log.error(
        { err, torrentMetaPath, taskId },
        'failed magnet swap could not remove its torrent metadata artifact'
      )
    }
  }

  try {
    await rm(diskPath, { recursive: true, force: true })
  } catch (err) {
    artifactCleanupComplete = false
    log.error(
      { err, diskPath, taskId },
      'failed magnet swap could not remove its download artifact'
    )
  }

  return { complete: artifactCleanupComplete }
}
