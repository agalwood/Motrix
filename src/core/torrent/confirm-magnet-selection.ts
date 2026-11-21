import { mkdir } from 'node:fs/promises'
import path from 'node:path'
import type { EngineAdapter } from '@core/engine/engine-adapter'
import { getLogger } from '@core/logger'
import type {
  MotrixDatabase,
  TaskInstanceRow,
  TaskRow,
} from '@core/session/motrix-database'
import type { TaskTransitionRecordInput } from '@core/task/actions/shared'
import {
  existingFilesConflict,
  reservedBtFinalNames,
  withBtOutputAdmission,
} from '@core/task/bt-duplicate-policy'
import { getBtOutputReservations } from '@core/task/bt-output-reservation'
import {
  btStoragePayload,
  createBtDirectStoragePlan,
  type ParsedBtFileLayout,
  parseBtFileLayout,
  UnsafeTorrentPathError,
} from '@core/task/bt-storage-layout'
import type { FinalNamePicker } from '@core/task/final-name-picker'
import {
  outputNameIdentity,
  outputPathIdentity,
} from '@core/task/output-path-identity'
import type { TaskManager } from '@core/task/task-manager'
import { taskRowToDownloadTask } from '@core/task/task-row-to-download-task'
import type { TorrentMetaStore } from '@core/task/torrent-meta-store'
import { AppError, ErrorCode } from '@shared/errors'
import { parseEngineTorrent } from '@shared/lib/engine-torrent'
import { manifestToEngineTorrent } from '@shared/lib/torrent-manifest'
import type { TaskCreateSuccessResult } from '@shared/schemas/add-task'
import { torrentSelectionSchema } from '@shared/schemas/torrent-selection'
import { TaskInstancePhase, TaskStatus, TaskType } from '@shared/types/task'
import { isMagnetCleanupTombstoneHidden } from './magnet-cleanup-quarantine'
import type { MagnetTracker } from './magnet-tracker'
import { confirmPendingTorrentSelection } from './pending-torrent-selection'
import {
  manifestRecord,
  persistTorrentManifest,
} from './verified-torrent-artifact'

const log = getLogger('confirm-magnet-selection')

// MagnetTracker.submit names the pending row `[METADATA] <uri>`; strip the
// prefix before deriving the on-disk name in case onComplete hasn't already
// replaced it with the resolved torrent name.
const METADATA_NAME_PREFIX = /^\[METADATA\] /

export interface ConfirmMagnetSelectionInput {
  taskId: string
  base64: string
  selectedFiles: number[]
  saveDir: string
  /** Resolved torrent display name. When provided, replaces the
   *  `[METADATA] …` placeholder name on the task row. */
  name?: string
  duplicatePolicy?: 'reuse' | 'create-copy'
}

export interface ConfirmMagnetSelectionDeps {
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

/** Confirm the existing magnet task in place after reserving its output layout. */
export async function confirmMagnetSelection(
  input: ConfirmMagnetSelectionInput,
  deps: ConfirmMagnetSelectionDeps
): Promise<TaskCreateSuccessResult> {
  return withBtOutputAdmission(input.saveDir, () =>
    deps.runTaskMutation([input.taskId], () =>
      confirmMagnetSelectionUnderMutation(input, deps)
    )
  )
}

async function confirmMagnetSelectionUnderMutation(
  input: ConfirmMagnetSelectionInput,
  deps: ConfirmMagnetSelectionDeps
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
  const originalDownloadTask = taskRowToDownloadTask(
    existing.task,
    existing.instances
  )
  const torrentBytes = Buffer.from(base64, 'base64')
  const nativeMetadata = await adapter.getTorrentMetadata(
    previousMetadataInstance.gid ?? ''
  )
  if (
    !nativeMetadata.awaitingSelection ||
    !torrentBytes.equals(Buffer.from(nativeMetadata.data, 'base64'))
  ) {
    throw new AppError(
      ErrorCode.InvalidSelection,
      'Torrent metadata does not match the pending magnet task'
    )
  }
  const parsedMetadata = nativeMetadata.manifest
    ? manifestToEngineTorrent(nativeMetadata.manifest)
    : await parseEngineTorrent(torrentBytes)
  torrentSelectionSchema.shape.selectedFiles.parse(selectedFiles)
  if (
    selectedFiles.some(
      (index) =>
        !parsedMetadata.files?.[index] || parsedMetadata.files[index].padding
    )
  ) {
    throw new AppError(
      ErrorCode.InvalidSelection,
      'Select valid torrent payload files'
    )
  }

  // Complete every fallible local preparation step before destructively
  // cancelling the metadata fetch. If picker/mkdir/persist rejects, the
  // original cache + metadataDir remain usable and the selection can retry.
  //
  // Mirror createTaskHandler's BT branch: collision-safe final output,
  // indexed paths when metadata is valid, and durable `.torrent` bytes.
  let parsedBtLayout: ParsedBtFileLayout | null = null
  try {
    parsedBtLayout = await parseBtFileLayout(
      torrentBytes,
      undefined,
      parsedMetadata
    )
  } catch (err) {
    if (err instanceof AppError) throw err
    throw new AppError(
      ErrorCode.TorrentParseFailed,
      err instanceof UnsafeTorrentPathError
        ? 'Torrent contains an unsafe file path'
        : 'Invalid torrent metadata',
      err
    )
  }
  const desiredName = (name ?? existing.task.name).replace(
    METADATA_NAME_PREFIX,
    ''
  )
  const reservedNames = reservedBtFinalNames(
    taskManager.getAll(),
    saveDir,
    taskId
  )
  const previousReservations = getBtOutputReservations(originalDownloadTask)
  const reservation = previousReservations.find(
    (entry) =>
      outputPathIdentity(entry.finalPath) ===
      outputPathIdentity(path.join(saveDir, desiredName))
  )
  const reuseOutput =
    duplicatePolicy === 'reuse' &&
    parsedBtLayout !== null &&
    reservation?.infoHash === parsedBtLayout.infoHash &&
    reservation !== undefined &&
    !reservedNames.some(
      (reserved) =>
        outputNameIdentity(reserved) === outputNameIdentity(desiredName) ||
        (parsedBtLayout.multiFile === false &&
          outputNameIdentity(reserved) ===
            outputNameIdentity(`${desiredName}.aria2`))
    )
  if (
    parsedBtLayout &&
    duplicatePolicy === 'reuse' &&
    !reuseOutput &&
    finalNamePicker.isTaken &&
    (await finalNamePicker.isTaken(
      saveDir,
      desiredName,
      parsedBtLayout.multiFile === false
    ))
  ) {
    throw existingFilesConflict(parsedBtLayout.infoHash, saveDir)
  }
  const finalName = reuseOutput
    ? desiredName
    : await finalNamePicker.pick(
        saveDir,
        desiredName,
        reservedNames,
        parsedBtLayout?.multiFile === false
      )
  const finalPath = path.join(saveDir, finalName)
  // Persist metadata before creating any output or stopping metadata resolution.
  const torrentMetaPath = await torrentMetaStore.persist(taskId, torrentBytes)
  const verifiedManifest = nativeMetadata.manifest
    ? await persistTorrentManifest(
        torrentMetaPath,
        manifestRecord(nativeMetadata.manifest, torrentBytes)
      )
    : undefined
  const btStoragePlan = createBtDirectStoragePlan(
    finalPath,
    parsedBtLayout,
    torrentMetaPath
  )
  await mkdir(btStoragePlan.saveDir, { recursive: true })

  const gid = previousMetadataInstance.gid
  if (!gid)
    throw new AppError(
      ErrorCode.TaskNotFound,
      'Magnet task has no engine identity'
    )
  const now = Date.now()
  const selection = {
    saveDir: btStoragePlan.outputRoot ?? btStoragePlan.saveDir,
    selectedFiles,
    outputFilePaths: btStoragePlan.outputFilePaths ?? [],
  }
  const instance: TaskInstanceRow = {
    ...previousMetadataInstance,
    phase: TaskInstancePhase.BtDownload,
    status: TaskStatus.Paused,
    diskPath: finalPath,
    payload: {
      ...btStoragePayload(btStoragePlan.layout),
      pendingTorrentSelection: selection,
      ...(verifiedManifest
        ? { verifiedTorrentManifest: verifiedManifest }
        : {}),
    },
    updatedAt: now,
  }
  const updatedTask: TaskRow = {
    ...existing.task,
    name: finalName,
    finalName,
    saveDir,
    finalPath,
    torrentMetaPath,
    taskType: TaskType.Bt,
    infoHash: parsedBtLayout.infoHash,
    isPrivate: parsedBtLayout.isPrivate,
    aggStatus: TaskStatus.Paused,
    errorMessage: null,
    errorCode: null,
    finishedAt: null,
    updatedAt: now,
  }
  const files = parsedBtLayout.files.map((file) => ({
    fileIndex: file.fileIndex,
    path:
      selection.outputFilePaths.find(
        (output) => output.fileIndex === file.fileIndex
      )?.relativePath ??
      file.pathInsideRoot ??
      finalName,
    size: parsedMetadata.files?.[file.fileIndex]?.length ?? 0,
    selected: selectedFiles.includes(file.fileIndex),
  }))
  const pending = taskRowToDownloadTask(updatedTask, [instance])
  if (pending.bt) pending.bt.selectedFiles = [...selectedFiles]
  // User intent and output ownership precede any payload IO. A crash or lost
  // response leaves a replayable confirmation on the same engine task.
  await deps.runExclusivePersistence(() => {
    db.saveTaskWithInstancesAndFiles({
      task: updatedTask,
      instances: [instance],
      files,
    })
    taskManager.set(taskId, pending)
  })
  magnetTracker.releaseSelection(taskId)
  try {
    const confirmed = await confirmPendingTorrentSelection(pending, adapter)
    const completedInstance = {
      ...instance,
      status: TaskStatus.Downloading,
      payload: confirmed.instances[0].payload,
    }
    updatedTask.aggStatus = TaskStatus.Downloading
    let liveFiles = files
    try {
      liveFiles = (await adapter.getTaskFiles(gid)).map((file) => ({
        fileIndex: file.index,
        path: file.path,
        size: file.size,
        selected: file.selected,
      }))
    } catch (error) {
      log.warn(
        { err: error, taskId },
        'file metadata hydration will retry through polling'
      )
    }
    await deps.runExclusivePersistence(async () => {
      db.saveTaskWithInstancesAndFiles({
        task: updatedTask,
        instances: [completedInstance],
        files: liveFiles.length ? liveFiles : files,
      })
      taskManager.set(taskId, confirmed)
      try {
        await recordTransition?.({
          taskId,
          previousStatus: existing.task.aggStatus,
          nextStatus: TaskStatus.Downloading,
          occurredAt: now,
          monotonicAt: deps.monotonicNow?.() ?? performance.now(),
          accuracy: 'exact',
          errorCode: null,
          errorMessage: null,
          errorDetailKey: null,
          errorDetailParams: null,
        })
      } catch (err) {
        log.warn(
          { err, taskId },
          'selection activity recording failed after commit'
        )
      }
    })
  } finally {
    // A failed confirmation stays paused with its durable selection. Resume
    // and restart replay it, without deleting metadata or creating a new GID.
    publishTaskUpdate()
  }
  return { outcome: 'created', gid, taskId }
}
