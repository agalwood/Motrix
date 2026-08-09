import path from 'node:path'
import { AppError, ErrorCode } from '@shared/errors'
import { Events } from '@shared/protocol/events'
import { TaskInstancePhase, TaskStatus } from '@shared/types/task'
import { isStoppedTaskStatus } from '@shared/types/task-actions'
import type {
  TaskInstanceRow,
  TaskRow,
  TaskWithInstances,
} from '../../session/motrix-database'
import type { SessionManager } from '../../session/session-manager'
import {
  withMagnetCleanupQuarantined,
  withMagnetCleanupTombstoneHidden,
} from '../../torrent/magnet-cleanup-quarantine'
import type { MagnetTracker } from '../../torrent/magnet-tracker'
import type { FileCleanupService } from '../file-cleanup-service'
import type { TorrentMetaStore } from '../torrent-meta-store'
import { getTaskOrWarn, type TaskActionDeps } from './shared'

export interface RemoveTaskOptions {
  deleteWithFiles: boolean
}

export interface RemoveTaskDeps extends TaskActionDeps {
  runTaskMutation: NonNullable<TaskActionDeps['runTaskMutation']>
  taskPersistence: Pick<SessionManager, 'runExclusivePersistence'>
  fileCleanupService: FileCleanupService
  torrentMetaStore: TorrentMetaStore
  // Structural slice of MotrixDatabase. Removal needs `deleteTask` for
  // normal tasks; magnet_metadata_resolution removal also reads via
  // `getTask` and writes the quarantine tombstone via
  // `saveTaskWithInstances`.
  db: {
    deleteTask(motrixId: string): void
    getTask(motrixId: string): TaskWithInstances | null
    saveTaskWithInstances(payload: TaskWithInstances): void
  }
  magnetTracker: MagnetTracker
  /**
   * Tear down a coordinator-managed media task's in-flight run (segment
   * downloaders + ffmpeg + temp dir). Called for a task with no aria2 handle
   * (engineTaskId ''); a no-op once the run has finished. Supplied by the
   * bridge runtime — undefined outside it, in which case media removal falls
   * back to a plain row delete (no engine handle to leak anyway).
   */
  cancelMedia?: (taskId: string) => Promise<void>
}

/**
 * Remove a task from the engine and domain model.
 *
 * - If the task is currently in the `Finalizing` state (rename/re-seed
 *   dance on BT completion) the call is rejected — allowing removal at
 *   that moment would race the finalize worker and can corrupt the
 *   TorrentMetaStore.
 * - When `deleteWithFiles=true`, the on-disk container (data file or
 *   BT container dir) plus any `.aria2` sidecar and torrent metadata
 *   are cleaned up. `FileCleanupService` already knows the sidecar rule;
 *   we delegate cleanup there.
 * - When `deleteWithFiles=false`, files are intentionally preserved and
 *   a toast is emitted so the renderer can surface the orphan path.
 */
export async function removeTask(
  taskId: string,
  options: RemoveTaskOptions,
  deps: RemoveTaskDeps
): Promise<void> {
  const remove = (): Promise<void> =>
    removeTaskUnderMutation(taskId, options, deps)
  await deps.runTaskMutation([taskId], remove)
}

/**
 * The task snapshot and every external side effect must share one admission
 * lock. A late lock around only the durable delete lets reAddTask create and
 * publish a replacement GID while removal still holds the stale original GID,
 * leaving the replacement live in aria2 after the parent row is deleted.
 */
async function removeTaskUnderMutation(
  taskId: string,
  options: RemoveTaskOptions,
  deps: RemoveTaskDeps
): Promise<void> {
  const task = getTaskOrWarn(deps, taskId, 'removeTask')
  if (!task) return

  if (task.status === TaskStatus.Finalizing) {
    throw new AppError(
      ErrorCode.TaskRemoveNotAvailableDuringFinalize,
      'Cannot remove task while it is being finalized'
    )
  }

  // Both removal paths delete the durable parent row under one
  // exclusive-persistence window, with the Inspector Activity deletion
  // barrier (when wired) installed before the row disappears. The barrier
  // ordering is the delicate part — keep it in exactly one place.
  const deleteParentBarrier = (publish: () => void): Promise<void> =>
    deps.taskPersistence.runExclusivePersistence(async () => {
      if (deps.deleteParentTasks) {
        await deps.deleteParentTasks([taskId], publish)
      } else {
        publish()
      }
    })

  // Plan B Task 4: magnet metadata pending removal — delegate cleanup
  // to MagnetTracker which knows about the metadata temp dir and the
  // bounded-retry / quarantine state machine. Only delete the DB row
  // when aria2 confirms the GID is gone (Codex finding #9). Otherwise
  // retain the row + mark Error so MagnetTracker.primeFromDatabase
  // restores the polling shield on the next session (Codex finding
  // #13) without resurrecting the task in the user's view.
  const primary = task.instances?.[0]
  if (primary?.phase === TaskInstancePhase.MagnetMetadataResolution) {
    const result = await deps.magnetTracker.cancel(taskId, {
      // The Activity runtime must install its tombstone before the parent
      // row can disappear. Keep ownership of that delete in this action.
      deleteTaskRow: false,
    })
    const publishRemovalOrQuarantine = (): void => {
      if (result === 'removed') {
        deps.db.deleteTask(taskId)
        deps.taskManager.remove(taskId)
        return
      }

      // 'quarantined' — preserve DB row + explicitly stamp it as Error
      // so SessionManager.restore skips re-adding and
      // MagnetTracker.primeFromDatabase classifies it as quarantined
      // (rather than resuming a normal metadata fetch).
      const pair = deps.db.getTask(taskId)
      if (pair) {
        const now = Date.now()
        const updatedTask: TaskRow = {
          ...pair.task,
          aggStatus: TaskStatus.Error,
          finishedAt: now,
          errorMessage: null,
          errorCode: null,
          errorDetailKey: 'task.error.detail.magnetCleanupQuarantined',
          errorDetailParams: null,
          updatedAt: now,
        }
        const updatedInstances: TaskInstanceRow[] = pair.instances.map((i) =>
          i.phase === TaskInstancePhase.MagnetMetadataResolution
            ? {
                ...i,
                status: TaskStatus.Error,
                payload: withMagnetCleanupTombstoneHidden(
                  withMagnetCleanupQuarantined(i.payload, true),
                  true
                ),
                updatedAt: now,
              }
            : i
        )
        deps.db.saveTaskWithInstances({
          task: updatedTask,
          instances: updatedInstances,
        })
      }
      deps.log.info(
        { taskId },
        'magnet metadata cleanup quarantined; DB tombstone retained + marked Error'
      )
      deps.taskManager.remove(taskId)
      // cancel(deleteTaskRow:false) deliberately leaves Activity/parent
      // deletion ownership in this action. Carry that user-delete intent
      // into MagnetTracker's same-process retry only after the hidden
      // tombstone is durable and the public task is unpublished.
      deps.magnetTracker.markPendingUserDelete(taskId)
    }

    await deleteParentBarrier(publishRemovalOrQuarantine)
    deps.publishTaskUpdate()
    return
  }

  if (task.engineTaskId) {
    let forceRemoveError: unknown
    if (!isStoppedTaskStatus(task.status)) {
      // removeDownloadResult only accepts stopped/error/complete rows. First
      // force active/waiting/paused/seeding work out of those live sets.
      // Aria2Adapter treats only an explicit not-found as idempotent; transport
      // failures propagate so we never delete the sole public owner while its
      // engine GID may still be running.
      try {
        await deps.adapter.forceRemoveTask(task.engineTaskId)
      } catch (err) {
        forceRemoveError = err
      }
    }
    // Purge the stopped result as well. A plain remove leaves a tellStopped row
    // that restore/polling can adopt under a fresh public identity.
    try {
      await deps.adapter.removeDownloadResult(task.engineTaskId)
    } catch (resultError) {
      if (forceRemoveError) {
        deps.log.warn(
          {
            taskId,
            gid: task.engineTaskId,
            forceRemoveError,
            resultError,
          },
          'removeTask: engine absence could not be confirmed'
        )
      }
      throw resultError
    }
    if (forceRemoveError) {
      deps.log.warn(
        { taskId, gid: task.engineTaskId, err: forceRemoveError },
        'removeTask: force-remove failed but stopped-result purge confirmed absence'
      )
    }
  } else {
    // Coordinator-managed media task (no aria2 handle): abort the in-flight
    // run so removing the row does not orphan the SegmentDownloaders + ffmpeg.
    // No-op once the run has finished. Never call adapter.removeTask('').
    await deps.cancelMedia?.(taskId)
  }

  const shouldDeleteFiles =
    options.deleteWithFiles &&
    task.status !== TaskStatus.FetchingMetadata &&
    isSafeCleanupPath(task.diskPath, task.saveDir)

  if (shouldDeleteFiles) {
    await Promise.all([
      deps.fileCleanupService.cleanup(task.diskPath, task.type),
      task.torrentMetaPath
        ? deps.torrentMetaStore.remove(task.torrentMetaPath)
        : Promise.resolve(),
    ])
  } else if (!options.deleteWithFiles) {
    deps.eventBus.emit(Events.ToastShow, {
      key: 'task.remove.orphanToast',
      params: { path: task.diskPath },
    })
  }

  // Delete the persisted sidecar row so SessionManager.restore does not
  // resurrect the task on the next app start. Without this, Pass 2 of
  // restore() walks every db row not consumed by aria2 and adopts each
  // Completed-status row back into TaskManager with its stale gid —
  // making the user's "remove" appear to undo itself after a restart.
  // saveMetadataBatch is an upsert (no negative-set logic), so the next
  // auto-save would NOT clean this up either.
  await deleteParentBarrier(() => {
    deps.db.deleteTask(taskId)
    deps.taskManager.remove(taskId)
  })

  // Publish the removal through the coalescing publisher: the flush-time
  // snapshot no longer contains the deleted id, and handlePolledTasks does
  // not reconcile deletions, so this publication is the one that
  // propagates removal (multi-select remove coalesces to a single emit).
  deps.publishTaskUpdate()
}

function isSafeCleanupPath(diskPath: string, saveDir?: string): boolean {
  if (diskPath.trim() === '' || !path.isAbsolute(diskPath)) return false
  const normalized = path.resolve(diskPath)
  // Never the filesystem root.
  if (normalized === path.parse(normalized).root) return false
  // Never the configured save root itself. A magnet resolved via the
  // pre-fix swap path persisted diskPath == saveDir (the bare ~/Downloads),
  // so deleting "with files" would recursively wipe the user's whole
  // download directory. This guard is the safety net for such poisoned rows
  // that already exist in the DB and cannot be retro-fixed by code alone.
  if (
    saveDir &&
    saveDir.trim() !== '' &&
    normalized === path.resolve(saveDir)
  ) {
    return false
  }
  return true
}
