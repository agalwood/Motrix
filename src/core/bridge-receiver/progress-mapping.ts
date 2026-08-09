import type {
  StatsResult,
  TaskCompletedParams,
  TaskErrorParams,
  TaskProgressParams,
} from '@motrix/mdxp'
import type { GlobalStats } from '@shared/types/stats'
import type { DownloadTask } from '@shared/types/task'
import { TaskStatus } from '@shared/types/task'
import type { BridgeErrorCode } from './errors'

/**
 * Pure, FILTER-FREE `DownloadTask → MDXP notification` mappers, shared by two
 * push paths: `ProgressPublisher` (the per-session extension WS push, which adds
 * its own `source==='bridge'` filter) and the SSE firehose (`GET /mdxp/events`,
 * which streams ALL tasks). Keeping these pure means one source of truth for the
 * wire shape; the source/session filtering lives at the call sites.
 */

/** Domain `TaskStatus` → the lossy 4-value `$/task/progress.phase` enum.
 *  (Distinct from the richer `MdxpTaskStatus` used by `task/get`.) Motrix has no
 *  `muxing` status in v1, so that value is never emitted. */
export function mapStatusToPhase(
  s: TaskStatus
): 'queued' | 'downloading' | 'muxing' | 'finalizing' {
  switch (s) {
    case TaskStatus.Queued:
      return 'queued'
    case TaskStatus.FetchingMetadata:
      // Still pre-download; closest MDXP phase is 'queued'.
      return 'queued'
    case TaskStatus.Downloading:
      return 'downloading'
    case TaskStatus.Paused:
      // MDXP has no 'paused' phase; 'downloading' with speedBps=0 is closest.
      return 'downloading'
    case TaskStatus.Finalizing:
      return 'finalizing'
    case TaskStatus.Seeding:
      // Post-download BT seeding; closest MDXP phase is 'finalizing'.
      return 'finalizing'
    default:
      // Completed/Error/Removed/MetadataReady don't normally reach a progress
      // push; 'finalizing' is the safe fallback.
      return 'finalizing'
  }
}

export function taskToProgressParams(task: DownloadTask): TaskProgressParams {
  return {
    taskId: task.id,
    bytesDone: task.downloadedBytes,
    bytesTotal: task.totalBytes > 0 ? task.totalBytes : null,
    speedBps: task.downloadSpeed,
    etaSec: task.etaSeconds > 0 ? task.etaSeconds : null,
    phase: mapStatusToPhase(task.status),
  }
}

export function taskToCompletedParams(task: DownloadTask): TaskCompletedParams {
  return {
    taskId: task.id,
    filePath: task.finalPath,
    durationMs: (task.finishedAt ?? Date.now()) - task.createdAt,
  }
}

export function taskToErrorParams(
  task: DownloadTask,
  code: BridgeErrorCode,
  message: string
): TaskErrorParams {
  return { taskId: task.id, code, message }
}

/** Classify a failed task into a `BridgeErrorCode` by inspecting its message.
 *  Shared by the WS receiver and the SSE firehose. */
export function classifyError(t: DownloadTask): BridgeErrorCode {
  if (t.status !== TaskStatus.Error) return 'internal-error'
  const msg = (t.errorMessage ?? '').toLowerCase()
  if (msg.includes('not found') || msg.includes('404')) return 'not-found'
  if (msg.includes('401') || msg.includes('403')) return 'auth-expired'
  if (msg.includes('enospc') || msg.includes('no space')) return 'disk-full'
  return 'transient-failure'
}

/** Where `dispatchTaskUpdates` routes each task. The SSE firehose and the
 *  per-session extension WS push supply different sinks (broadcast-all vs.
 *  source-filtered + session-routed); the iteration + terminal dedup is shared. */
export interface TaskNotificationSink {
  onProgress(task: DownloadTask): void
  onCompleted(task: DownloadTask): void
  onError(task: DownloadTask, code: BridgeErrorCode): void
}

/**
 * The one place that turns an `Events.TaskUpdated` array (the FULL task list
 * each poll tick) into per-task notifications. The core bus emits no per-task
 * completed/error events, so terminal transitions are DERIVED from a task's
 * status and deduped via the caller-owned `seen` map. The dedup key is the
 * task's terminal IDENTITY — status + finishedAt, the same triple
 * `terminalOccurrenceId` uses — not its id alone: a re-added task that
 * re-terminates is a NEW occurrence and must notify again even when the
 * coalesced broadcast emitted no frame showing it non-terminal in between.
 * Shared by the SSE firehose and the extension WS push so the dedup logic
 * can't drift.
 */
export function dispatchTaskUpdates(
  tasks: readonly DownloadTask[],
  seen: Map<string, string>,
  sink: TaskNotificationSink
): void {
  const live = new Set<string>()
  for (const task of tasks) {
    live.add(task.id)
    switch (task.status) {
      case TaskStatus.Completed:
      case TaskStatus.Error: {
        const identity = `${task.status}:${task.finishedAt ?? 0}`
        if (seen.get(task.id) !== identity) {
          seen.set(task.id, identity)
          if (task.status === TaskStatus.Completed) {
            sink.onCompleted(task)
          } else {
            sink.onError(task, classifyError(task))
          }
        }
        break
      }
      case TaskStatus.Removed:
        seen.delete(task.id)
        break
      default:
        seen.delete(task.id)
        sink.onProgress(task)
    }
  }
  // `tasks` is the FULL task list each poll tick. removeTask/clearStoppedTasks
  // delete from the TaskManager BEFORE publishing, so a removed task leaves by
  // ABSENCE (no explicit Removed frame). Reap any seen key not in this
  // snapshot, or the map grows without bound across completed→clear churn on a
  // long-running server.
  for (const id of seen.keys()) {
    if (!live.has(id)) seen.delete(id)
  }
}

/** Project the domain `GlobalStats` onto the MDXP `StatsResult` (`$/stats`).
 *  Field-identical today; the explicit reconstruction guards against the domain
 *  type gaining fields that should not cross the wire. */
export function toStatsResult(stats: GlobalStats): StatsResult {
  return {
    totalDownloadSpeed: stats.totalDownloadSpeed,
    totalUploadSpeed: stats.totalUploadSpeed,
    activeTasks: stats.activeTasks,
    waitingTasks: stats.waitingTasks,
    stoppedTasks: stats.stoppedTasks,
  }
}
