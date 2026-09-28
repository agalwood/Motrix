import { MediaProgressSchema } from '@shared/schemas/media-progress'
import { TaskKind, TaskStatus } from '@shared/types/task'
import { canPause } from '@shared/types/task-actions'
import { makeMediaProgress } from '@test-utils/media-progress'
import { makeDownloadTask } from '@test-utils/task'
import { describe, expect, it } from 'vitest'
import {
  getDownloadProgress,
  getMediaPhaseLabel,
  getOutputSize,
  getProgressSortValue,
  getStageProgress,
  getTransferMetrics,
  mediaProgressPercent,
  segmentFraction,
} from './media-progress'

describe('media progress projections', () => {
  it('never rounds incomplete work to 100%', () => {
    expect(segmentFraction(100, 100, false)).toBeLessThan(1)
    expect(mediaProgressPercent(0.99999999)).toBe(99.9)
    expect(mediaProgressPercent(0.001)).toBe(0.1)
    expect(segmentFraction(0, 0, true)).toBe(1)
    expect(mediaProgressPercent(1)).toBe(100)
  })
  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])(
    'handles unknown/invalid total %s',
    (total) => {
      expect(segmentFraction(500, total, false)).toBe(0)
    }
  )
  it('treats legacy progress and output size as unknown', () => {
    const task = makeDownloadTask({
      kind: TaskKind.Hls,
      progress: 1,
      totalBytes: 100,
      downloadedBytes: 100,
      sizeWhenDone: 100,
    })
    expect(getDownloadProgress(task)).toBeNull()
    expect(getStageProgress(task)).toBeNull()
    expect(getOutputSize(task)).toBeNull()
    expect(getOutputSize({ ...task, status: TaskStatus.Completed })).toBeNull()
    expect(getTransferMetrics(task)).toEqual({
      bytesTotal: null,
      speedBps: 0,
      etaSec: null,
    })
    expect(getDownloadProgress({ ...task, status: TaskStatus.Completed })).toBe(
      1
    )
  })
  it('keeps mux and download progress separate, and terminal status wins over phase', () => {
    const mediaProgress = makeMediaProgress({
      phase: 'muxing',
      download: {
        progress: 1,
        completedParts: 1000,
        totalParts: 1000,
        totalBytes: 2000,
      },
      muxProgress: 0.4,
    })
    const task = makeDownloadTask({
      kind: TaskKind.Mux,
      mediaProgress,
      downloadSpeed: 500,
      etaSeconds: 3,
    })
    expect(getDownloadProgress(task)).toBe(1)
    expect(getStageProgress(task)).toBe(0.4)
    expect(getTransferMetrics(task)).toEqual({
      bytesTotal: 2000,
      speedBps: 0,
      etaSec: null,
    })
    expect(canPause(task)).toBe(false)
    expect(getMediaPhaseLabel({ ...task, status: TaskStatus.Error })).toBeNull()
    expect(
      getMediaPhaseLabel({ ...task, status: TaskStatus.Paused })
    ).toBeNull()
  })
  it('sorts by stage before local percentages and keeps legacy unknown', () => {
    const downloading = makeDownloadTask({
      kind: TaskKind.Hls,
      mediaProgress: makeMediaProgress(),
    })
    const muxing = {
      ...downloading,
      mediaProgress: makeMediaProgress({ phase: 'muxing', muxProgress: 0 }),
    }
    expect(getProgressSortValue(muxing)).toBeGreaterThan(
      getProgressSortValue(downloading)!
    )
    expect(
      getProgressSortValue({ ...downloading, mediaProgress: undefined })
    ).toBeNull()
    expect(getProgressSortValue({ ...muxing, status: TaskStatus.Error })).toBe(
      getProgressSortValue(muxing)
    )
  })
  it('validates the persisted constant-size summary including exact completed count', () => {
    expect(MediaProgressSchema.safeParse(makeMediaProgress()).success).toBe(
      true
    )
    for (const download of [
      { progress: 1, completedParts: 1, totalParts: 1000, totalBytes: null },
      {
        progress: 0.5,
        completedParts: 1000,
        totalParts: 1000,
        totalBytes: null,
      },
      { progress: 0.5, completedParts: 1, totalParts: 0, totalBytes: null },
      {
        progress: Number.NaN,
        completedParts: 0,
        totalParts: 1,
        totalBytes: null,
      },
    ])
      expect(
        MediaProgressSchema.safeParse(makeMediaProgress({ download })).success
      ).toBe(false)
  })
})
