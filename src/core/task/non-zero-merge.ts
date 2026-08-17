import type { DownloadTask } from '@shared/types/task'

// `uploadedBytes` is intentionally absent: it is a derived value
// (`uploadedBytesBaseline + currentGidUploadLength`) recomputed in
// `mergeEngineTask`, not a mirror field. The zero-protection invariant
// here only applies to fields that aria2 can transiently report as 0
// while the underlying value is non-zero.
const MIRROR_FIELDS = [
  'totalBytes',
  'downloadedBytes',
  'sizeWhenDone',
  'fileCount',
  'pieceLength',
] as const satisfies ReadonlyArray<keyof DownloadTask>

/**
 * Merge an incoming engine snapshot into existing in-memory task state,
 * preserving the mirror fields when the engine reports zero against
 * an existing non-zero value. This is the I-2 invariant: zero never
 * overwrites non-zero (root-cause fix for aria2_motrix paused-state collapse).
 */
export function nonZeroMerge(
  existing: DownloadTask,
  incoming: DownloadTask
): DownloadTask {
  const result = { ...incoming }
  for (const field of MIRROR_FIELDS) {
    if (incoming[field] === 0 && existing[field] !== 0) {
      ;(result as Record<string, unknown>)[field] = existing[field]
    }
  }
  return result
}
