import type { MediaProgressSnapshot } from '@shared/schemas/media-progress'

export function makeMediaProgress(
  overrides: Partial<MediaProgressSnapshot> = {}
): MediaProgressSnapshot {
  return {
    version: 1,
    phase: 'downloading',
    download: {
      progress: 0.001,
      completedParts: 1,
      totalParts: 1000,
      totalBytes: null,
    },
    muxProgress: null,
    outputBytes: null,
    ...overrides,
  }
}
