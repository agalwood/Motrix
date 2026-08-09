import type { MdxpTask, MdxpTaskStatus, MdxpTaskType } from '@motrix/mdxp'
import type { DownloadTask } from '@shared/types/task'
import { TaskStatus, TaskType } from '@shared/types/task'

/**
 * Pure projection of the host-domain `DownloadTask` onto the public
 * `MdxpTask` DTO. This is the ONE place the ~40-field domain model narrows to
 * the 16-field public wire shape; keep it consistent with `ProgressPublisher`
 * (the other domain→MDXP translator) — both treat a `0` total/eta as "unknown"
 * (`null`), not a literal zero.
 *
 * Field selection is deliberate: the public `id` is exposed, never the volatile
 * engine gid; `error`/`finalPath` are status-conditional projections (surfaced
 * only in the state where they are meaningful) rather than blind copies.
 */
export function toMdxpTask(task: DownloadTask): MdxpTask {
  return {
    id: task.id,
    type: TASK_TYPE_MAP[task.type],
    name: task.name,
    status: toMdxpTaskStatus(task.status),
    // progress is identity — DownloadTask.progress is already a [0,1] fraction
    progress: task.progress,
    bytesDone: task.downloadedBytes,
    bytesTotal: task.totalBytes > 0 ? task.totalBytes : null,
    speedBps: task.downloadSpeed,
    etaSec: task.etaSeconds > 0 ? task.etaSeconds : null,
    saveDir: task.saveDir,
    // Recovery-path failures (e.g. a startup re-add mismatch) carry no raw
    // engine errorMessage, only an i18n errorDetailKey — fall back to that so
    // `error` stays non-null whenever the task is actually in the Error state.
    error:
      task.status === TaskStatus.Error
        ? (task.errorMessage ?? task.errorDetailKey)
        : null,
    // errorCode is an open set on the wire (consumers MUST tolerate unknown
    // values) — pass the domain code through verbatim, gated the same way as
    // `error` so a stale code from a prior failure never leaks post-recovery.
    errorCode: task.status === TaskStatus.Error ? task.errorCode : null,
    createdAt: task.createdAt,
    finishedAt: task.finishedAt,
    finalPath: task.status === TaskStatus.Completed ? task.finalPath : null,
    infoHash: task.infoHash ?? undefined,
    bt: task.bt
      ? {
          peers: task.bt.peers,
          seeds: task.bt.seeds,
          ratio: task.bt.ratio,
          trackers: task.bt.trackers,
        }
      : undefined,
  }
}

/** Domain `TaskType` → public `MdxpTaskType`. Exhaustive: a new TaskType member
 *  is a compile error here, forcing an explicit wire decision. */
const TASK_TYPE_MAP: Record<TaskType, MdxpTaskType> = {
  [TaskType.Http]: 'http',
  [TaskType.Ftp]: 'ftp',
  [TaskType.Bt]: 'bt',
  [TaskType.Magnet]: 'magnet',
  [TaskType.Metalink]: 'metalink',
}

/**
 * Domain `TaskStatus` (10 values) → public `MdxpTaskStatus` (8 values).
 * `metadata_ready` collapses to `queued`; `removed` has no public value —
 * callers MUST filter removed tasks before mapping (this throws defensively).
 */
export function toMdxpTaskStatus(status: TaskStatus): MdxpTaskStatus {
  switch (status) {
    case TaskStatus.Queued:
      return 'queued'
    case TaskStatus.FetchingMetadata:
      return 'fetching_metadata'
    case TaskStatus.MetadataReady:
      return 'queued'
    case TaskStatus.Downloading:
      return 'downloading'
    case TaskStatus.Finalizing:
      return 'finalizing'
    case TaskStatus.Seeding:
      return 'seeding'
    case TaskStatus.Paused:
      return 'paused'
    case TaskStatus.Completed:
      return 'completed'
    case TaskStatus.Error:
      return 'error'
    case TaskStatus.Removed:
      throw new Error(
        'toMdxpTaskStatus: removed has no public status; filter removed tasks before mapping'
      )
    default:
      return assertNever(status)
  }
}

function assertNever(value: never): never {
  throw new Error(`toMdxpTaskStatus: unhandled TaskStatus ${String(value)}`)
}
