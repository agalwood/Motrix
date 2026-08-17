import type { DownloadTask } from '@shared/types/task'
import { TransitionPhase } from '@shared/types/task'
import { applyTerminalTransition } from './apply-terminal-transition'
import { nonZeroMerge } from './non-zero-merge'

/**
 * Pure merge; this module never persists and never builds an occurrence.
 * Its callers (`reconcileTask` -> `commitTaskUpdate` in `actions/shared.ts`)
 * commit the merged result through `commitTaskUpdate`, whose `terminalCause`
 * defaults to `'engine'` when the caller doesn't override it — this IS the
 * "cause: 'engine'" path the plan attributes to this file.
 */
export function mergeEngineTask(
  existing: DownloadTask,
  engineTask: DownloadTask,
  now = Date.now()
): DownloadTask {
  const protected_ = nonZeroMerge(existing, engineTask)
  // progress is a derived value, not an independent field. Recomputing
  // from the already-protected mirror keeps progress consistent with
  // totalBytes/downloadedBytes — and prevents engine zeros from
  // clobbering progress on paused tasks while the byte counts hold.
  const progress =
    protected_.totalBytes > 0
      ? protected_.downloadedBytes / protected_.totalBytes
      : 0
  // uploadedBytes is derived: baseline + current gid's uploadLength.
  // The engine snapshot's `uploadedBytes` is `Number(raw.uploadLength)`
  // (per `translateRawToTask`), i.e. just the current gid's contribution.
  // The persistent baseline lives on `existing` and is bumped only at
  // gid swap points (finalize reseed, restart reAdd) — never here.
  const uploadedBytes =
    existing.uploadedBytesBaseline + engineTask.uploadedBytes
  // A non-idle transition phase means the application owns the lifecycle
  // state until its filesystem + persistence transaction commits. aria2 can
  // report Completed while HTTP finalize is still renaming `.motrix`, or a
  // live row can coexist with a quarantined recovery error. Keep merging
  // metrics, but do not let that engine snapshot publish a status ahead of
  // the application-owned transition.
  const nextStatus =
    existing.transitionPhase !== TransitionPhase.Idle
      ? existing.status
      : protected_.status
  const terminalFields = applyTerminalTransition(
    existing,
    nextStatus,
    {
      finishedAt: protected_.finishedAt,
      errorMessage: protected_.errorMessage,
      errorCode: protected_.errorCode,
    },
    now
  )
  return {
    ...existing,
    ...terminalFields,
    progress,
    totalBytes: protected_.totalBytes,
    sizeWhenDone: protected_.sizeWhenDone,
    downloadedBytes: protected_.downloadedBytes,
    downloadSpeed: protected_.downloadSpeed,
    uploadSpeed: protected_.uploadSpeed,
    etaSeconds: protected_.etaSeconds,
    connections: protected_.connections,
    pieceLength: protected_.pieceLength,
    uploadedBytes,
    uploadedBytesBaseline: existing.uploadedBytesBaseline,
    fileCount: protected_.fileCount,
    infoHash: protected_.infoHash ?? existing.infoHash,
    uris: protected_.uris.length > 0 ? protected_.uris : existing.uris,
    bt: protected_.bt ?? existing.bt,
    updatedAt: now,
  }
}

export function hasEngineTaskDelta(
  before: DownloadTask,
  after: DownloadTask
): boolean {
  return (
    before.status !== after.status ||
    before.progress !== after.progress ||
    before.totalBytes !== after.totalBytes ||
    before.sizeWhenDone !== after.sizeWhenDone ||
    before.downloadedBytes !== after.downloadedBytes ||
    before.downloadSpeed !== after.downloadSpeed ||
    before.uploadSpeed !== after.uploadSpeed ||
    before.etaSeconds !== after.etaSeconds ||
    before.connections !== after.connections ||
    before.pieceLength !== after.pieceLength ||
    before.uploadedBytes !== after.uploadedBytes ||
    before.fileCount !== after.fileCount ||
    before.errorMessage !== after.errorMessage ||
    before.errorCode !== after.errorCode ||
    before.finishedAt !== after.finishedAt ||
    before.infoHash !== after.infoHash ||
    before.bt?.peers !== after.bt?.peers ||
    before.bt?.seeds !== after.bt?.seeds ||
    before.bt?.ratio !== after.bt?.ratio
  )
}
