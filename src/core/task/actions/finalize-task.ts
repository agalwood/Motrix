import path from 'node:path'
import { newEngineTaskId } from '@core/lib/ids'
import type { HookAuditLog } from '@core/plugin/hooks/audit-log'
import type { HookOrchestrator } from '@core/plugin/hooks/hook-orchestrator'
import { AppError, ErrorCode } from '@shared/errors'
import type { BeforeFinalizeContextDTO } from '@shared/types/plugin-hooks'
import type { DownloadTask, TaskFile } from '@shared/types/task'
import { TaskStatus, TransitionPhase } from '@shared/types/task'
import { isTorrentLike } from '@shared/types/task-actions'
import {
  TaskActivityAccuracy,
  type TaskActivityRecorder,
} from '@shared/types/task-activity'
import type { TaskOccurrence } from '@shared/types/task-occurrence'
import type Database from 'better-sqlite3'
import type { AddTorrentParams } from '../../engine/engine-adapter'
import { applyTerminalTransition } from '../apply-terminal-transition'
import {
  buildFinalOutputFilePaths,
  getBtPayloadPath,
  getBtStorageLayout,
  parseBtFileLayout,
} from '../bt-storage-layout'
import { fireAfterComplete, fireOnError } from '../hook-dispatch'
import { normalizeTerminalRuntimeMetrics } from '../normalize-terminal-runtime-metrics'
import type { OccurrenceDispatcher } from '../occurrences/occurrence-dispatcher'
import {
  applyTerminalStatusToTask,
  completeTaskAfterRename,
  setTaskTransitionPhase,
  syncPrimaryInstanceIdentity,
} from '../task-instance'
import {
  commitTerminalTaskTransition,
  getTaskOrWarn,
  recordTaskTransitionOrWarn,
  type TaskTransitionRecordInput,
} from './shared'

const finalizationsInFlight = new Set<string>()

export interface FinalizeTaskDeps {
  taskManager: {
    getById(id: string): DownloadTask | undefined
    getAll(): DownloadTask[]
    set(id: string, task: DownloadTask): void
    setReservedEngineTaskOwner(
      id: string,
      task: DownloadTask,
      engineTaskId: string
    ): void
    reserveEngineTaskId(engineTaskId: string): void
    releaseEngineTaskIdReservation(engineTaskId: string): boolean
    retireEngineTaskIdReservation(engineTaskId: string): boolean
    persist(task: DownloadTask): Promise<void>
  }
  /**
   * Persist a task and (when non-null) its terminal occurrence in a single
   * durable transaction — used INSTEAD OF `taskManager.persist` whenever a
   * status transition qualifies for an occurrence (see
   * `buildTerminalOccurrence`). Optional so tests that don't care about
   * occurrences can omit it; absence degrades to plain `taskManager.persist`.
   */
  persistTaskWithOccurrence?: (
    task: DownloadTask,
    occurrence: TaskOccurrence | null
  ) => Promise<void>
  /** Delivers a just-committed terminal occurrence to in-process consumers.
   *  Narrowed to `dispatch` so tests can supply a plain `{ dispatch }`
   *  double. */
  occurrenceDispatcher?: Pick<OccurrenceDispatcher, 'dispatch'>
  /**
   * Coalesced TaskUpdated publication (TaskUpdatePublisher.publish) for
   * non-terminal states (Finalizing, Seeding) and its immediate variant
   * (publishNow) for every path that lands in Completed/Error or must
   * broadcast before throwing — the renderer learns about finalize-side
   * failures only through these (no poll observes stopped rows).
   */
  publishTaskUpdate: () => void
  publishTaskUpdateNow: () => void
  adapter: {
    removeDownloadResult(engineTaskId: string): Promise<void>
    forceRemoveTask(engineTaskId: string): Promise<void>
    getUploadLength(engineTaskId: string): Promise<number>
    // Pull the live aria2 view of this gid. Used by finalizeHttp to refresh
    // byte counters BEFORE removeDownloadResult retires the gid — fixes the
    // super-tiny HTTP race where the download finished faster than the
    // polling tick that would have observed totalLength/completedLength.
    getTaskStatus(engineTaskId: string): Promise<DownloadTask | null>
    // Snapshot the live file list (path + selected flag) BEFORE the gid is
    // retired — aria2 drops the RequestGroup once forceRemove fires, so
    // we cannot query selected after that point. Used to compute the
    // unselected cleanup set in finalizeBt.
    getTaskFiles(engineTaskId: string): Promise<TaskFile[]>
    addTorrent(params: AddTorrentParams): Promise<string>
  }
  fs: {
    renameAtomic(src: string, dst: string): Promise<void>
    // Idempotent: ignores ENOENT so the unselected cleanup is safe to
    // run even when aria2's own `bt-remove-unselected-file=true` already
    // deleted the file (race-free overlap).
    removePathRecursive(absPath: string): Promise<void>
  }
  torrentMetaStore: {
    read(metaPath: string): Promise<Uint8Array>
  }
  /** Rebase persisted task_files after the staging payload is renamed. */
  rebaseTaskFilePaths?: (
    taskId: string,
    sourceRoot: string,
    finalRoot: string
  ) => void
  settings: {
    get(): { bt: { seedTime: number; seedRatio: number } }
  }
  eventBus: {
    emit(event: string, payload: unknown): void
  }
  activityRecorder: TaskActivityRecorder
  log: {
    info(ctx: Record<string, unknown>, msg: string): void
    warn(ctx: Record<string, unknown>, msg: string): void
    error(ctx: Record<string, unknown>, msg: string): void
  }
  // Optional plugin-hook plumbing (Plan C / T15). Same backward-compat
  // contract as CreateTaskDeps: all three must be set for the chain to
  // fire; absence is a clean no-op.
  orchestrator?: HookOrchestrator
  auditLog?: HookAuditLog
  db?: Database.Database
  recordTransition?: (input: TaskTransitionRecordInput) => void | Promise<void>
  runTaskMutation?: <T>(
    taskIds: readonly string[],
    operation: () => Promise<T>
  ) => Promise<T>
  monotonicNow?: () => number
  createEngineTaskId?: () => string
}

export async function finalizeTask(
  taskId: string,
  deps: FinalizeTaskDeps
): Promise<void> {
  const finalize = () => finalizeTaskSerialized(taskId, deps)
  await (deps.runTaskMutation
    ? deps.runTaskMutation([taskId], finalize)
    : finalize())
}

async function finalizeTaskSerialized(
  taskId: string,
  deps: FinalizeTaskDeps
): Promise<void> {
  const publishedTask = getTaskOrWarn(deps, taskId, 'finalizeTask')
  if (!publishedTask) return
  const task = structuredClone(publishedTask)

  const alreadyOutputReady =
    task.transitionPhase === TransitionPhase.Idle &&
    task.diskPath === task.finalPath &&
    (task.status === TaskStatus.Completed || task.status === TaskStatus.Seeding)
  if (alreadyOutputReady || finalizationsInFlight.has(taskId)) {
    deps.log.info(
      {
        taskId,
        status: task.status,
        transitionPhase: task.transitionPhase,
        alreadyOutputReady,
      },
      'finalize_skipped'
    )
    return
  }

  finalizationsInFlight.add(taskId)
  try {
    deps.log.info(
      { taskId, type: task.type, fromPhase: task.transitionPhase },
      'finalize_started'
    )

    if (isTorrentLike(task)) {
      await finalizeBt(task, deps)
    } else {
      await finalizeHttp(task, deps)
    }
  } finally {
    finalizationsInFlight.delete(taskId)
  }
}

async function finalizeHttp(
  task: DownloadTask,
  deps: FinalizeTaskDeps
): Promise<void> {
  setTaskTransitionPhase(task, TransitionPhase.Renaming)
  await persistTaskState(task, deps)

  // Plan C plugin-hook chain: beforeFinalize. Eligible plugins can request
  // a different final filePath (e.g. ffmpeg-transcode plugin) and stage
  // metadata that will be committed alongside the rename. Aborted chains
  // skip the rename entirely and mark the task Error.
  const finalizeOutcome = await runBeforeFinalize(task, deps)
  if (finalizeOutcome.aborted) {
    const cause = finalizeOutcome.reason
    await failFinalize(task, deps, {
      errorMessage: `plugin chain aborted: ${cause}`,
      errorDetailKey: 'task.error.detail.pluginChainAborted',
      errorDetailParams: { cause },
      hookCode: 'PLUGIN_RUNTIME_FAULT',
    })
    return
  }
  const desiredFinalPath = finalizeOutcome.finalFilePath ?? task.finalPath
  const renameSource = task.diskPath
  await persistDesiredFinalPath(task, desiredFinalPath, deps)

  // Refresh byte counters and piece length from aria2 BEFORE
  // removeDownloadResult retires the gid. The polling loop only sees
  // active/waiting tasks, so a
  // super-tiny HTTP download that completes between two ticks never gets
  // its totalLength/completedLength merged into our task — finalize would
  // then persist `Completed` with `totalBytes=0`, leaving the UI showing
  // `Size 0 / 0%`. Pull once here so syncCompletionMetrics has real
  // numbers to seal. Best-effort: any failure (race with another retire,
  // RPC error) is logged and we fall through with whatever we already had.
  await refreshTaskBytesBeforeFinalize(task, deps)

  // removeDownloadResult before rename so aria2 releases the file
  // handle — on Windows an open handle causes a sharing violation.
  await deps.adapter.removeDownloadResult(task.engineTaskId)

  try {
    await deps.fs.renameAtomic(renameSource, desiredFinalPath)
  } catch (e) {
    const cause = (e as Error).message
    const errorMessage = `Failed to rename file: ${cause}`
    await failFinalize(task, deps, {
      errorMessage,
      errorDetailKey: 'task.error.detail.renameFileFailed',
      errorDetailParams: { cause },
      hookCode: 'TASK_FINALIZE_RENAME_FAILED',
    })
    throw new AppError(ErrorCode.TaskFinalizeRenameFailed, errorMessage, e)
  }
  const completedAt = Date.now()

  // task_files stores aria2's physical path while a direct download is in
  // progress. Keep that durable structure aligned with the rename so restored
  // completed tasks no longer point at the retired `.motrix` staging file.
  // The Files query also projects a logical display name while downloading;
  // this rebase fixes the underlying persisted path after completion.
  try {
    deps.rebaseTaskFilePaths?.(task.id, renameSource, desiredFinalPath)
  } catch (err) {
    deps.log.warn(
      { err, taskId: task.id },
      'finalize_http_task_file_path_rebase_failed'
    )
  }

  // Commit staged plugin metadata now that rename succeeded. The SQLite
  // tx body itself is empty here — the rename happened outside the tx
  // (it's async IO; SQLite transactions must complete synchronously).
  try {
    finalizeOutcome.commit(() => {})
  } catch (err) {
    deps.log.warn(
      { taskId: task.id, err: (err as Error).message },
      'finalize_http_metadata_commit_failed'
    )
  }

  task.finalPath = desiredFinalPath
  const previousStatus = task.status
  completeTaskAfterRename(
    task,
    desiredFinalPath,
    completedAt,
    deps.activityRecorder
  )
  syncCompletionMetrics(task)
  await persistTaskTransition(task, previousStatus, deps, completedAt)

  deps.publishTaskUpdateNow()
  deps.log.info({ taskId: task.id }, 'finalize_http_completed')
  fireAfterComplete(deps, task, 'finalize')
}

/**
 * Sync byte counters to 100% completion at terminal-state transitions.
 *
 * aria2's `onDownloadComplete` / `onBtDownloadComplete` only fire after
 * the file is fully on disk, but the polling tick that would carry the
 * final `downloadedBytes === totalBytes` value can race the event —
 * for fast downloads, finalize runs before the next poll and the task
 * persists as Completed (or Seeding) at some sub-100% progress. Once
 * `removeDownloadResult` retires the gid, those values become permanent
 * and the UI shows e.g. "Completed · 87%" forever. Sync defensively at
 * every Completed/Seeding hand-off.
 *
 * Chunked-encoding fallback: when `totalBytes` is still 0 but the file
 * IS on disk (we got here via onDownloadComplete) and we have a non-zero
 * `downloadedBytes`, treat the received bytes as the authoritative total.
 * This covers HTTP responses that finished without ever carrying a
 * Content-Length header. Without this fallback the UI would show
 * `Size 0 / 0%` forever despite the file being valid on disk.
 */
function syncCompletionMetrics(task: DownloadTask): void {
  if (task.totalBytes > 0) {
    task.downloadedBytes = task.totalBytes
    task.sizeWhenDone = task.totalBytes
    task.progress = 1
    return
  }
  if (task.downloadedBytes > 0) {
    task.totalBytes = task.downloadedBytes
    task.sizeWhenDone = task.downloadedBytes
    task.progress = 1
  }
}

/**
 * Best-effort refresh of byte counters from aria2 just before the gid is
 * retired. Only fills fields the caller still has at zero — anything the
 * polling loop already wrote stays as-is (same "0 never overwrites
 * non-zero" invariant nonZeroMerge enforces on the hot path).
 *
 * Failures (RPC error, gid already gone, stub adapter in tests) are
 * swallowed: the caller's existing task state remains the source of
 * truth and syncCompletionMetrics will still do what it can.
 */
async function refreshTaskBytesBeforeFinalize(
  task: DownloadTask,
  deps: FinalizeTaskDeps
): Promise<void> {
  try {
    const refreshed = await deps.adapter.getTaskStatus(task.engineTaskId)
    if (!refreshed) return
    if (task.totalBytes === 0 && refreshed.totalBytes > 0) {
      task.totalBytes = refreshed.totalBytes
    }
    if (task.downloadedBytes === 0 && refreshed.downloadedBytes > 0) {
      task.downloadedBytes = refreshed.downloadedBytes
    }
    if (task.sizeWhenDone === 0 && refreshed.sizeWhenDone > 0) {
      task.sizeWhenDone = refreshed.sizeWhenDone
    }
    if (task.pieceLength === 0 && refreshed.pieceLength > 0) {
      task.pieceLength = refreshed.pieceLength
    }
  } catch (err) {
    deps.log.warn(
      { err, taskId: task.id, gid: task.engineTaskId },
      'finalize_http_pre_refresh_failed'
    )
  }
}

async function finalizeBt(
  task: DownloadTask,
  deps: FinalizeTaskDeps
): Promise<void> {
  if (
    task.transitionPhase === TransitionPhase.Reseeding &&
    task.diskPath === task.finalPath
  ) {
    const detectedAt = Date.now()
    deps.activityRecorder.recordDownloadCompleted({
      taskId: task.id,
      occurredAt: detectedAt,
      accuracy: TaskActivityAccuracy.Recovered,
    })
    await finalizeBtAfterRename(task, deps, detectedAt, [])
    return
  }

  const previousStatus = task.status
  Object.assign(task, applyTerminalTransition(task, TaskStatus.Finalizing))
  setTaskTransitionPhase(task, TransitionPhase.Renaming)
  syncPrimaryInstanceIdentity(task)
  await persistTaskTransition(task, previousStatus, deps)
  deps.publishTaskUpdate()

  // Plan C plugin-hook chain: beforeFinalize. Same contract as the HTTP
  // branch — eligible plugins can request a different finalPath; aborted
  // chains skip the rename and mark Error.
  const finalizeOutcome = await runBeforeFinalize(task, deps)
  if (finalizeOutcome.aborted) {
    const cause = finalizeOutcome.reason
    await failFinalize(task, deps, {
      errorMessage: `plugin chain aborted: ${cause}`,
      errorDetailKey: 'task.error.detail.pluginChainAborted',
      errorDetailParams: { cause },
      hookCode: 'PLUGIN_RUNTIME_FAULT',
    })
    return
  }
  const desiredFinalPath = finalizeOutcome.finalFilePath ?? task.finalPath
  await persistDesiredFinalPath(task, desiredFinalPath, deps)
  const storageLayout = getBtStorageLayout(task)
  const stagingPayloadPath = getBtPayloadPath(task)
  const renameSource = stagingPayloadPath ?? task.diskPath

  // Settle the retiring gid's contribution INTO the baseline before we
  // forceRemove it. Two reasons:
  //   1. once forceRemove fires, the runtime row is gone and uploadLength
  //      is no longer queryable;
  //   2. the new gid that addTorrent returns will start its own
  //      uploadLength at 0, so without an updated baseline the next
  //      polling tick would clobber the prior session's bytes via
  //      `mergeEngineTask` (uploadedBytes = baseline + currentGidUpload).
  // Note: do NOT touch `task.uploadedBytes` directly with `+= upload`
  // here — `task.uploadedBytes` is already the live display value
  // (baseline + oldGid.uploadLength) so adding `upload` again would
  // double-count. Sync it from the new baseline instead; the new gid
  // contributes 0 at this point.
  const upload = await deps.adapter.getUploadLength(task.engineTaskId)
  task.uploadedBytesBaseline += upload
  task.uploadedBytes = task.uploadedBytesBaseline
  await persistTaskState(task, deps)

  // Snapshot unselected files BEFORE forceRemove. aria2 drops the
  // RequestGroup once forceRemove fires, so `getTaskFiles` would return
  // empty (or throw) afterwards. We use this snapshot post-rename to
  // belt-and-braces clean any unselected files that aria2's own
  // `--bt-remove-unselected-file=true` cleanup may have raced past
  // (cleanup can run on a later event-loop tick than forceRemove
  // returns; if rename happens in between, aria2 looks at the old
  // staging location and silent-skips). All paths are absolute, rooted at the
  // actual payload path; we relativize so we can re-apply under finalPath.
  const unselectedRelPaths = await snapshotUnselectedRelPaths(
    task,
    deps,
    renameSource
  )

  // Stop the active seeding task BEFORE rename + re-add. `removeDownloadResult`
  // alone is insufficient: it only clears tasks already in stopped/error/
  // removed state, so an active seeder would survive in aria2 and reappear
  // as an orphan task on the next polling tick. forceRemove also releases
  // file handles, making the rename safe on Windows (sharing-violation safe).
  try {
    await deps.adapter.forceRemoveTask(task.engineTaskId)
  } catch (err) {
    deps.log.warn(
      { err, taskId: task.id, gid: task.engineTaskId },
      'finalize_bt_force_remove_failed'
    )
  }
  await deps.adapter.removeDownloadResult(task.engineTaskId)

  try {
    await deps.fs.renameAtomic(renameSource, desiredFinalPath)
  } catch (e) {
    const cause = (e as Error).message
    const errorMessage = `Failed to rename directory: ${cause}`
    await failFinalize(task, deps, {
      errorMessage,
      errorDetailKey: 'task.error.detail.renameDirFailed',
      errorDetailParams: { cause },
      hookCode: 'TASK_FINALIZE_RENAME_FAILED',
    })
    throw new AppError(ErrorCode.TaskFinalizeRenameFailed, errorMessage, e)
  }
  const completedAt = Date.now()

  if (storageLayout) {
    try {
      deps.rebaseTaskFilePaths?.(task.id, renameSource, desiredFinalPath)
    } catch (err) {
      deps.log.warn(
        { err, taskId: task.id },
        'finalize_bt_task_file_path_rebase_failed'
      )
    }
    if (!isSameOrDescendant(desiredFinalPath, storageLayout.workspacePath)) {
      try {
        await deps.fs.removePathRecursive(storageLayout.workspacePath)
      } catch (err) {
        deps.log.warn(
          { err, taskId: task.id, workspacePath: storageLayout.workspacePath },
          'finalize_bt_workspace_cleanup_failed'
        )
      }
    }
  }

  // Commit staged metadata now that the rename succeeded. The commit is a
  // sync SQLite tx; the callback is empty because the rename above already
  // happened on disk (we are intentionally outside the tx body for IO).
  try {
    finalizeOutcome.commit(() => {})
  } catch (err) {
    deps.log.warn(
      { taskId: task.id, err: (err as Error).message },
      'finalize_bt_metadata_commit_failed'
    )
  }

  task.finalPath = desiredFinalPath
  task.diskPath = desiredFinalPath
  // Same instance-row sync as finalizeHttp: the on-disk rename just
  // happened, so the instance rows must stop pointing at the `.motrix`
  // container or restore() resurrects it after a restart. Status is
  // left alone here — the task still heads into reseed and its
  // terminal state (Seeding/Completed) is decided below.
  for (const inst of task.instances) {
    inst.diskPath = desiredFinalPath
  }
  setTaskTransitionPhase(task, TransitionPhase.Reseeding)
  deps.activityRecorder.recordDownloadCompleted({
    taskId: task.id,
    occurredAt: completedAt,
  })
  await persistTaskState(task, deps)

  await finalizeBtAfterRename(task, deps, completedAt, unselectedRelPaths)
}

async function finalizeBtAfterRename(
  task: DownloadTask,
  deps: FinalizeTaskDeps,
  completedAt: number,
  unselectedRelPaths: string[]
): Promise<void> {
  // Belt-and-braces cleanup: drop any unselected files that survived
  // the rename. removePathRecursive is idempotent (ignores ENOENT) so
  // overlap with aria2's own cleanup is harmless — whichever ran first
  // wins, and the loser becomes a noop. Failures are logged but never
  // fail the finalize: the user's selected files are intact and
  // usable, partial leftovers are a hygiene issue, not data loss.
  await cleanupUnselectedAfterRename(task, unselectedRelPaths, deps)

  // Compute what the new gid still needs to seed. aria2's `seed-ratio`
  // is per-gid (`uploadLength / completedLength`); the new gid's
  // completedLength will be ~totalBytes immediately (file is on disk
  // and `bt-seed-unverified` skips check), while uploadLength starts
  // at 0. Without subtracting the prior sessions' contribution from
  // the user's target ratio, the new gid would seed up to a *fresh*
  // settings.seedRatio on top of what was already uploaded — pushing
  // the task's lifetime ratio to roughly `priorRatio + settings.ratio`.
  const { bt } = deps.settings.get()
  const alreadyRatio =
    task.totalBytes > 0 ? task.uploadedBytesBaseline / task.totalBytes : 0
  const remainingRatio =
    bt.seedRatio > 0 ? Math.max(0, bt.seedRatio - alreadyRatio) : 0
  const ratioRequested = bt.seedRatio > 0
  const ratioSatisfied = ratioRequested && remainingRatio === 0
  const timeRequested = bt.seedTime > 0

  // Nothing left to seed: skip the reseed entirely. The file is already
  // on disk at finalPath; we just enter Completed. Avoids spinning up
  // a new aria2 row that would be torn down on its first poll.
  const shouldSkipReseed =
    (!ratioRequested && !timeRequested) || (ratioSatisfied && !timeRequested)
  if (shouldSkipReseed) {
    setTaskTransitionPhase(task, TransitionPhase.Idle)
    const previousStatus = task.status
    applyTerminalStatusToTask(task, TaskStatus.Completed, {}, completedAt)
    syncCompletionMetrics(task)
    await persistTaskTransition(task, previousStatus, deps, completedAt)
    deps.publishTaskUpdateNow()
    deps.log.info(
      {
        taskId: task.id,
        alreadyRatio,
        targetRatio: bt.seedRatio,
        seedTime: bt.seedTime,
      },
      'finalize_bt_reseed_skipped'
    )
    fireAfterComplete(deps, task, 'finalize')
    return
  }

  // When the user requested a ratio but it's already met (and time is
  // still pending), tell aria2 to ignore ratio for this gid so only
  // seed-time governs the stop condition. `seed-ratio=0.0` is aria2's
  // documented "ignore ratio" sentinel.
  const seedRatioForNewGid = ratioRequested ? remainingRatio : 0

  // Known issue: aria2 treats `seed-time=0` as "don't seed at all",
  // not "seed forever". If the user has time=0 and is here because of
  // a ratio-only request, the new gid will terminate immediately on
  // aria2's side. Surfacing rather than papering over until the
  // seed-time semantic translation lands (next iteration).
  if (!timeRequested && ratioRequested && !ratioSatisfied) {
    deps.log.warn(
      {
        taskId: task.id,
        seedRatio: bt.seedRatio,
        seedTime: bt.seedTime,
        remainingRatio,
      },
      'finalize_bt_ratio_only_with_zero_seed_time'
    )
  }

  const completeWithoutSeeding = async (error: unknown): Promise<void> => {
    // Soft degradation: download succeeded; seeding didn't start.
    // Mark Completed with a warning rather than Error — the user's
    // file is intact and usable.
    setTaskTransitionPhase(task, TransitionPhase.Idle)
    const reason = (error as Error).message
    const errorMessage =
      error instanceof AppError &&
      error.code === ErrorCode.TaskFinalizeMetaMissing
        ? `Torrent metadata missing, seeding not started: ${reason}`
        : `Download complete, but seeding failed to start: ${reason}`
    const previousStatus = task.status
    applyTerminalStatusToTask(
      task,
      TaskStatus.Completed,
      { errorMessage },
      completedAt
    )
    syncCompletionMetrics(task)
    await persistTaskTransition(task, previousStatus, deps, completedAt)
    deps.publishTaskUpdateNow()
    deps.log.warn(
      { taskId: task.id, err: reason },
      'finalize_bt_seeding_skipped'
    )
    // Soft-Completed path: the file is on disk and usable, but seeding
    // failed to start. Spec §10: afterComplete still fires because the
    // task ended in TaskStatus.Completed. The errorMessage is informational.
    fireAfterComplete(deps, task, 'finalize')
  }

  let bytes: Uint8Array
  try {
    bytes = await readTorrentMeta(task, deps)
  } catch (error) {
    await completeWithoutSeeding(error)
    return
  }

  const newGid = newEngineTaskId(deps.createEngineTaskId, 'finalizeTask')
  const previousStatus = task.status
  const reseedCandidate = structuredClone(task)
  reseedCandidate.engineTaskId = newGid
  setTaskTransitionPhase(reseedCandidate, TransitionPhase.Idle)
  Object.assign(
    reseedCandidate,
    applyTerminalTransition(reseedCandidate, TaskStatus.Seeding)
  )
  syncPrimaryInstanceIdentity(reseedCandidate)
  syncCompletionMetrics(reseedCandidate)

  deps.taskManager.reserveEngineTaskId(newGid)
  try {
    await deps.taskManager.persist(reseedCandidate)
  } catch (error) {
    deps.taskManager.releaseEngineTaskIdReservation(newGid)
    throw error
  }
  // Keep the durable intent visible to autosave while the reservation shield
  // prevents a concurrent poll from observing a half-committed reseed.
  deps.taskManager.setReservedEngineTaskOwner(
    reseedCandidate.id,
    structuredClone(reseedCandidate),
    newGid
  )

  const selectedFiles = task.bt?.selectedFiles?.length
    ? task.bt.selectedFiles.map((index) => index + 1)
    : undefined
  try {
    const storageLayout = getBtStorageLayout(task)
    const parsedLayout = storageLayout ? await parseBtFileLayout(bytes) : null
    const actualGid = await deps.adapter.addTorrent({
      metadata: bytes,
      // aria2 lays files out at `<dir>/<info.name>/...` (multi-file) or
      // `<dir>/<info.name>` (single-file). The original task wrote into
      // `<saveDir>/<finalName>.motrix/...`; after rename those files live
      // under `<finalPath>/...`. Pointing aria2 at `task.finalPath` makes
      // its `<dir>/<info.name>` lookup hit the existing on-disk layout.
      saveDir: storageLayout ? path.dirname(task.finalPath) : task.finalPath,
      outputFilePaths:
        storageLayout && parsedLayout
          ? buildFinalOutputFilePaths(
              parsedLayout,
              task.finalPath,
              storageLayout
            )
          : undefined,
      selectedFiles,
      seedTime: bt.seedTime,
      seedRatio: seedRatioForNewGid,
      btSeedUnverified: true,
      pause: false,
      isPrivate: task.bt?.isPrivate ?? false,
      gid: newGid,
    })
    if (actualGid.toLowerCase() !== newGid.toLowerCase()) {
      throw new Error(
        `Engine returned gid ${actualGid} instead of reserved gid ${newGid}`
      )
    }
  } catch (error) {
    try {
      await deps.adapter.forceRemoveTask(newGid)
    } catch (cleanupError) {
      deps.log.warn(
        { err: cleanupError, taskId: task.id, gid: newGid },
        'finalize_bt_reseed_force_remove_failed'
      )
    }

    let cleanupConfirmed = false
    try {
      await deps.adapter.removeDownloadResult(newGid)
      cleanupConfirmed = true
    } catch (cleanupError) {
      deps.log.error(
        { err: cleanupError, taskId: task.id, gid: newGid },
        'finalize_bt_reseed_result_cleanup_failed'
      )
    }

    if (cleanupConfirmed) {
      try {
        await completeWithoutSeeding(error)
        deps.taskManager.retireEngineTaskIdReservation(newGid)
        return
      } catch (completionError) {
        // The pre-add durable reseed intent remains recoverable. Promote its
        // owner before surfacing persistence failure so no reservation leaks.
        deps.taskManager.set(
          reseedCandidate.id,
          structuredClone(reseedCandidate)
        )
        deps.publishTaskUpdateNow()
        throw completionError
      }
    }

    // Add outcome and cleanup are both uncertain. Claim the durable candidate
    // under the same public ID, record a recovered transition, and retain it
    // for authoritative polling/restart recovery.
    deps.taskManager.set(reseedCandidate.id, structuredClone(reseedCandidate))
    await recordTaskTransition(
      reseedCandidate,
      previousStatus,
      deps,
      completedAt,
      TaskActivityAccuracy.Recovered
    )
    deps.publishTaskUpdateNow()
    throw error
  }

  // The active candidate was durable before dispatch. Ordinary set claims the
  // reservation synchronously; no post-add persistence gap remains.
  deps.taskManager.set(reseedCandidate.id, structuredClone(reseedCandidate))
  await recordTaskTransition(reseedCandidate, previousStatus, deps)

  deps.publishTaskUpdate()
  deps.log.info(
    { taskId: task.id, newGid, seedRatio: seedRatioForNewGid },
    'finalize_bt_completed'
  )
  // Seeding != Completed — afterComplete fires only when the task ends in
  // TaskStatus.Completed (see spec §10). For BT, that transition happens
  // later via stopSeedingTask or aria2's natural seed-time/ratio eviction.
}

/**
 * The shared "finalize failed" terminal sequence: mark the detached
 * candidate Error, sync its instance rows, commit through the
 * occurrence-aware transition path, notify, and fire the onError hook
 * chain. Call sites keep their own epilogue (return vs `throw new
 * AppError`). The TaskUpdated emit is unconditional: polling has no
 * tellStopped path and the desktop shell's poll-tick emit is gated on
 * active/waiting deltas, so a finalize-failure Error published without
 * an emit stays invisible to the renderer indefinitely.
 */
async function failFinalize(
  task: DownloadTask,
  deps: FinalizeTaskDeps,
  fail: {
    errorMessage: string
    errorDetailKey: string
    errorDetailParams: Record<string, string>
    hookCode: string
  }
): Promise<void> {
  const previousStatus = task.status
  applyTerminalStatusToTask(task, TaskStatus.Error, {
    errorMessage: fail.errorMessage,
    errorDetailKey: fail.errorDetailKey,
    errorDetailParams: fail.errorDetailParams,
  })
  await persistTaskTransition(task, previousStatus, deps)
  deps.publishTaskUpdateNow()
  fireOnError(
    deps,
    task,
    { code: fail.hookCode, message: fail.errorMessage },
    'finalize'
  )
}

async function persistTaskTransition(
  task: DownloadTask,
  previousStatus: TaskStatus,
  deps: FinalizeTaskDeps,
  occurredAt = Date.now()
): Promise<void> {
  // finalize works on a detached candidate, so normalize before the durable
  // barrier and publication. In particular, HTTP completion must not clone
  // the final polling sample's ETA/speeds/connections into Completed.
  normalizeTerminalRuntimeMetrics(task)

  // cause: 'finalize' — every status change this function commits is part
  // of the finalize pipeline (rename, plugin-chain abort, reseed-skip
  // completion, soft-completed-without-seeding).
  await commitTerminalTaskTransition(task, previousStatus, deps, {
    cause: 'finalize',
    callerName: 'persistTaskTransition',
    recordFailureMessage: FINALIZE_RECORD_FAILURE_MESSAGE,
    accuracy: TaskActivityAccuracy.Exact,
    occurredAt,
    persistPlain: (t) => persistTaskState(t, deps),
  })
}

const FINALIZE_RECORD_FAILURE_MESSAGE =
  'finalize Activity transition recording failed'

async function recordTaskTransition(
  task: DownloadTask,
  previousStatus: TaskStatus,
  deps: FinalizeTaskDeps,
  occurredAt = Date.now(),
  accuracy: TaskActivityAccuracy = TaskActivityAccuracy.Exact
): Promise<void> {
  await recordTaskTransitionOrWarn(task, previousStatus, deps, {
    occurredAt,
    accuracy,
    failureMessage: FINALIZE_RECORD_FAILURE_MESSAGE,
  })
}

async function readTorrentMeta(
  task: DownloadTask,
  deps: FinalizeTaskDeps
): Promise<Uint8Array> {
  if (!task.torrentMetaPath) {
    throw new AppError(
      ErrorCode.TaskFinalizeMetaMissing,
      'Torrent metadata path not set'
    )
  }
  try {
    return await deps.torrentMetaStore.read(task.torrentMetaPath)
  } catch (e) {
    throw new AppError(
      ErrorCode.TaskFinalizeMetaMissing,
      `Torrent metadata is missing at ${task.torrentMetaPath}`,
      e
    )
  }
}

async function persistDesiredFinalPath(
  task: DownloadTask,
  desiredFinalPath: string,
  deps: FinalizeTaskDeps
): Promise<void> {
  if (desiredFinalPath === task.finalPath) return
  task.finalPath = desiredFinalPath
  await persistTaskState(task, deps)
}

async function persistTaskState(
  task: DownloadTask,
  deps: FinalizeTaskDeps
): Promise<void> {
  await deps.taskManager.persist(task)
  // Keep the working candidate detached from TaskManager: finalize has
  // multiple awaited phases, and mutating a published object would leak a
  // pre-durable status/path into readers when a later barrier rejects.
  deps.taskManager.set(task.id, structuredClone(task))
}

/**
 * Capture relative paths of unselected files while the gid is still alive.
 * Returns paths relative to the supplied source root so the caller can
 * re-rebase them under `task.finalPath` after rename. Empty result for tasks that
 * downloaded all files (no select-file used) — `getTaskFiles` reports
 * every file as `selected: true` in that case.
 *
 * Failures are swallowed: a missing snapshot just means our cleanup is
 * skipped and we fall back to aria2's own `--bt-remove-unselected-file`
 * behavior. Never blocks finalize.
 */
async function snapshotUnselectedRelPaths(
  task: DownloadTask,
  deps: FinalizeTaskDeps,
  sourceRoot = task.diskPath
): Promise<string[]> {
  try {
    const files = await deps.adapter.getTaskFiles(task.engineTaskId)
    const unselected: string[] = []
    for (const f of files) {
      if (f.selected) continue
      // aria2 reports absolute paths under the task's `dir`. Relativize
      // so the caller can apply the same rel-path under finalPath.
      const rel = path.relative(sourceRoot, f.path)
      // Defensive: if aria2 ever returns a path outside diskPath
      // (shouldn't, but escape '..' would let us walk into the user's
      // filesystem), skip it.
      if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) {
        deps.log.warn(
          { taskId: task.id, filePath: f.path, diskPath: sourceRoot },
          'finalize_bt_unselected_path_outside_disk_path'
        )
        continue
      }
      unselected.push(rel)
    }
    return unselected
  } catch (err) {
    deps.log.warn(
      { err, taskId: task.id, gid: task.engineTaskId },
      'finalize_bt_unselected_snapshot_failed'
    )
    return []
  }
}

function isSameOrDescendant(candidate: string, parent: string): boolean {
  const relative = path.relative(parent, candidate)
  return (
    relative === '' ||
    (!relative.startsWith('..') && !path.isAbsolute(relative))
  )
}

/**
 * Remove unselected files under finalPath. Idempotent — overlapping
 * with aria2's own cleanup is fine. Errors are logged but never
 * thrown: cleanup is hygiene, not correctness, and the user's
 * selected files are already safe at finalPath.
 */
async function cleanupUnselectedAfterRename(
  task: DownloadTask,
  relPaths: string[],
  deps: FinalizeTaskDeps
): Promise<void> {
  let removed = 0
  for (const rel of relPaths) {
    if (rel === '' || rel === '.') continue
    const target = path.join(task.finalPath, rel)
    try {
      await deps.fs.removePathRecursive(target)
      removed += 1
    } catch (err) {
      deps.log.warn(
        { err, taskId: task.id, target },
        'finalize_bt_unselected_remove_failed'
      )
    }
  }
  if (relPaths.length > 0) {
    deps.log.info(
      { taskId: task.id, requested: relPaths.length, removed },
      'finalize_bt_unselected_cleanup_done'
    )
  }
}

// ─── Plan C plugin-hook helpers (T15) ─────────────────────────

interface BeforeFinalizeOutcomeAborted {
  aborted: true
  reason: string
}

interface BeforeFinalizeOutcomeCommit {
  aborted: false
  finalFilePath?: string
  /**
   * Runs the staged metadata commit (if a db handle is wired) wrapping the
   * supplied sync callback inside the same SQLite transaction. When no db
   * handle is wired, behaves as a passthrough: the callback runs and the
   * (empty) staged store is silently discarded.
   */
  commit: (cb: () => void) => void
}

type BeforeFinalizeOutcome =
  | BeforeFinalizeOutcomeAborted
  | BeforeFinalizeOutcomeCommit

const NOOP_COMMIT_OUTCOME: BeforeFinalizeOutcomeCommit = {
  aborted: false,
  commit: (cb) => cb(),
}

/**
 * Runs the beforeFinalize chain when the orchestrator is wired. Returns a
 * commit thunk so the caller (finalizeHttp / finalizeBt) decides exactly
 * where staged metadata flushes relative to the rename — keeping the
 * SQLite transaction's tx body synchronous.
 */
async function runBeforeFinalize(
  task: DownloadTask,
  deps: FinalizeTaskDeps
): Promise<BeforeFinalizeOutcome> {
  if (!deps.orchestrator) return NOOP_COMMIT_OUTCOME
  const ctxDto: BeforeFinalizeContextDTO = {
    sourceUrl: task.uris?.[0] ?? '',
    createdBy: 'user',
    requestedAt: task.createdAt ?? Date.now(),
    task,
    filePath: task.finalPath,
  }
  const result = await deps.orchestrator.runBeforeFinalize(ctxDto, task.id)
  if (result.aborted) {
    await deps.auditLog?.log({
      type: 'chain.abort',
      hook: 'beforeFinalize',
      taskId: task.id,
      reason: result.reason,
    })
    return { aborted: true, reason: result.reason }
  }
  await deps.auditLog?.log({
    type: 'chain.commit',
    hook: 'beforeFinalize',
    taskId: task.id,
    finalFilePath: result.final.filePath,
  })
  const db = deps.db
  const staged = result.staged
  return {
    aborted: false,
    finalFilePath: result.finalFilePath,
    commit: (cb: () => void) => {
      if (db) {
        staged.commitMetadata(db, task.id, cb)
      } else {
        cb()
      }
    },
  }
}
