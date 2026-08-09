import type { GlobalStats } from '@shared/types/stats'
import { TaskStatus } from '@shared/types/task'
import { makeDownloadTask } from '@test-utils/task'
import { describe, expect, it, vi } from 'vitest'
import {
  classifyError,
  dispatchTaskUpdates,
  mapStatusToPhase,
  type TaskNotificationSink,
  taskToCompletedParams,
  taskToErrorParams,
  taskToProgressParams,
  toStatsResult,
} from './progress-mapping'

describe('mapStatusToPhase', () => {
  it.each([
    [TaskStatus.Queued, 'queued'],
    [TaskStatus.FetchingMetadata, 'queued'],
    [TaskStatus.Downloading, 'downloading'],
    [TaskStatus.Paused, 'downloading'],
    [TaskStatus.Finalizing, 'finalizing'],
    [TaskStatus.Seeding, 'finalizing'],
    [TaskStatus.Completed, 'finalizing'],
    [TaskStatus.Error, 'finalizing'],
  ] as const)('maps %s → %s', (status, phase) => {
    expect(mapStatusToPhase(status)).toBe(phase)
  })
})

describe('taskToProgressParams', () => {
  it('maps fields and coalesces unknown total/eta to null', () => {
    const params = taskToProgressParams(
      makeDownloadTask({
        id: 't1',
        downloadedBytes: 500,
        totalBytes: 0,
        downloadSpeed: 250,
        etaSeconds: 0,
        status: TaskStatus.Downloading,
      })
    )
    expect(params).toEqual({
      taskId: 't1',
      bytesDone: 500,
      bytesTotal: null,
      speedBps: 250,
      etaSec: null,
      phase: 'downloading',
    })
  })

  it('keeps positive total/eta', () => {
    const params = taskToProgressParams(
      makeDownloadTask({ totalBytes: 1000, etaSeconds: 30 })
    )
    expect(params.bytesTotal).toBe(1000)
    expect(params.etaSec).toBe(30)
  })
})

describe('taskToCompletedParams', () => {
  it('uses finalPath and computes durationMs from finishedAt - createdAt', () => {
    const params = taskToCompletedParams(
      makeDownloadTask({
        id: 't2',
        finalPath: '/dl/f.iso',
        createdAt: 1000,
        finishedAt: 4000,
      })
    )
    expect(params).toEqual({
      taskId: 't2',
      filePath: '/dl/f.iso',
      durationMs: 3000,
    })
  })
})

describe('taskToErrorParams', () => {
  it('builds {taskId, code, message}', () => {
    const params = taskToErrorParams(
      makeDownloadTask({ id: 't3' }),
      'disk-full',
      'No space left'
    )
    expect(params).toEqual({
      taskId: 't3',
      code: 'disk-full',
      message: 'No space left',
    })
  })
})

describe('classifyError', () => {
  it('returns internal-error when status is not Error', () => {
    expect(
      classifyError(makeDownloadTask({ status: TaskStatus.Downloading }))
    ).toBe('internal-error')
  })

  it('classifies by error message', () => {
    const make = (errorMessage: string) =>
      makeDownloadTask({ status: TaskStatus.Error, errorMessage })
    expect(classifyError(make('HTTP 404 not found'))).toBe('not-found')
    expect(classifyError(make('got 401 unauthorized'))).toBe('auth-expired')
    expect(classifyError(make('ENOSPC no space'))).toBe('disk-full')
    expect(classifyError(make('connection reset'))).toBe('transient-failure')
  })
})

describe('dispatchTaskUpdates', () => {
  function makeSink() {
    return {
      onProgress: vi.fn(),
      onCompleted: vi.fn(),
      onError: vi.fn(),
    } satisfies TaskNotificationSink
  }

  it('dispatches non-terminal tasks to onProgress', () => {
    const sink = makeSink()
    const seen = new Map<string, string>()
    dispatchTaskUpdates(
      [
        makeDownloadTask({ id: 'a', status: TaskStatus.Downloading }),
        makeDownloadTask({ id: 'b', status: TaskStatus.Queued }),
      ],
      seen,
      sink
    )
    expect(sink.onProgress).toHaveBeenCalledTimes(2)
    expect(sink.onCompleted).not.toHaveBeenCalled()
  })

  it('dispatches Completed to onCompleted exactly once (dedup across calls)', () => {
    const sink = makeSink()
    const seen = new Map<string, string>()
    const t = makeDownloadTask({ id: 'a', status: TaskStatus.Completed })
    dispatchTaskUpdates([t], seen, sink)
    dispatchTaskUpdates([t], seen, sink)
    expect(sink.onCompleted).toHaveBeenCalledTimes(1)
  })

  it('dispatches Error to onError once with the classified code', () => {
    const sink = makeSink()
    dispatchTaskUpdates(
      [
        makeDownloadTask({
          id: 'a',
          status: TaskStatus.Error,
          errorMessage: 'ENOSPC no space',
        }),
      ],
      new Map(),
      sink
    )
    expect(sink.onError).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'a' }),
      'disk-full'
    )
  })

  it('emits progress then completed across a transition', () => {
    const sink = makeSink()
    const seen = new Map<string, string>()
    dispatchTaskUpdates(
      [makeDownloadTask({ id: 'a', status: TaskStatus.Downloading })],
      seen,
      sink
    )
    dispatchTaskUpdates(
      [makeDownloadTask({ id: 'a', status: TaskStatus.Completed })],
      seen,
      sink
    )
    expect(sink.onProgress).toHaveBeenCalledTimes(1)
    expect(sink.onCompleted).toHaveBeenCalledTimes(1)
  })

  it('ignores Removed tasks and clears them from the seen map', () => {
    const sink = makeSink()
    const seen = new Map<string, string>([['a', 'completed:1']])
    dispatchTaskUpdates(
      [makeDownloadTask({ id: 'a', status: TaskStatus.Removed })],
      seen,
      sink
    )
    expect(sink.onProgress).not.toHaveBeenCalled()
    expect(sink.onCompleted).not.toHaveBeenCalled()
    expect(seen.has('a')).toBe(false)
  })

  it('prunes seen entries for tasks absent from the snapshot (real delete path)', () => {
    const sink = makeSink()
    const seen = new Map<string, string>()
    // A completed task is recorded in `seen`…
    dispatchTaskUpdates(
      [makeDownloadTask({ id: 'a', status: TaskStatus.Completed })],
      seen,
      sink
    )
    expect(seen.has('a')).toBe(true)
    // …then removeTask/clearStoppedTasks deletes it from the TaskManager
    // FIRST, so the next full snapshot simply omits it (no explicit Removed
    // frame). Without pruning, its key lingers forever — an unbounded leak on
    // a long-running server across completed→clear churn.
    dispatchTaskUpdates(
      [makeDownloadTask({ id: 'b', status: TaskStatus.Downloading })],
      seen,
      sink
    )
    expect(seen.has('a')).toBe(false)
  })

  it('notifies a second Completed with a new finishedAt even with zero intermediate frames', () => {
    const sink = makeSink()
    const seen = new Map<string, string>()
    dispatchTaskUpdates(
      [
        makeDownloadTask({
          id: 'a',
          status: TaskStatus.Completed,
          finishedAt: 1_000,
        }),
      ],
      seen,
      sink
    )
    // A re-add that re-completed inside one coalescing window can emit no
    // frame showing the task non-terminal. The dedup identity mirrors
    // terminalOccurrenceId (id + status + finishedAt), so the second
    // completion is a NEW terminal occurrence regardless of frame order.
    dispatchTaskUpdates(
      [
        makeDownloadTask({
          id: 'a',
          status: TaskStatus.Completed,
          finishedAt: 2_000,
        }),
      ],
      seen,
      sink
    )
    expect(sink.onCompleted).toHaveBeenCalledTimes(2)
  })

  it('notifies an Error that directly follows a Completed for the same id', () => {
    const sink = makeSink()
    const seen = new Map<string, string>()
    dispatchTaskUpdates(
      [
        makeDownloadTask({
          id: 'a',
          status: TaskStatus.Completed,
          finishedAt: 1_000,
        }),
      ],
      seen,
      sink
    )
    dispatchTaskUpdates(
      [
        makeDownloadTask({
          id: 'a',
          status: TaskStatus.Error,
          errorMessage: 'connection reset',
          finishedAt: 1_000,
        }),
      ],
      seen,
      sink
    )
    expect(sink.onCompleted).toHaveBeenCalledTimes(1)
    expect(sink.onError).toHaveBeenCalledTimes(1)
  })
})

describe('toStatsResult', () => {
  it('projects GlobalStats onto StatsResult (identity fields)', () => {
    const stats: GlobalStats = {
      totalDownloadSpeed: 100,
      totalUploadSpeed: 20,
      activeTasks: 2,
      waitingTasks: 1,
      stoppedTasks: 5,
    }
    expect(toStatsResult(stats)).toEqual(stats)
  })
})
