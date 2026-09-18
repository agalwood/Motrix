import type { MediaPhase } from '../schemas/media-progress'
import { type DownloadTask, TaskKind, TaskStatus } from '../types/task'

export const MEDIA_PHASE_LABELS: Record<MediaPhase, string> = {
  preparing: 'panel.downloads.media.preparing',
  downloading: 'panel.downloads.status.downloading',
  decrypting: 'panel.downloads.media.decrypting',
  assembling: 'panel.downloads.media.assembling',
  muxing: 'panel.downloads.media.muxing',
  renaming: 'panel.downloads.media.renaming',
}

export function isMediaTask(task: Pick<DownloadTask, 'kind'>): boolean {
  return task.kind === TaskKind.Hls || task.kind === TaskKind.Mux
}

export function finiteProgress(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0
}

/** A byte-complete transfer still needs a successful completion event. */
export function segmentFraction(
  downloaded: number,
  total: number,
  completed: boolean
): number {
  if (completed) return 1
  return Number.isFinite(total) && total > 0
    ? Math.min(0.9999, finiteProgress(downloaded / total))
    : 0
}

export function mediaProgressPercent(progress: number): number {
  const value = finiteProgress(progress)
  return value >= 1 ? 100 : Math.min(99.9, Math.round(value * 1000) / 10)
}

/** Transfer progress, never a mixture of transfer and mux percentages. */
export function getDownloadProgress(task: DownloadTask): number | null {
  if (
    task.status === TaskStatus.Completed ||
    task.status === TaskStatus.Seeding
  )
    return 1
  return isMediaTask(task)
    ? (task.mediaProgress?.download.progress ?? null)
    : finiteProgress(task.progress)
}

export function getStageProgress(task: DownloadTask): number | null {
  if (!isMediaTask(task) || !getMediaPhaseLabel(task))
    return getDownloadProgress(task)
  const media = task.mediaProgress
  if (media?.phase === 'downloading') return media.download.progress
  if (media?.phase === 'muxing') return media.muxProgress
  return null
}

export function isMediaProcessing(task: DownloadTask): boolean {
  return (
    isMediaTask(task) &&
    (task.status === TaskStatus.Downloading ||
      task.status === TaskStatus.Finalizing) &&
    task.mediaProgress !== undefined &&
    !['preparing', 'downloading'].includes(task.mediaProgress.phase)
  )
}

export function getMediaPhaseLabel(task: DownloadTask): string | null {
  return isMediaTask(task) &&
    task.mediaProgress &&
    (task.status === TaskStatus.Downloading ||
      task.status === TaskStatus.Finalizing ||
      task.status === TaskStatus.Queued)
    ? MEDIA_PHASE_LABELS[task.mediaProgress.phase]
    : null
}

export function getOutputSize(task: DownloadTask): number | null {
  if (!isMediaTask(task)) return task.sizeWhenDone
  // Legacy sizeWhenDone held summed input bytes, not the published file size.
  return task.mediaProgress?.outputBytes ?? null
}

const PHASE_ORDER: Record<MediaPhase, number> = {
  preparing: 0,
  downloading: 1,
  decrypting: 2,
  assembling: 3,
  muxing: 4,
  renaming: 5,
}

export function getProgressSortValue(task: DownloadTask): number | null {
  if (
    task.status === TaskStatus.Completed ||
    task.status === TaskStatus.Seeding
  )
    return 12
  if (task.status === TaskStatus.Finalizing) return 10
  if (isMediaTask(task)) {
    const media = task.mediaProgress
    if (!media) return null
    const progress =
      media.phase === 'muxing'
        ? media.muxProgress
        : media.phase === 'downloading'
          ? media.download.progress
          : null
    return PHASE_ORDER[media.phase] * 2 + (progress ?? 0)
  }
  const queued =
    task.status === TaskStatus.Queued ||
    task.status === TaskStatus.FetchingMetadata ||
    task.status === TaskStatus.MetadataReady
  return (queued ? 0 : 2) + finiteProgress(task.progress)
}

/** Wire and renderer transfer estimates share the same unknown semantics. */
export function getTransferMetrics(task: DownloadTask): {
  bytesTotal: number | null
  speedBps: number
  etaSec: number | null
} {
  const media = isMediaTask(task)
  const bytesTotal = media
    ? (task.mediaProgress?.download.totalBytes ?? null)
    : task.totalBytes > 0
      ? task.totalBytes
      : null
  const transferring =
    !media ||
    (task.status === TaskStatus.Downloading &&
      task.mediaProgress?.phase === 'downloading')
  const speedBps =
    transferring && Number.isFinite(task.downloadSpeed)
      ? Math.max(0, task.downloadSpeed)
      : 0
  const etaSec =
    transferring &&
    (!media || (bytesTotal !== null && speedBps > 0)) &&
    Number.isFinite(task.etaSeconds) &&
    task.etaSeconds > 0
      ? task.etaSeconds
      : null
  return { bytesTotal, speedBps, etaSec }
}
