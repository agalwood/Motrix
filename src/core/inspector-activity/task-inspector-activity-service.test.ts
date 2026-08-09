import { TaskStatus } from '@shared/types/task'
import {
  type TaskActivityCheckpoint,
  type TaskActivityRevision,
  TaskHistoryAccuracy,
  type TaskHistoryEventInput,
  type TaskInspectorActivitySnapshot,
  TaskTransferSampleFlag,
} from '@shared/types/task-inspector-activity'
import { makeDownloadTask } from '@test-utils/task'
import { describe, expect, it, vi } from 'vitest'
import {
  type TaskActivityCheckpointResult,
  type TaskInspectorActivityPersistence,
  TaskInspectorActivityService,
} from './task-inspector-activity-service'

class FakeStore implements TaskInspectorActivityPersistence {
  batches: TaskActivityCheckpoint[][] = []
  failNextCheckpoint = false
  throwNextCheckpoint = false
  omittedTaskIds = new Set<string>()
  snapshotResult: TaskInspectorActivitySnapshot | null = null
  snapshotCalls = 0
  throwNextSnapshot = false
  ensureError: Error | null = null
  revision = 0

  ensureTask(): void {
    if (this.ensureError) throw this.ensureError
  }

  checkpointBatch(
    inputs: readonly TaskActivityCheckpoint[]
  ): TaskActivityCheckpointResult {
    this.batches.push(
      inputs.map((input) => ({
        ...input,
        samples: input.samples.map((sample) => ({ ...sample })),
      }))
    )
    if (this.throwNextCheckpoint) {
      this.throwNextCheckpoint = false
      throw new Error('checkpoint failed')
    }
    if (this.failNextCheckpoint) {
      this.failNextCheckpoint = false
      return {
        revisions: [],
        omissions: inputs.map((input) => ({
          taskId: input.taskId,
          error: new Error('checkpoint omitted'),
        })),
      }
    }
    const revisions = inputs
      .filter((input) => !this.omittedTaskIds.has(input.taskId))
      .map((input) => ({
        taskId: input.taskId,
        revision: ++this.revision,
        reason: 'checkpoint' as never,
      }))
    return {
      revisions,
      omissions: inputs
        .filter((input) => this.omittedTaskIds.has(input.taskId))
        .map((input) => ({
          taskId: input.taskId,
          error: new Error('checkpoint omitted'),
        })),
    }
  }

  recordTransition(_input: TaskHistoryEventInput): TaskActivityRevision | null {
    return null
  }

  snapshot(_taskId: string): TaskInspectorActivitySnapshot | null {
    this.snapshotCalls += 1
    if (this.throwNextSnapshot) {
      this.throwNextSnapshot = false
      throw new Error('snapshot failed')
    }
    return this.snapshotResult
  }
}

function persistedSnapshot(
  overrides: Partial<TaskInspectorActivitySnapshot['summary']> = {}
): TaskInspectorActivitySnapshot {
  return {
    taskId: 'task-1',
    revision: 1,
    summary: {
      trackingStartedAt: 1,
      coverageGapAt: null,
      revision: 1,
      lastEventOrdinal: 0,
      activeMs: 0,
      downloadActiveMs: 0,
      estimatedDownloadBytes: '0',
      estimatedUploadBytes: '0',
      peakDownloadBps: 0,
      peakUploadBps: 0,
      rawSampleCount: 0,
      historyDroppedCount: 0,
      historyTruncatedAt: null,
      updatedAt: 1,
      ...overrides,
    },
    timeline: {
      events: [],
      trackingStartedAt: 1,
      coverageGapAt: null,
      historyDroppedCount: 0,
      historyTruncatedAt: null,
    },
    lifetime: {
      points: [],
      averageDownloadSpeed: 0,
      peakDownloadSpeed: 0,
      peakUploadSpeed: 0,
      activeMs: 0,
      updatedAt: 1,
      accuracy: 'estimated',
    },
  }
}

function setup() {
  let wall = 1_000
  let monotonic = 1_000
  const store = new FakeStore()
  const revisions = vi.fn()
  const recovered = vi.fn()
  const service = new TaskInspectorActivityService(store, {
    wallNow: () => wall,
    monotonicNow: () => monotonic,
    onRevision: revisions,
    onRecoveredTransition: recovered,
  })
  const sample = (
    overrides: Partial<{
      status: TaskStatus
      downloadSpeed: number
      uploadSpeed: number
    }> = {}
  ) =>
    makeDownloadTask({
      id: 'task-1',
      status: overrides.status ?? TaskStatus.Downloading,
      downloadSpeed: overrides.downloadSpeed ?? 100,
      uploadSpeed: overrides.uploadSpeed ?? 20,
    })
  return {
    advance(wallDelta: number, monotonicDelta = wallDelta) {
      wall += wallDelta
      monotonic += monotonicDelta
    },
    get monotonic() {
      return monotonic
    },
    get wall() {
      return wall
    },
    recovered,
    revisions,
    sample,
    service,
    store,
  }
}

describe('TaskInspectorActivityService', () => {
  it('integrates one valid second with bigint trapezoid arithmetic', () => {
    const ctx = setup()
    ctx.service.recordSamples([
      ctx.sample({ downloadSpeed: 100, uploadSpeed: 20 }),
    ])
    ctx.advance(1_000)
    ctx.service.recordSamples([
      ctx.sample({ downloadSpeed: 300, uploadSpeed: 40 }),
    ])

    ctx.service.forceCheckpoint('task-1')

    const checkpoint = ctx.store.batches.at(-1)?.[0]
    expect(checkpoint).toMatchObject({
      taskId: 'task-1',
      activeMsDelta: 1_000,
      downloadActiveMsDelta: 1_000,
      estimatedDownloadBytesDelta: 200n,
      estimatedUploadBytesDelta: 30n,
      peakDownloadBps: 300,
      peakUploadBps: 40,
      rawSampleCountDelta: 2,
    })
    expect(checkpoint?.samples[0]).toMatchObject({
      t: 1_000,
      down: 100,
      up: 20,
    })
  })

  it('retains the bigint numerator remainder across checkpoints', () => {
    const ctx = setup()
    ctx.service.recordSamples([
      ctx.sample({ downloadSpeed: 1, uploadSpeed: 0 }),
    ])
    ctx.advance(500)
    ctx.service.recordSamples([
      ctx.sample({ downloadSpeed: 1, uploadSpeed: 0 }),
    ])
    ctx.service.forceCheckpoint('task-1')
    expect(ctx.store.batches.at(-1)?.[0].estimatedDownloadBytesDelta).toBe(0n)

    ctx.advance(500)
    ctx.service.recordSamples([
      ctx.sample({ downloadSpeed: 1, uploadSpeed: 0 }),
    ])
    ctx.service.forceCheckpoint('task-1')
    expect(ctx.store.batches.at(-1)?.[0].estimatedDownloadBytesDelta).toBe(1n)
  })

  it('splits a Pause to Resume cycle entirely between polls', () => {
    const ctx = setup()
    ctx.service.recordSamples([
      ctx.sample({ downloadSpeed: 100, uploadSpeed: 0 }),
    ])
    ctx.service.noteTransition({
      taskId: 'task-1',
      previousStatus: TaskStatus.Downloading,
      nextStatus: TaskStatus.Paused,
      occurredAt: 1_250,
      monotonicAt: 1_250,
      accuracy: TaskHistoryAccuracy.Exact,
      errorCode: null,
      errorMessage: null,
    })
    ctx.service.noteTransition({
      taskId: 'task-1',
      previousStatus: TaskStatus.Paused,
      nextStatus: TaskStatus.Downloading,
      occurredAt: 1_750,
      monotonicAt: 1_750,
      accuracy: TaskHistoryAccuracy.Exact,
      errorCode: null,
      errorMessage: null,
    })
    ctx.advance(1_000)
    ctx.service.recordSamples([
      ctx.sample({ downloadSpeed: 100, uploadSpeed: 0 }),
    ])
    ctx.service.forceCheckpoint('task-1')

    const checkpoint = ctx.store.batches.at(-1)?.[0]
    expect(checkpoint).toMatchObject({
      activeMsDelta: 500,
      downloadActiveMsDelta: 500,
      estimatedDownloadBytesDelta: 50n,
    })
    expect(
      checkpoint?.samples.filter(
        (point) => point.flags & TaskTransferSampleFlag.StatusBoundary
      )
    ).toHaveLength(2)
  })

  it('marks a gap and re-anchors instead of integrating an invalid interval', () => {
    const ctx = setup()
    ctx.service.recordSamples([ctx.sample()])
    ctx.advance(6_000)
    ctx.service.recordSamples([ctx.sample({ downloadSpeed: 500 })])
    ctx.service.forceCheckpoint('task-1')

    expect(ctx.store.batches.at(-1)?.[0]).toMatchObject({
      activeMsDelta: 0,
      estimatedDownloadBytesDelta: 0n,
      coverageGapAt: 1_000,
    })
  })

  it('treats a poll-only status difference as recovered and never integrates across it', () => {
    const ctx = setup()
    ctx.service.recordSamples([ctx.sample()])
    ctx.advance(1_000)
    ctx.service.recordSamples([
      ctx.sample({ status: TaskStatus.Paused, downloadSpeed: 0 }),
    ])
    ctx.service.forceCheckpoint('task-1')

    expect(ctx.recovered).toHaveBeenCalledWith({
      taskId: 'task-1',
      previousStatus: TaskStatus.Downloading,
      nextStatus: TaskStatus.Paused,
      occurredAt: 2_000,
      monotonicAt: 2_000,
      accuracy: TaskHistoryAccuracy.Recovered,
      errorCode: null,
      errorMessage: null,
      errorDetailKey: null,
      errorDetailParams: null,
    })
    expect(ctx.store.batches.at(-1)?.[0].activeMsDelta).toBe(0)
  })

  it('retains dirty deltas and candidates when a checkpoint omits the task', () => {
    const ctx = setup()
    ctx.service.recordSamples([ctx.sample()])
    ctx.advance(1_000)
    ctx.service.recordSamples([ctx.sample({ downloadSpeed: 300 })])
    ctx.store.failNextCheckpoint = true

    ctx.service.forceCheckpoint('task-1')
    ctx.service.forceCheckpoint('task-1')

    expect(ctx.store.batches).toHaveLength(2)
    expect(ctx.store.batches[1][0]).toMatchObject({
      estimatedDownloadBytesDelta: 200n,
      rawSampleCountDelta: 2,
    })
    expect(ctx.store.batches[1][0].samples.length).toBeGreaterThan(0)
  })

  it('keeps a terminal series at zero when task fields retain stale speeds', () => {
    const ctx = setup()
    ctx.service.recordSamples([
      ctx.sample({ downloadSpeed: 100, uploadSpeed: 20 }),
    ])
    ctx.service.noteTransition({
      taskId: 'task-1',
      previousStatus: TaskStatus.Downloading,
      nextStatus: TaskStatus.Completed,
      occurredAt: 1_500,
      monotonicAt: 1_500,
      accuracy: TaskHistoryAccuracy.Exact,
      errorCode: null,
      errorMessage: null,
    })
    ctx.advance(1_000)
    ctx.service.recordSamples([
      ctx.sample({
        status: TaskStatus.Completed,
        downloadSpeed: 900,
        uploadSpeed: 300,
      }),
    ])
    ctx.service.forceCheckpoint('task-1')

    const completedCheckpoint = ctx.store.batches.at(-1)?.[0]
    expect(completedCheckpoint?.samples.at(-1)).toMatchObject({
      t: 1_500,
      down: 0,
      up: 0,
      flags:
        TaskTransferSampleFlag.StatusBoundary | TaskTransferSampleFlag.Terminal,
    })
    const batchCount = ctx.store.batches.length

    ctx.advance(10_000)
    ctx.service.recordSamples([
      ctx.sample({
        status: TaskStatus.Completed,
        downloadSpeed: 900,
        uploadSpeed: 300,
      }),
    ])
    ctx.service.forceCheckpoint('task-1')

    expect(ctx.store.batches).toHaveLength(batchCount)
  })

  it('closes an exact terminal boundary before the slower idle poll', () => {
    const ctx = setup()
    ctx.service.recordSamples([
      ctx.sample({ downloadSpeed: 3_000_000, uploadSpeed: 0 }),
    ])
    ctx.advance(300)
    ctx.service.recordSamples([
      ctx.sample({ downloadSpeed: 1_000_000, uploadSpeed: 0 }),
    ])
    ctx.service.noteTransition({
      taskId: 'task-1',
      previousStatus: TaskStatus.Downloading,
      nextStatus: TaskStatus.Completed,
      occurredAt: ctx.wall + 6,
      monotonicAt: ctx.monotonic + 6,
      accuracy: TaskHistoryAccuracy.Exact,
      errorCode: null,
      errorMessage: null,
    })

    ctx.advance(10_006)
    ctx.service.recordSamples([
      ctx.sample({
        status: TaskStatus.Completed,
        downloadSpeed: 1_000_000,
        uploadSpeed: 0,
      }),
    ])
    ctx.service.forceCheckpoint('task-1')

    const checkpoint = ctx.store.batches.at(-1)?.[0]
    expect(checkpoint).not.toHaveProperty('coverageGapAt')
    expect(checkpoint?.samples.at(-1)).toMatchObject({
      t: 1_306,
      down: 0,
      up: 0,
      flags:
        TaskTransferSampleFlag.StatusBoundary | TaskTransferSampleFlag.Terminal,
    })
    expect(ctx.recovered).not.toHaveBeenCalled()
  })

  it('does not turn an exact pre-baseline transition into a coverage gap on completion', () => {
    const ctx = setup()
    ctx.service.noteTransition({
      taskId: 'task-1',
      previousStatus: TaskStatus.Queued,
      nextStatus: TaskStatus.Downloading,
      occurredAt: 900,
      monotonicAt: 900,
      accuracy: TaskHistoryAccuracy.Exact,
      errorCode: null,
      errorMessage: null,
    })
    ctx.service.recordSamples([
      ctx.sample({ downloadSpeed: 3_000_000, uploadSpeed: 0 }),
    ])
    ctx.service.noteTransition({
      taskId: 'task-1',
      previousStatus: TaskStatus.Downloading,
      nextStatus: TaskStatus.Completed,
      occurredAt: 1_500,
      monotonicAt: 1_500,
      accuracy: TaskHistoryAccuracy.Exact,
      errorCode: null,
      errorMessage: null,
    })
    ctx.service.forceCheckpoint('task-1')

    const checkpoint = ctx.store.batches.at(-1)?.[0]
    expect(checkpoint).not.toHaveProperty('coverageGapAt')
    expect(checkpoint?.samples.at(-1)).toMatchObject({
      t: 1_500,
      down: 0,
      up: 0,
      flags:
        TaskTransferSampleFlag.StatusBoundary | TaskTransferSampleFlag.Terminal,
    })
    expect(ctx.recovered).not.toHaveBeenCalled()
  })

  it('tombstones removal and ignores late samples and transitions', () => {
    const ctx = setup()
    ctx.service.recordSamples([ctx.sample()])
    ctx.service.tombstone('task-1')
    ctx.advance(1_000)
    ctx.service.recordSamples([ctx.sample({ downloadSpeed: 900 })])
    ctx.service.noteTransition({
      taskId: 'task-1',
      previousStatus: TaskStatus.Downloading,
      nextStatus: TaskStatus.Completed,
      occurredAt: ctx.wall,
      monotonicAt: ctx.monotonic,
      accuracy: TaskHistoryAccuracy.Exact,
      errorCode: null,
      errorMessage: null,
    })
    ctx.service.forceCheckpoint()

    expect(ctx.store.batches).toHaveLength(0)
  })

  it('uses distinct active/download-active rules and direction-specific first peaks', () => {
    const ctx = setup()
    ctx.service.recordSamples([
      ctx.sample({
        status: TaskStatus.Seeding,
        downloadSpeed: 900,
        uploadSpeed: 200,
      }),
    ])
    ctx.advance(1_000)
    ctx.service.recordSamples([
      ctx.sample({
        status: TaskStatus.Seeding,
        downloadSpeed: 900,
        uploadSpeed: 200,
      }),
    ])
    ctx.service.forceCheckpoint('task-1')

    expect(ctx.store.batches.at(-1)?.[0]).toMatchObject({
      activeMsDelta: 1_000,
      downloadActiveMsDelta: 0,
      estimatedDownloadBytesDelta: 0n,
      estimatedUploadBytesDelta: 200n,
      peakDownloadBps: 0,
      peakUploadBps: 200,
    })
  })

  it('rejects wall/monotonic divergence and coalesces equal-wall candidates', () => {
    const ctx = setup()
    ctx.service.recordSamples([ctx.sample()])
    ctx.advance(1_000, 2_500)
    ctx.service.recordSamples([ctx.sample({ downloadSpeed: 500 })])
    ctx.service.forceCheckpoint('task-1')
    expect(ctx.store.batches.at(-1)?.[0]).toMatchObject({
      activeMsDelta: 0,
      coverageGapAt: 1_000,
    })

    const equal = setup()
    equal.service.recordSamples([equal.sample()])
    equal.advance(0, 1)
    equal.service.recordSamples([equal.sample({ downloadSpeed: 500 })])
    equal.service.forceCheckpoint('task-1')
    expect(equal.store.batches.at(-1)?.[0].samples).toHaveLength(1)
    expect(
      (equal.store.batches.at(-1)?.[0].samples[0].flags ?? 0) &
        TaskTransferSampleFlag.CoverageGap
    ).not.toBe(0)
  })

  it('keeps stable traffic on the 15s periodic cadence instead of treating equality as a new peak', () => {
    const ctx = setup()
    ctx.service.recordSamples([
      ctx.sample({ downloadSpeed: 2_000_000, uploadSpeed: 0 }),
    ])
    for (let index = 0; index < 3; index += 1) {
      ctx.advance(5_000)
      ctx.service.recordSamples([
        ctx.sample({ downloadSpeed: 2_000_000, uploadSpeed: 0 }),
      ])
    }
    ctx.service.forceCheckpoint('task-1')

    expect(
      ctx.store.batches.at(-1)?.[0].samples.map((point) => point.t)
    ).toEqual([1_000, 16_000])
  })

  it('retains every 15s periodic point across a 30s checkpoint window', () => {
    const ctx = setup()
    ctx.service.recordSamples([
      ctx.sample({ downloadSpeed: 2_000_000, uploadSpeed: 0 }),
    ])
    for (let index = 0; index < 6; index += 1) {
      ctx.advance(5_000)
      ctx.service.recordSamples([
        ctx.sample({ downloadSpeed: 2_000_000, uploadSpeed: 0 }),
      ])
    }

    expect(
      ctx.store.batches.flatMap((batch) =>
        batch.flatMap((checkpoint) =>
          checkpoint.samples.map((point) => point.t)
        )
      )
    ).toEqual([1_000, 16_000, 31_000])
  })

  it('writes one 60s heartbeat for stable zero traffic', () => {
    const ctx = setup()
    ctx.service.recordSamples([
      ctx.sample({ downloadSpeed: 0, uploadSpeed: 0 }),
    ])
    for (let index = 0; index < 12; index += 1) {
      ctx.advance(5_000)
      ctx.service.recordSamples([
        ctx.sample({ downloadSpeed: 0, uploadSpeed: 0 }),
      ])
    }
    ctx.service.forceCheckpoint('task-1')

    expect(
      ctx.store.batches.flatMap((batch) =>
        batch.flatMap((checkpoint) =>
          checkpoint.samples.map((point) => point.t)
        )
      )
    ).toEqual([1_000, 61_000])
  })

  it('does not checkpoint idle raw-count changes before the heartbeat', () => {
    const ctx = setup()
    ctx.service.recordSamples([
      ctx.sample({
        status: TaskStatus.Paused,
        downloadSpeed: 0,
        uploadSpeed: 0,
      }),
    ])
    ctx.service.forceCheckpoint()
    expect(ctx.store.batches).toHaveLength(1)

    for (let index = 0; index < 6; index += 1) {
      ctx.advance(5_000)
      ctx.service.recordSamples([
        ctx.sample({
          status: TaskStatus.Paused,
          downloadSpeed: 0,
          uploadSpeed: 0,
        }),
      ])
    }
    expect(ctx.store.batches).toHaveLength(1)
  })

  it('flushes raw sample counts on dispose without enabling per-poll checkpoints', async () => {
    const ctx = setup()
    const paused = () =>
      ctx.sample({
        status: TaskStatus.Paused,
        downloadSpeed: 0,
        uploadSpeed: 0,
      })
    ctx.service.recordSamples([paused()])
    ctx.service.forceCheckpoint()
    for (let index = 0; index < 6; index += 1) {
      ctx.advance(5_000)
      ctx.service.recordSamples([paused()])
    }
    expect(ctx.store.batches).toHaveLength(1)

    await ctx.service.dispose()

    expect(ctx.store.batches).toHaveLength(2)
    expect(ctx.store.batches[1][0]).toMatchObject({
      rawSampleCountDelta: 6,
      samples: [],
    })
  })

  it('checkpoints multiple dirty tasks in one 30s batch', () => {
    const ctx = setup()
    const second = makeDownloadTask({
      id: 'task-2',
      status: TaskStatus.Downloading,
      downloadSpeed: 200,
      uploadSpeed: 0,
    })
    ctx.service.recordSamples([ctx.sample(), second])
    for (let index = 0; index < 6; index += 1) {
      ctx.advance(5_000)
      ctx.service.recordSamples([ctx.sample(), second])
    }

    expect(ctx.store.batches).toHaveLength(1)
    expect(ctx.store.batches[0].map((item) => item.taskId).sort()).toEqual([
      'task-1',
      'task-2',
    ])
  })

  it('commits healthy tasks while retaining a poison task for retry', () => {
    const ctx = setup()
    const second = makeDownloadTask({
      id: 'task-2',
      status: TaskStatus.Downloading,
      downloadSpeed: 200,
      uploadSpeed: 0,
    })
    ctx.store.omittedTaskIds.add('task-2')
    ctx.service.recordSamples([ctx.sample(), second])
    ctx.advance(1_000)
    ctx.service.recordSamples([ctx.sample(), second])

    ctx.service.forceCheckpoint()
    ctx.store.omittedTaskIds.clear()
    ctx.service.forceCheckpoint()

    expect(ctx.store.batches[1].map((item) => item.taskId)).toEqual(['task-2'])
  })

  it('retries checkpoint exceptions and isolates error/revision observers', () => {
    let wall = 1_000
    let monotonic = 1_000
    const store = new FakeStore()
    store.throwNextCheckpoint = true
    const onError = vi.fn(() => {
      throw new Error('logger failed')
    })
    const onRevision = vi.fn(() => {
      throw new Error('listener failed')
    })
    const service = new TaskInspectorActivityService(store, {
      wallNow: () => wall,
      monotonicNow: () => monotonic,
      onError,
      onRevision,
    })
    const task = makeDownloadTask({
      id: 'task-1',
      status: TaskStatus.Downloading,
      downloadSpeed: 100,
      uploadSpeed: 0,
    })
    service.recordSamples([task])
    wall += 1_000
    monotonic += 1_000
    service.recordSamples([task])

    expect(() => service.forceCheckpoint()).not.toThrow()
    expect(() => service.forceCheckpoint()).not.toThrow()
    expect(store.batches).toHaveLength(2)
    expect(onError).toHaveBeenCalled()
    expect(onRevision).toHaveBeenCalled()
  })

  it('re-anchors after an omitted checkpoint while retaining deltas and marking a gap', () => {
    const ctx = setup()
    ctx.store.omittedTaskIds.add('task-1')
    ctx.service.recordSamples([ctx.sample({ downloadSpeed: 100 })])
    ctx.advance(1_000)
    ctx.service.recordSamples([ctx.sample({ downloadSpeed: 300 })])

    ctx.service.forceCheckpoint()
    ctx.store.omittedTaskIds.clear()
    ctx.advance(1_000)
    ctx.service.recordSamples([ctx.sample({ downloadSpeed: 500 })])
    ctx.service.forceCheckpoint()

    const retry = ctx.store.batches.at(-1)?.[0]
    expect(retry).toMatchObject({
      estimatedDownloadBytesDelta: 200n,
      activeMsDelta: 1_000,
      coverageGapAt: 2_000,
    })
    expect(
      retry?.samples.filter(
        (sample) => (sample.flags & TaskTransferSampleFlag.CoverageGap) !== 0
      )
    ).toHaveLength(1)
  })

  it('flushes on disconnect and dispose while clearing the integration baseline', async () => {
    const ctx = setup()
    ctx.service.recordSamples([ctx.sample()])
    ctx.advance(1_000)
    ctx.service.recordSamples([ctx.sample({ downloadSpeed: 300 })])

    ctx.service.markDisconnected()
    expect(ctx.store.batches).toHaveLength(1)

    ctx.advance(1_000)
    ctx.service.recordSamples([ctx.sample({ downloadSpeed: 300 })])
    await ctx.service.dispose()
    expect(ctx.store.batches).toHaveLength(2)
    expect(ctx.store.batches[1][0].activeMsDelta).toBe(0)
  })

  it('retries the final checkpoint once and rejects when data remains pending', async () => {
    const ctx = setup()
    ctx.store.omittedTaskIds.add('task-1')
    ctx.service.recordSamples([ctx.sample()])
    ctx.advance(1_000)
    ctx.service.recordSamples([ctx.sample({ downloadSpeed: 300 })])

    await expect(ctx.service.dispose()).rejects.toThrow(
      'final checkpoint incomplete'
    )
    expect(ctx.store.batches).toHaveLength(2)
  })

  it('keeps checkpoint updatedAt monotonic after wall rollback and flags the next durable point', () => {
    const ctx = setup()
    ctx.service.recordSamples([ctx.sample()])
    ctx.advance(1_000)
    ctx.service.recordSamples([ctx.sample({ downloadSpeed: 300 })])
    ctx.service.forceCheckpoint()
    expect(ctx.store.batches.at(-1)?.[0].updatedAt).toBe(2_000)

    ctx.advance(-500, 1_000)
    ctx.service.recordSamples([ctx.sample({ downloadSpeed: 300 })])
    ctx.service.forceCheckpoint()
    const rollback = ctx.store.batches.at(-1)?.[0]
    expect(rollback?.updatedAt).toBeGreaterThanOrEqual(2_000)
    expect(rollback?.coverageGapAt).toBe(2_000)

    ctx.advance(1_000)
    ctx.service.recordSamples([ctx.sample({ downloadSpeed: 300 })])
    ctx.service.forceCheckpoint()
    const recovered = ctx.store.batches.at(-1)?.[0]
    expect(
      recovered?.samples.filter(
        (sample) => (sample.flags & TaskTransferSampleFlag.CoverageGap) !== 0
      )
    ).toHaveLength(1)
  })

  it('marks saturation as a gap and drops the overflowing interval', () => {
    const ctx = setup()
    ctx.store.snapshotResult = persistedSnapshot({
      estimatedDownloadBytes: '9223372036854775802',
    })
    ctx.service.recordSamples([
      ctx.sample({ downloadSpeed: 10, uploadSpeed: 0 }),
    ])
    ctx.advance(1_000)
    ctx.service.recordSamples([
      ctx.sample({ downloadSpeed: 10, uploadSpeed: 0 }),
    ])
    ctx.service.forceCheckpoint()

    expect(ctx.store.batches.at(-1)?.[0]).toMatchObject({
      estimatedDownloadBytesDelta: 0n,
      coverageGapAt: 1_000,
    })
  })

  it('retries recovered-anchor hydration after a snapshot failure', () => {
    const ctx = setup()
    ctx.store.snapshotResult = persistedSnapshot({
      estimatedDownloadBytes: '9223372036854775802',
    })
    ctx.store.throwNextSnapshot = true

    expect(ctx.service.markRecoveredAnchor('task-1', ctx.wall)).toBe(false)
    expect(ctx.store.snapshotCalls).toBe(1)
    expect(ctx.service.markRecoveredAnchor('task-1', ctx.wall)).toBe(true)
    expect(ctx.store.snapshotCalls).toBe(2)

    ctx.service.recordSamples([
      ctx.sample({ downloadSpeed: 10, uploadSpeed: 0 }),
    ])
    ctx.advance(1_000)
    ctx.service.recordSamples([
      ctx.sample({ downloadSpeed: 10, uploadSpeed: 0 }),
    ])
    ctx.service.forceCheckpoint('task-1')

    expect(ctx.store.batches.at(-1)?.[0]).toMatchObject({
      estimatedDownloadBytesDelta: 0n,
      coverageGapAt: 1_000,
    })
  })

  it('bounds protected candidates while the parent FK is unavailable', () => {
    const ctx = setup()
    ctx.store.ensureError = new Error('FOREIGN KEY constraint failed')
    let status = TaskStatus.Downloading
    ctx.service.recordSamples([ctx.sample({ status })])
    for (let index = 0; index < 80; index += 1) {
      const next: TaskStatus =
        status === TaskStatus.Downloading
          ? TaskStatus.Paused
          : TaskStatus.Downloading
      ctx.service.noteTransition({
        taskId: 'task-1',
        previousStatus: status,
        nextStatus: next,
        occurredAt: ctx.wall + 1,
        monotonicAt: ctx.monotonic + 1,
        accuracy: TaskHistoryAccuracy.Exact,
        errorCode: null,
        errorMessage: null,
      })
      ctx.advance(1)
      status = next
      ctx.service.recordSamples([
        ctx.sample({
          status,
          downloadSpeed: status === TaskStatus.Paused ? 0 : 100,
          uploadSpeed: 0,
        }),
      ])
    }
    expect(ctx.store.batches).toHaveLength(0)

    ctx.store.ensureError = null
    ctx.service.markParentDurable('task-1', ctx.wall)
    ctx.service.forceCheckpoint()

    expect(ctx.store.batches.at(-1)?.[0].samples.length).toBeLessThanOrEqual(64)
  })
})
