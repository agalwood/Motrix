import type { EngineAdapter } from '@core/engine/engine-adapter'
import type { EventBus } from '@core/events/event-bus'
import type { MotrixDatabase } from '@core/session/motrix-database'
import type { SessionManager } from '@core/session/session-manager'
import type { DownloadTask } from '@shared/types/task'
import { isStoppedTaskStatus } from '@shared/types/task-actions'
import type { Logger } from '../../logger'
import { collectTaskGids } from '../task-instance'
import type { TaskManager } from '../task-manager'

interface Candidate {
  id: string
  gids: readonly string[]
}

export interface ClearStoppedTasksDeps {
  taskManager: Pick<TaskManager, 'getAll' | 'getById' | 'remove'>
  adapter: Pick<EngineAdapter, 'removeDownloadResults'>
  db: Pick<MotrixDatabase, 'deleteTasks'>
  taskPersistence: Pick<SessionManager, 'runExclusivePersistence'>
  eventBus: Pick<EventBus, 'emit'>
  log: Pick<Logger, 'info' | 'warn'>
  /**
   * Immediate TaskUpdated publication (TaskUpdatePublisher.publishNow).
   * This action already coalesces N deletions into its one closing
   * broadcast, so it flushes immediately instead of waiting out the window.
   */
  publishTaskUpdateNow: () => void
  deleteParentTasks?: (
    taskIds: readonly string[],
    deleteParents: () => void | Promise<void>
  ) => Promise<void>
  runTaskMutation?: <T>(
    taskIds: readonly string[],
    operation: () => Promise<T>
  ) => Promise<T>
}

function taskGids(task: DownloadTask): string[] {
  return [...collectTaskGids(task)].sort()
}

function sameGids(left: readonly string[], right: readonly string[]): boolean {
  return (
    left.length === right.length &&
    left.every((gid, index) => gid === right[index])
  )
}

function snapshotCandidates(tasks: readonly DownloadTask[]): Candidate[] {
  return tasks
    .filter((task) => isStoppedTaskStatus(task.status))
    .map((task) => ({ id: task.id, gids: taskGids(task) }))
}

export async function clearStoppedTasks(
  deps: ClearStoppedTasksDeps
): Promise<void> {
  const candidates = snapshotCandidates(deps.taskManager.getAll())
  const cleaned: Candidate[] = []

  // One engine round-trip for every gid of every candidate, flattened in
  // the same per-candidate order the previous serial loop used — multicall
  // executes entries in array order, so per-task GID cleanup stays ordered.
  // A candidate whose cleanup partially succeeded is retained and harmless
  // on retry because explicit not-found is idempotent.
  const flatGids: string[] = []
  const spans = candidates.map((candidate) => {
    const start = flatGids.length
    flatGids.push(...candidate.gids)
    return { candidate, start }
  })

  let settled: PromiseSettledResult<void>[] | null = []
  if (flatGids.length > 0) {
    try {
      settled = await deps.adapter.removeDownloadResults(flatGids)
    } catch (err) {
      // Transport-level failure: nothing was confirmed cleaned, so every
      // candidate is retained — the same outcome the serial loop produced
      // when each individual round-trip failed.
      settled = null
      deps.log.warn({ err }, 'clearStoppedTasks engine cleanup failed')
    }
  }
  if (settled) {
    // Aggregate failures into ONE warning: a chunk-level transport failure
    // surfaces as per-entry rejections for potentially the entire history,
    // and per-candidate logging would turn that into an O(N) log storm
    // (dev-mode logging is a synchronous file write).
    let failedTasks = 0
    let firstFailure: { err: unknown; taskId: string; gid: string } | null =
      null
    for (const { candidate, start } of spans) {
      const failedAt = candidate.gids.findIndex(
        (_gid, index) => settled[start + index]?.status === 'rejected'
      )
      if (failedAt === -1) {
        cleaned.push(candidate)
        continue
      }
      failedTasks += 1
      if (!firstFailure) {
        const entry = settled[start + failedAt]
        firstFailure = {
          err: entry?.status === 'rejected' ? entry.reason : undefined,
          taskId: candidate.id,
          gid: candidate.gids[failedAt],
        }
      }
    }
    if (firstFailure) {
      deps.log.warn(
        { ...firstFailure, failedTasks },
        'clearStoppedTasks engine cleanup failed'
      )
    }
  }

  const deleteCleaned = () =>
    deps.taskPersistence.runExclusivePersistence(async () => {
      const ids = cleaned
        .filter((candidate) => {
          const current = deps.taskManager.getById(candidate.id)
          return (
            current !== undefined &&
            isStoppedTaskStatus(current.status) &&
            sameGids(candidate.gids, taskGids(current))
          )
        })
        .map((candidate) => candidate.id)

      if (ids.length === 0) return 0

      const deleteParents = (): void => {
        deps.db.deleteTasks(ids)
        for (const id of ids) deps.taskManager.remove(id)
      }
      if (deps.deleteParentTasks) {
        await deps.deleteParentTasks(ids, deleteParents)
      } else {
        deleteParents()
      }
      deps.publishTaskUpdateNow()
      return ids.length
    })
  const mutationIds = cleaned.map((candidate) => candidate.id)
  const count = await (deps.runTaskMutation
    ? deps.runTaskMutation(mutationIds, deleteCleaned)
    : deleteCleaned())

  deps.log.info(
    { candidateCount: candidates.length, count },
    'clearStoppedTasks removed terminal tasks'
  )
}
