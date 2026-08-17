import {
  type DownloadTask,
  TaskInstancePhase,
  TaskKind,
  TaskStatus,
  TaskType,
} from './task'

/** Coordinator-managed media task (Mux/Hls) — has no single aria2 handle. */
/**
 * IPC-safe outcome of a plural task command (Commands.PauseTasks, …).
 * `failed[].reason` is a display string — Error objects do not survive the
 * IPC boundary, so shells stringify before returning.
 */
export interface BulkTaskCommandResult {
  succeeded: string[]
  failed: Array<{ taskId: string; reason: string }>
}

export function isMediaKind(kind: TaskKind): boolean {
  return kind === TaskKind.Mux || kind === TaskKind.Hls
}

/** Whether a task has one engine-level piece map that the inspector can show. */
export function canInspectPieces(t: DownloadTask): boolean {
  return t.kind === TaskKind.Direct || isTorrentLike(t)
}

/**
 * Terminal in the occurrence/terminal-metadata sense: the two statuses that
 * carry `finishedAt`/`error*` fields and qualify for a terminal occurrence.
 * Deliberately narrower than {@link isStoppedTaskStatus} — `Removed` is a
 * stopped-but-not-terminal status.
 */
export function isTerminalTaskStatus(
  status: TaskStatus
): status is TaskStatus.Completed | TaskStatus.Error {
  return status === TaskStatus.Completed || status === TaskStatus.Error
}

/**
 * Stopped in the engine-cleanup sense: nothing is (or will be) in flight, so
 * the task is eligible for "clear stopped" style bulk cleanup. Includes
 * `Removed` on top of the terminal statuses.
 */
export function isStoppedTaskStatus(status: TaskStatus): boolean {
  return isTerminalTaskStatus(status) || status === TaskStatus.Removed
}

export function canPause(t: DownloadTask): boolean {
  // A media task keeps status=Downloading through the ffmpeg mux phase, but
  // there are no segment gids to pause once muxing has started — so gate on the
  // mux instance instead of status alone (status alone would leave the Pause
  // button enabled during mux, where every click would fail with no gids).
  if (isMediaKind(t.kind)) {
    const muxStarted = t.instances.some(
      (i) =>
        i.phase === TaskInstancePhase.FfmpegMux &&
        i.status !== TaskStatus.Queued
    )
    return !muxStarted && t.status === TaskStatus.Downloading
  }
  return (
    t.status === TaskStatus.Queued ||
    t.status === TaskStatus.FetchingMetadata ||
    t.status === TaskStatus.Downloading ||
    t.status === TaskStatus.Seeding
  )
}

export function canResume(t: DownloadTask): boolean {
  return t.status === TaskStatus.Paused
}

export function canStopSeeding(t: DownloadTask): boolean {
  return t.status === TaskStatus.Seeding
}

export function canReseed(t: DownloadTask): boolean {
  return (
    t.status === TaskStatus.Completed &&
    isTorrentLikeType(t.type) &&
    t.torrentMetaPath != null
  )
}

export function canRetry(t: DownloadTask): boolean {
  return t.status === TaskStatus.Error || t.status === TaskStatus.Removed
}

export function canRemove(t: DownloadTask): boolean {
  return t.status !== TaskStatus.Finalizing
}

export function isFinalizing(t: DownloadTask): boolean {
  return t.status === TaskStatus.Finalizing
}

export function isTorrentLikeType(type: TaskType): boolean {
  return type === TaskType.Bt || type === TaskType.Magnet
}

export function isTorrentLike(t: DownloadTask): boolean {
  return isTorrentLikeType(t.type)
}

/**
 * Whether a retry/re-add can actually rebuild the engine-side add call from
 * data already on the task record. `canRetry` only looks at status; this
 * checks that the inputs the engine dispatch needs still exist, so a Retry
 * button doesn't lead a task straight into a doomed re-add.
 *
 * Media kinds (Mux/Hls) are coordinator-orchestrated across multiple engine
 * instances with no single re-addable handle, so they're never retryable
 * this way. Torrent-like tasks (BT, and magnet — including pre-metadata
 * magnet, which is torrent-like by type before it ever gets a sidecar) need
 * the persisted .torrent sidecar: with it, `addTorrent` reproduces the
 * original add exactly.
 *
 * Everything else (HTTP/FTP/metalink) is FALSE, even though the uris
 * survive. The rest of the add — request headers, cookies, referer,
 * per-task proxy, the `out` filename — is never persisted; `reAddTask`
 * recovers it only from aria2's still-resident stopped result, which is
 * gone after a restart or once aria2 purges the row. A retry built from
 * the uris alone silently re-downloads with different request semantics:
 * an authenticated download becomes an unauthenticated one, a
 * referer-gated URL 403s. Re-enabling this needs a persisted replay
 * recipe — tracked in the plan's Follow-ups.
 */
export function canRebuildTaskInputs(t: DownloadTask): boolean {
  if (isMediaKind(t.kind)) return false
  if (isTorrentLike(t)) return t.torrentMetaPath != null
  return false
}

/** A retry the UI should actually offer: the task is in a retryable status
 *  AND its engine dispatch can be rebuilt from the persisted record. */
export function canAttemptRetry(t: DownloadTask): boolean {
  return canRetry(t) && canRebuildTaskInputs(t)
}
