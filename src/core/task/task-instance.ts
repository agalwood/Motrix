import {
  type DownloadTask,
  type TaskInstance,
  TaskInstancePhase,
  TaskStatus,
  TransitionPhase,
} from '@shared/types/task'
import type { TaskActivityRecorder } from '@shared/types/task-activity'
import {
  applyTerminalTransition,
  type TerminalTransitionInput,
} from './apply-terminal-transition'

/**
 * Every engine gid a task currently owns: each instance's gid plus the
 * aggregate `engineTaskId` (the legacy single-instance handle). The single
 * source of the "which gids belong to this task" rule — TaskManager's index,
 * clear-stopped cleanup, and startup recovery all derive from this.
 */
export function collectTaskGids(task: DownloadTask): Set<string> {
  const gids = new Set<string>()
  for (const inst of task.instances) {
    if (inst.gid) gids.add(inst.gid)
  }
  if (task.engineTaskId) gids.add(task.engineTaskId)
  return gids
}

// Phase priority for choosing the primary instance, highest priority first.
// FfmpegMux > BtDownload > HttpDownload > MagnetMetadataResolution
//          > HlsSegment > HlsSubtitle > HlsAudio
//
// Rationale: the primary instance is the one whose gid and status should
// surface as the task's engineTaskId / aggregate status for
// backward-compatible UI. The final-stage instance (mux for HLS, bt_download
// once metadata resolves) wins so the task status reflects the user-visible
// outcome rather than a transient earlier stage.
const PHASE_PRIORITY: Record<TaskInstancePhase, number> = {
  [TaskInstancePhase.FfmpegMux]: 100,
  [TaskInstancePhase.BtDownload]: 90,
  [TaskInstancePhase.HttpDownload]: 80,
  [TaskInstancePhase.MagnetMetadataResolution]: 70,
  [TaskInstancePhase.HlsSegment]: 50,
  [TaskInstancePhase.HlsSubtitle]: 40,
  [TaskInstancePhase.HlsAudio]: 30,
}

export function pickPrimaryInstance(
  instances: TaskInstance[]
): TaskInstance | null {
  if (instances.length === 0) return null
  if (instances.length === 1) return instances[0]

  let best = instances[0]
  let bestPriority = PHASE_PRIORITY[best.phase] ?? 0
  for (let i = 1; i < instances.length; i += 1) {
    const candidate = instances[i]
    const candidatePriority = PHASE_PRIORITY[candidate.phase] ?? 0
    if (candidatePriority > bestPriority) {
      best = candidate
      bestPriority = candidatePriority
    }
  }
  return best
}

/**
 * Keep the aggregate filesystem transition and its durable instance rows in
 * lockstep. SessionManager persists existing task instances verbatim and
 * restore reconstructs the aggregate transition from an instance row, so
 * changing only DownloadTask.transitionPhase does not create a crash barrier.
 *
 * Multi-instance media tasks share one output rename, therefore every instance
 * carries the same aggregate transition marker. This also makes restore
 * deterministic when multiple instances have identical createdAt values.
 */
export function setTaskTransitionPhase(
  task: DownloadTask,
  transitionPhase: TransitionPhase
): void {
  task.transitionPhase = transitionPhase
  for (const instance of task.instances) {
    instance.transitionPhase = transitionPhase
  }
}

/**
 * Synchronize the durable primary instance identity after a single-instance
 * task changes engine gid or aggregate status (BT reseed/adoption).
 */
export function syncPrimaryInstanceIdentity(task: DownloadTask): void {
  const primary = pickPrimaryInstance(task.instances)
  if (!primary) return
  primary.gid = task.engineTaskId || null
  primary.status = task.status
}

/** Terminal aggregate states apply to every logical instance. */
export function syncTerminalInstanceStatus(
  task: DownloadTask,
  status: TaskStatus.Completed | TaskStatus.Error
): void {
  for (const instance of task.instances) {
    instance.status = status
  }
}

/**
 * Apply a terminal aggregate transition AND mirror it onto every instance
 * row in one step. SessionManager restore rebuilds task state from instance
 * rows, so an aggregate terminal status whose instance rows were left behind
 * resurrects a contradictory state after restart — never split this pairing
 * across call sites.
 */
export function applyTerminalStatusToTask(
  task: DownloadTask,
  status: TaskStatus.Completed | TaskStatus.Error,
  incoming: TerminalTransitionInput = {},
  now = Date.now()
): void {
  Object.assign(task, applyTerminalTransition(task, status, incoming, now))
  syncTerminalInstanceStatus(task, status)
}

/**
 * The shared "task is complete after a successful rename" sequence used by
 * the HTTP finalize path, media mux completion, and rename recovery.
 *
 * diskPath is rewritten on every instance too — restore() rebuilds a
 * Completed task's diskPath from the primary instance row, so a stale
 * instance path would resurrect the now-nonexistent placeholder after an
 * app restart, breaking reveal-in-folder and delete-with-files.
 */
export function completeTaskAfterRename(
  task: DownloadTask,
  finalDiskPath: string,
  completedAt: number,
  activityRecorder: TaskActivityRecorder
): void {
  task.diskPath = finalDiskPath
  setTaskTransitionPhase(task, TransitionPhase.Idle)
  syncTerminalInstanceStatus(task, TaskStatus.Completed)
  for (const instance of task.instances) {
    instance.diskPath = finalDiskPath
  }
  activityRecorder.recordDownloadCompleted({
    taskId: task.id,
    occurredAt: completedAt,
  })
  Object.assign(
    task,
    applyTerminalTransition(task, TaskStatus.Completed, {}, completedAt)
  )
}
