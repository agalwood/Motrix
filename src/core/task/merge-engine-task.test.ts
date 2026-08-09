import { DownloadErrorCode } from '@shared/errors'
import type { DownloadTask } from '@shared/types/task'
import { TaskStatus, TransitionPhase } from '@shared/types/task'
import { makeDownloadTask } from '@test-utils/task'
import { describe, expect, it } from 'vitest'
import { mergeEngineTask } from './merge-engine-task'

const baseTask = (over: Partial<DownloadTask> = {}): DownloadTask =>
  makeDownloadTask({ id: 't1', engineTaskId: 'gid1', name: 'a', ...over })

describe('mergeEngineTask', () => {
  it('preserves existing totalBytes when engine reports zero', () => {
    const existing = baseTask({
      totalBytes: 1_000_000,
      downloadedBytes: 500_000,
    })
    const engineTask = baseTask({ totalBytes: 0, downloadedBytes: 0 })
    const merged = mergeEngineTask(existing, engineTask)
    expect(merged.totalBytes).toBe(1_000_000)
    expect(merged.downloadedBytes).toBe(500_000)
  })

  it('derives progress from protected mirror (paused engine reports zero)', () => {
    // Regression: engine zero clobbered progress even when totalBytes /
    // downloadedBytes survived nonZeroMerge. Restore showed correct
    // progress, then the first poll cycle silently zeroed it.
    const existing = baseTask({
      totalBytes: 1000,
      downloadedBytes: 250,
      progress: 0.25,
    })
    const engineTask = baseTask({
      totalBytes: 0,
      downloadedBytes: 0,
      progress: 0,
      status: TaskStatus.Paused,
    })
    const merged = mergeEngineTask(existing, engineTask)
    expect(merged.progress).toBe(0.25)
    expect(merged.totalBytes).toBe(1000)
    expect(merged.downloadedBytes).toBe(250)
  })

  it('updates progress when engine reports new non-zero downloadedBytes', () => {
    const existing = baseTask({
      totalBytes: 1000,
      downloadedBytes: 250,
      progress: 0.25,
    })
    const engineTask = baseTask({
      totalBytes: 1000,
      downloadedBytes: 500,
      progress: 0.5,
    })
    const merged = mergeEngineTask(existing, engineTask)
    expect(merged.progress).toBe(0.5)
  })

  it('returns 0 progress when totalBytes is unknown', () => {
    const existing = baseTask({ totalBytes: 0, downloadedBytes: 0 })
    const engineTask = baseTask({
      totalBytes: 0,
      downloadedBytes: 0,
      status: TaskStatus.FetchingMetadata,
    })
    const merged = mergeEngineTask(existing, engineTask)
    expect(merged.progress).toBe(0)
  })

  it('derives uploadedBytes as baseline + current gid uploadLength', () => {
    const existing = baseTask({
      uploadedBytesBaseline: 1_000_000,
      uploadedBytes: 1_000_000,
    })
    const engineTask = baseTask({ uploadedBytes: 250_000 })
    const merged = mergeEngineTask(existing, engineTask)
    expect(merged.uploadedBytesBaseline).toBe(1_000_000)
    expect(merged.uploadedBytes).toBe(1_250_000)
  })

  it('does not lose baseline when engine reports a small non-zero upload after gid swap', () => {
    // Regression: a polling tick after finalize-reseed would write
    // newGid.uploadLength (e.g. 1 MB) directly into uploadedBytes via
    // nonZeroMerge, clobbering the prior session's accumulated bytes.
    // baseline now insulates the accumulator.
    const existing = baseTask({
      uploadedBytesBaseline: 50_000_000,
      uploadedBytes: 50_000_000,
    })
    const engineTask = baseTask({ uploadedBytes: 1_000_000 })
    const merged = mergeEngineTask(existing, engineTask)
    expect(merged.uploadedBytes).toBe(51_000_000)
    expect(merged.uploadedBytesBaseline).toBe(50_000_000)
  })

  it('preserves baseline when engine reports zero uploadLength right after reseed', () => {
    const existing = baseTask({
      uploadedBytesBaseline: 50_000_000,
      uploadedBytes: 50_000_000,
    })
    const engineTask = baseTask({ uploadedBytes: 0 })
    const merged = mergeEngineTask(existing, engineTask)
    expect(merged.uploadedBytes).toBe(50_000_000)
    expect(merged.uploadedBytesBaseline).toBe(50_000_000)
  })

  it('keeps a restored terminal timestamp stable across same-state polling', () => {
    const existing = baseTask({
      status: TaskStatus.Completed,
      finishedAt: 1234,
    })
    const engineTask = baseTask({
      status: TaskStatus.Completed,
      finishedAt: 9999,
    })

    expect(mergeEngineTask(existing, engineTask, 20_000).finishedAt).toBe(1234)
  })

  it('records incoming error details on a new terminal transition', () => {
    const existing = baseTask({ status: TaskStatus.Downloading })
    const engineTask = baseTask({
      status: TaskStatus.Error,
      finishedAt: null,
      errorMessage: 'network failed',
      errorCode: DownloadErrorCode.NetworkError,
    })

    expect(mergeEngineTask(existing, engineTask, 20_000)).toMatchObject({
      status: TaskStatus.Error,
      finishedAt: 20_000,
      errorMessage: 'network failed',
      errorCode: DownloadErrorCode.NetworkError,
    })
  })

  it('clears terminal fields when a task returns to seeding', () => {
    const existing = baseTask({
      status: TaskStatus.Completed,
      finishedAt: 1234,
      errorMessage: 'old',
      errorCode: DownloadErrorCode.Unknown,
    })
    const engineTask = baseTask({ status: TaskStatus.Seeding })

    expect(mergeEngineTask(existing, engineTask, 20_000)).toMatchObject({
      status: TaskStatus.Seeding,
      finishedAt: null,
      errorMessage: null,
      errorCode: null,
    })
  })

  it('does not resurrect a quarantined recovery error from a live engine row', () => {
    const existing = baseTask({
      status: TaskStatus.Error,
      transitionPhase: TransitionPhase.Renaming,
      finishedAt: 1234,
      errorMessage:
        'Recovery paused because temporary and final outputs both exist',
    })
    const engineTask = baseTask({ status: TaskStatus.Seeding })

    expect(mergeEngineTask(existing, engineTask, 20_000)).toMatchObject({
      status: TaskStatus.Error,
      transitionPhase: TransitionPhase.Renaming,
      finishedAt: 1234,
      errorMessage:
        'Recovery paused because temporary and final outputs both exist',
    })
  })

  it('does not publish engine completion while HTTP finalize owns the rename', () => {
    const existing = baseTask({
      status: TaskStatus.Downloading,
      transitionPhase: TransitionPhase.Renaming,
      totalBytes: 1_000,
      downloadedBytes: 900,
    })
    const engineTask = baseTask({
      status: TaskStatus.Completed,
      totalBytes: 1_000,
      downloadedBytes: 1_000,
      downloadSpeed: 0,
    })

    expect(mergeEngineTask(existing, engineTask, 20_000)).toMatchObject({
      status: TaskStatus.Downloading,
      transitionPhase: TransitionPhase.Renaming,
      totalBytes: 1_000,
      downloadedBytes: 1_000,
      progress: 1,
      downloadSpeed: 0,
      finishedAt: null,
    })
  })
})
