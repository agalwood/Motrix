import { EventBus } from '@core/events/event-bus'
import { DownloadErrorCode } from '@shared/errors'
import { Events } from '@shared/protocol/events'
import { TaskStatus } from '@shared/types/task'
import {
  type TaskActivityCheckpoint,
  type TaskActivityRevision,
  TaskHistoryAccuracy,
  TaskHistoryDelivery,
  type TaskHistoryEventInput,
  TaskHistoryEventKind,
  type TaskInspectorActivitySnapshot,
  TaskInspectorActivityUpdateReason,
} from '@shared/types/task-inspector-activity'
import type {
  TaskDiagnosisOccurrence,
  TaskTerminalOccurrence,
} from '@shared/types/task-occurrence'
import { makeDownloadTask } from '@test-utils/task'
import { describe, expect, it, vi } from 'vitest'
import {
  TaskInspectorActivityRuntime,
  type TaskInspectorActivityRuntimePersistence,
} from './task-inspector-activity-runtime'
import type { TaskActivityCheckpointResult } from './task-inspector-activity-service'

function makeDiagnosisOccurrence(
  overrides: Partial<TaskDiagnosisOccurrence> = {}
): TaskDiagnosisOccurrence {
  return {
    occurrenceId: 'task-1:100:diag:1',
    type: 'diagnosis',
    taskId: 'task-1',
    terminalOccurrenceId: 'task-1:error:100',
    revision: 1,
    diagnosis: {
      errorCode: DownloadErrorCode.DiskFull,
      errorMessage: null,
      errorDetailKey: 'task.error.detail.filesMissing',
      errorDetailParams: null,
    },
    createdAt: 150,
    ...overrides,
  }
}

function makeTerminalOccurrence(
  overrides: Partial<TaskTerminalOccurrence> = {}
): TaskTerminalOccurrence {
  return {
    occurrenceId: 'task-1:error:100',
    type: 'terminal',
    taskId: 'task-1',
    fromStatus: TaskStatus.Downloading,
    toStatus: TaskStatus.Error,
    cause: 'engine',
    errorGroup: {
      errorCode: DownloadErrorCode.DiskFull,
      errorMessage: null,
      errorDetailKey: 'task.error.detail.filesMissing',
      errorDetailParams: null,
    },
    createdAt: 100,
    ...overrides,
  }
}

function snapshot(lastEventOrdinal = 0): TaskInspectorActivitySnapshot {
  return {
    taskId: 'task-1',
    revision: 0,
    summary: {
      trackingStartedAt: 1,
      coverageGapAt: null,
      revision: 0,
      lastEventOrdinal,
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

function createStore(lastEventOrdinal = 0) {
  const transitions: TaskHistoryEventInput[] = []
  const committedTransitions: TaskHistoryEventInput[] = []
  let failTransitions = 0
  let failCheckpoints = 0
  const store: TaskInspectorActivityRuntimePersistence & {
    transitions: TaskHistoryEventInput[]
    committedTransitions: TaskHistoryEventInput[]
    failNextTransition(): void
    failNextCheckpoint(): void
  } = {
    transitions,
    committedTransitions,
    failNextTransition() {
      failTransitions += 1
    },
    failNextCheckpoint() {
      failCheckpoints += 1
    },
    ensureTask: vi.fn(),
    checkpointBatch: vi.fn(
      (
        inputs: readonly TaskActivityCheckpoint[]
      ): TaskActivityCheckpointResult => {
        if (failCheckpoints > 0) {
          failCheckpoints -= 1
          return {
            revisions: [],
            omissions: inputs.map((input) => ({
              taskId: input.taskId,
              error: new Error('checkpoint busy'),
            })),
          }
        }
        return {
          revisions: inputs.map((input) => ({
            taskId: input.taskId,
            revision: 1,
            reason: TaskInspectorActivityUpdateReason.Checkpoint,
          })) as readonly TaskActivityRevision[],
          omissions: [],
        }
      }
    ),
    recordTransition: vi.fn((input: TaskHistoryEventInput) => {
      transitions.push({ ...input })
      if (failTransitions > 0) {
        failTransitions -= 1
        throw new Error('database busy')
      }
      committedTransitions.push({ ...input })
      return {
        taskId: input.taskId,
        revision: input.eventOrdinal,
        reason: TaskInspectorActivityUpdateReason.Transition,
      }
    }),
    snapshot: vi.fn(() => {
      const base = snapshot(lastEventOrdinal)
      return {
        ...base,
        timeline: {
          ...base.timeline,
          // Reflects durably-committed transitions so idempotency checks
          // that scan `timeline.events` (e.g. recordDiagnosisOccurrence) can
          // be exercised against this fake without a real SQLite store.
          events: committedTransitions.map((event) => ({
            eventOrdinal: event.eventOrdinal,
            eventKey: event.eventKey,
            kind: event.kind,
            fromStatus: event.fromStatus,
            toStatus: event.toStatus,
            occurredAt: event.occurredAt,
            accuracy: event.accuracy,
            errorCode: event.errorCode,
            errorMessage: event.errorMessage,
            errorDetailKey: event.errorDetailKey,
            errorDetailParams: event.errorDetailParams,
          })),
        },
      }
    }),
  }
  return store
}

describe('TaskInspectorActivityRuntime', () => {
  it('assigns a stable ordinal/key once and reuses the pair on retry', async () => {
    const store = createStore(4)
    store.failNextTransition()
    const runtime = new TaskInspectorActivityRuntime(store, new EventBus(), {
      runtimeGeneration: 'generation-a',
      wallNow: () => 100,
      monotonicNow: () => 200,
    })

    await runtime.recordTransition({
      taskId: 'task-1',
      previousStatus: TaskStatus.Downloading,
      nextStatus: TaskStatus.Paused,
      occurredAt: 100,
      monotonicAt: 200,
      accuracy: 'exact',
      errorCode: null,
      errorMessage: null,
    })
    await runtime.recordTransition({
      taskId: 'task-1',
      previousStatus: TaskStatus.Paused,
      nextStatus: TaskStatus.Downloading,
      occurredAt: 101,
      monotonicAt: 201,
      accuracy: 'exact',
      errorCode: null,
      errorMessage: null,
    })

    expect(store.transitions.map((event) => event.eventOrdinal)).toEqual([
      5, 5, 6,
    ])
    expect(store.transitions[1].eventKey).toBe(store.transitions[0].eventKey)
    expect(store.transitions[0].delivery).toBe(TaskHistoryDelivery.Initial)
    expect(store.transitions[1].delivery).toBe(TaskHistoryDelivery.Retry)
    expect(store.transitions[2].eventKey).not.toBe(
      store.transitions[0].eventKey
    )
  })

  it('derives semantic event kinds in core and emits committed revisions', async () => {
    const store = createStore()
    const eventBus = new EventBus()
    const updates = vi.fn()
    eventBus.on(Events.TaskInspectorActivityUpdated, updates)
    const runtime = new TaskInspectorActivityRuntime(store, eventBus, {
      runtimeGeneration: 'generation-a',
    })

    await runtime.recordTransition({
      taskId: 'task-1',
      previousStatus: TaskStatus.Downloading,
      nextStatus: TaskStatus.Error,
      occurredAt: 100,
      monotonicAt: 200,
      accuracy: 'exact',
      errorCode: DownloadErrorCode.NetworkError,
      errorMessage: 'failed',
    })

    expect(store.transitions[0]).toMatchObject({
      kind: TaskHistoryEventKind.Failed,
      accuracy: TaskHistoryAccuracy.Exact,
      errorCode: DownloadErrorCode.NetworkError,
      errorMessage: 'failed',
    })
    expect(updates).toHaveBeenCalledWith({
      taskId: 'task-1',
      revision: 1,
      reason: TaskInspectorActivityUpdateReason.Transition,
    })
  })

  it('normalizes fractional monotonic clock readings at the durable event boundary', async () => {
    const store = createStore()
    const runtime = new TaskInspectorActivityRuntime(store, new EventBus(), {
      runtimeGeneration: 'generation-a',
      monotonicNow: () => 123.456,
    })
    const task = makeDownloadTask({
      id: 'task-1',
      createdAt: 100,
      status: TaskStatus.Downloading,
    })

    await runtime.parentTaskCreated(task, () => undefined)
    await runtime.recordTransition({
      taskId: task.id,
      previousStatus: TaskStatus.Downloading,
      nextStatus: TaskStatus.Paused,
      occurredAt: 101,
      monotonicAt: 124.6,
      accuracy: 'exact',
      errorCode: null,
      errorMessage: null,
    })

    expect(
      store.committedTransitions.map((event) => event.occurredMonotonicMs)
    ).toEqual([123, 125])
    expect(store.committedTransitions.map((event) => event.kind)).toEqual([
      TaskHistoryEventKind.Added,
      TaskHistoryEventKind.Paused,
    ])
  })

  it('normalizes an empty error message before durable validation', async () => {
    const store = createStore()
    const runtime = new TaskInspectorActivityRuntime(store, new EventBus(), {
      runtimeGeneration: 'generation-a',
    })

    await runtime.recordTransition({
      taskId: 'task-1',
      previousStatus: TaskStatus.Downloading,
      nextStatus: TaskStatus.Completed,
      occurredAt: 100,
      monotonicAt: 200,
      accuracy: 'exact',
      errorCode: null,
      errorMessage: '',
    })
    await runtime.dispose()

    expect(store.transitions).toHaveLength(1)
    expect(store.transitions[0]).toMatchObject({
      kind: TaskHistoryEventKind.Completed,
      errorMessage: null,
    })
  })

  it('rejects obsolete runtime generations before the store boundary', () => {
    const store = createStore()
    const runtime = new TaskInspectorActivityRuntime(store, new EventBus(), {
      runtimeGeneration: 'current',
    })
    const replay: TaskHistoryEventInput = {
      taskId: 'task-1',
      runtimeGeneration: 'obsolete',
      eventOrdinal: 1,
      eventKey: 'obsolete:1',
      kind: TaskHistoryEventKind.Paused,
      fromStatus: TaskStatus.Downloading,
      toStatus: TaskStatus.Paused,
      occurredAt: 100,
      occurredMonotonicMs: 200,
      accuracy: TaskHistoryAccuracy.Exact,
      delivery: TaskHistoryDelivery.Retry,
      errorCode: null,
      errorMessage: null,
      errorDetailKey: null,
      errorDetailParams: null,
    }

    expect(() => runtime.deliverAssignedTransition(replay)).toThrow(
      'obsolete runtime generation'
    )
    expect(store.recordTransition).not.toHaveBeenCalled()
  })

  it('records one recovered anchor per task after authoritative hydration', async () => {
    const store = createStore()
    const runtime = new TaskInspectorActivityRuntime(store, new EventBus(), {
      runtimeGeneration: 'generation-a',
      wallNow: () => 100,
      monotonicNow: () => 200,
    })
    const task = makeDownloadTask({
      id: 'task-1',
      status: TaskStatus.Downloading,
    })

    const anchorOrigins = runtime.captureRecoveredAnchorOrigins([task])
    await runtime.recordRecoveredAnchors([task], anchorOrigins)
    await runtime.recordRecoveredAnchors([task], anchorOrigins)

    expect(store.transitions).toHaveLength(1)
    expect(store.transitions[0]).toMatchObject({
      kind: TaskHistoryEventKind.ObservedState,
      accuracy: TaskHistoryAccuracy.Recovered,
      fromStatus: null,
      toStatus: TaskStatus.Downloading,
    })
    expect(store.checkpointBatch).toHaveBeenCalledWith([
      expect.objectContaining({
        taskId: 'task-1',
        coverageGapAt: 1,
      }),
    ])
  })

  it.each([TaskStatus.Completed, TaskStatus.Error, TaskStatus.Removed])(
    'does not append a startup recovered anchor for an unchanged terminal task: %s',
    async (status) => {
      const store = createStore()
      const task = makeDownloadTask({ id: 'task-1', status })

      for (const runtimeGeneration of ['generation-a', 'generation-b']) {
        const runtime = new TaskInspectorActivityRuntime(
          store,
          new EventBus(),
          {
            runtimeGeneration,
            wallNow: () => 100,
            monotonicNow: () => 200,
          }
        )
        const anchorOrigins = runtime.captureRecoveredAnchorOrigins([task])
        await runtime.recordRecoveredAnchors([task], anchorOrigins)
        await runtime.dispose()
      }

      expect(store.recordTransition).not.toHaveBeenCalled()
      expect(store.checkpointBatch).not.toHaveBeenCalled()
    }
  )

  it('anchors the first authoritative poll after reconnect even when status is unchanged', async () => {
    const store = createStore()
    let now = 100
    const eventBus = new EventBus()
    const runtime = new TaskInspectorActivityRuntime(store, eventBus, {
      runtimeGeneration: 'generation-a',
      wallNow: () => now,
      monotonicNow: () => now,
    })
    const task = makeDownloadTask({
      id: 'task-1',
      status: TaskStatus.Downloading,
    })
    runtime.recordSamples([task])

    now = 200
    eventBus.emit(Events.EngineDisconnected)
    eventBus.emit(Events.EngineRecovered)
    eventBus.emit(Events.EngineRecovered)
    now = 300

    await runtime.recordAuthoritativeReconnectAnchors([task])
    runtime.recordSamples([task])
    await runtime.recordAuthoritativeReconnectAnchors([task])
    runtime.recordSamples([task])

    expect(
      store.committedTransitions.filter(
        (event) => event.kind === TaskHistoryEventKind.ObservedState
      )
    ).toHaveLength(1)
    expect(store.committedTransitions.at(-1)).toMatchObject({
      fromStatus: null,
      toStatus: TaskStatus.Downloading,
      occurredAt: 300,
      accuracy: TaskHistoryAccuracy.Recovered,
    })
    expect(store.checkpointBatch).toHaveBeenCalledWith([
      expect.objectContaining({
        taskId: 'task-1',
        coverageGapAt: 200,
      }),
    ])
  })

  it('isolates a poisoned recovered transition and retries the same event exactly once', async () => {
    const store = createStore()
    store.failNextTransition()
    const runtime = new TaskInspectorActivityRuntime(store, new EventBus(), {
      runtimeGeneration: 'generation-a',
      wallNow: () => 100,
      monotonicNow: () => 200,
    })
    const first = makeDownloadTask({
      id: 'task-1',
      status: TaskStatus.Downloading,
    })
    const second = makeDownloadTask({
      id: 'task-2',
      status: TaskStatus.Paused,
    })
    const origins = new Map([
      ['task-1', { gapAt: null, status: TaskStatus.Downloading }],
      ['task-2', { gapAt: null, status: TaskStatus.Paused }],
    ])

    await runtime.recordRecoveredAnchors([first, second], origins)
    await runtime.recordRecoveredAnchors([first, second], origins)

    const firstAttempts = store.transitions.filter(
      (event) => event.taskId === 'task-1'
    )
    expect(firstAttempts).toHaveLength(2)
    expect(firstAttempts[1]).toMatchObject({
      eventKey: firstAttempts[0]?.eventKey,
      eventOrdinal: firstAttempts[0]?.eventOrdinal,
      delivery: TaskHistoryDelivery.Retry,
    })
    expect(
      store.committedTransitions.filter(
        (event) =>
          event.taskId === 'task-1' &&
          event.kind === TaskHistoryEventKind.ObservedState
      )
    ).toHaveLength(1)
    expect(
      store.transitions.filter((event) => event.taskId === 'task-2')
    ).toHaveLength(1)
  })

  it('retries a failed recovered gap checkpoint without duplicating observed_state', async () => {
    const store = createStore()
    store.failNextCheckpoint()
    const runtime = new TaskInspectorActivityRuntime(store, new EventBus(), {
      runtimeGeneration: 'generation-a',
      wallNow: () => 100,
      monotonicNow: () => 200,
    })
    const task = makeDownloadTask({
      id: 'task-1',
      status: TaskStatus.Downloading,
    })
    const origins = new Map([
      ['task-1', { gapAt: 50, status: TaskStatus.Downloading }],
    ])

    await runtime.recordRecoveredAnchors([task], origins)
    expect(store.recordTransition).not.toHaveBeenCalled()
    await runtime.recordRecoveredAnchors([task], origins)

    expect(store.checkpointBatch).toHaveBeenCalledTimes(2)
    expect(
      store.committedTransitions.filter(
        (event) => event.kind === TaskHistoryEventKind.ObservedState
      )
    ).toHaveLength(1)
  })

  it('releases a frozen reconnect task when that parent is deleted during anchor retry', async () => {
    const store = createStore()
    store.failNextTransition()
    const eventBus = new EventBus()
    const runtime = new TaskInspectorActivityRuntime(store, eventBus, {
      runtimeGeneration: 'generation-a',
      wallNow: () => 100,
      monotonicNow: () => 200,
    })
    const removed = makeDownloadTask({
      id: 'task-1',
      status: TaskStatus.Downloading,
    })
    const healthy = makeDownloadTask({
      id: 'task-2',
      status: TaskStatus.Downloading,
    })

    eventBus.emit(Events.EngineDisconnected)
    await runtime.recordAuthoritativeReconnectAnchors([removed, healthy])
    await runtime.deleteParentTask(removed.id, async () => {})

    expect(
      (
        runtime as unknown as {
          pendingReconnect: unknown
        }
      ).pendingReconnect
    ).toBeNull()
  })

  it('tombstones before parent deletion and ignores late producers', async () => {
    const store = createStore()
    const runtime = new TaskInspectorActivityRuntime(store, new EventBus(), {
      runtimeGeneration: 'generation-a',
    })
    const order: string[] = []

    await runtime.deleteParentTask('task-1', async () => {
      order.push('parent-delete')
    })
    await runtime.recordTransition({
      taskId: 'task-1',
      previousStatus: TaskStatus.Downloading,
      nextStatus: TaskStatus.Completed,
      occurredAt: 100,
      monotonicAt: 200,
      accuracy: 'exact',
      errorCode: null,
      errorMessage: null,
    })

    expect(order).toEqual(['parent-delete'])
    expect(store.recordTransition).not.toHaveBeenCalled()
  })

  it('tombstones a batch before invoking its parent deletion callback', async () => {
    const store = createStore()
    const runtime = new TaskInspectorActivityRuntime(store, new EventBus(), {
      runtimeGeneration: 'generation-a',
    })
    const order: string[] = []

    await runtime.deleteParentTasks(['task-1', 'task-2'], async () => {
      order.push('parent-delete')
      await runtime.recordTransition({
        taskId: 'task-2',
        previousStatus: TaskStatus.Downloading,
        nextStatus: TaskStatus.Completed,
        occurredAt: 100,
        monotonicAt: 200,
        accuracy: 'exact',
        errorCode: null,
        errorMessage: null,
      })
    })

    expect(order).toEqual(['parent-delete'])
    expect(store.recordTransition).not.toHaveBeenCalled()
  })

  it('revives a task when parent deletion fails', async () => {
    const store = createStore()
    const runtime = new TaskInspectorActivityRuntime(store, new EventBus(), {
      runtimeGeneration: 'generation-a',
    })

    await expect(
      runtime.deleteParentTasks(['task-1'], () => {
        throw new Error('database busy')
      })
    ).rejects.toThrow('database busy')

    await runtime.recordTransition({
      taskId: 'task-1',
      previousStatus: TaskStatus.Downloading,
      nextStatus: TaskStatus.Paused,
      occurredAt: 100,
      monotonicAt: 200,
      accuracy: 'exact',
      errorCode: null,
      errorMessage: null,
    })
    expect(store.recordTransition).toHaveBeenCalledOnce()
  })

  it('queues and replays a transition when parent deletion rolls back', async () => {
    const store = createStore()
    const runtime = new TaskInspectorActivityRuntime(store, new EventBus(), {
      runtimeGeneration: 'generation-a',
    })
    let rejectDelete!: () => void
    const deleteGate = new Promise<void>((_resolve, reject) => {
      rejectDelete = () => reject(new Error('database busy'))
    })
    const deleting = runtime.deleteParentTask('task-1', () => deleteGate)
    await Promise.resolve()

    const transition = runtime.recordTransition({
      taskId: 'task-1',
      previousStatus: TaskStatus.Downloading,
      nextStatus: TaskStatus.Paused,
      occurredAt: 100,
      monotonicAt: 200,
      accuracy: 'exact',
      errorCode: null,
      errorMessage: null,
    })
    rejectDelete()

    await expect(deleting).rejects.toThrow('database busy')
    await transition

    expect(store.recordTransition).toHaveBeenCalledOnce()
    expect(store.transitions[0]).toMatchObject({
      kind: TaskHistoryEventKind.Paused,
      fromStatus: TaskStatus.Downloading,
      toStatus: TaskStatus.Paused,
    })
  })

  it('shares one dispose promise and gates late samples', async () => {
    const store = createStore()
    const runtime = new TaskInspectorActivityRuntime(store, new EventBus(), {
      runtimeGeneration: 'generation-a',
    })
    const dispose = runtime.dispose()
    expect(runtime.dispose()).toBe(dispose)
    await dispose

    runtime.recordSamples([
      makeDownloadTask({
        id: 'task-1',
        status: TaskStatus.Downloading,
        downloadSpeed: 100,
      }),
    ])

    expect(store.checkpointBatch).not.toHaveBeenCalled()
  })

  it('drains transitions accepted before dispose even when they were queued', async () => {
    const store = createStore()
    const runtime = new TaskInspectorActivityRuntime(store, new EventBus(), {
      runtimeGeneration: 'generation-a',
      monotonicNow: () => 10,
    })
    const task = makeDownloadTask({
      id: 'task-1',
      createdAt: 10,
      status: TaskStatus.Downloading,
    })
    let releaseParent!: () => void
    const parentGate = new Promise<void>((resolve) => {
      releaseParent = resolve
    })
    const creating = runtime.parentTaskCreated(task, () => parentGate)
    await Promise.resolve()
    const queued = runtime.recordTransition({
      taskId: 'task-1',
      previousStatus: TaskStatus.Downloading,
      nextStatus: TaskStatus.Paused,
      occurredAt: 20,
      monotonicAt: 20,
      accuracy: 'exact',
      errorCode: null,
      errorMessage: null,
    })
    const disposing = runtime.dispose()

    releaseParent()
    await Promise.all([creating, queued, disposing])

    expect(store.transitions.map((event) => event.kind)).toEqual([
      TaskHistoryEventKind.Added,
      TaskHistoryEventKind.Paused,
    ])
  })

  it('marks an existing durable history gap from its last committed update on restart', async () => {
    const store = createStore(3)
    const existing = snapshot(3)
    existing.summary.updatedAt = 1_234
    existing.lifetime.updatedAt = 1_234
    vi.mocked(store.snapshot).mockReturnValue(existing)
    const runtime = new TaskInspectorActivityRuntime(store, new EventBus(), {
      runtimeGeneration: 'generation-b',
      wallNow: () => 9_000,
      monotonicNow: () => 500,
    })

    const anchorOrigins = runtime.captureRecoveredAnchorOrigins([
      makeDownloadTask({
        id: 'task-1',
        status: TaskStatus.Downloading,
      }),
    ])
    await runtime.recordRecoveredAnchors(
      [
        makeDownloadTask({
          id: 'task-1',
          status: TaskStatus.Downloading,
        }),
      ],
      anchorOrigins
    )

    expect(store.checkpointBatch).toHaveBeenCalledWith([
      expect.objectContaining({
        taskId: 'task-1',
        coverageGapAt: 1_234,
      }),
    ])
    expect(store.transitions.at(-1)).toMatchObject({
      kind: TaskHistoryEventKind.ObservedState,
      occurredAt: 9_000,
    })
  })

  it('keeps the pre-recovery durable gap origin when recovery advances updatedAt', async () => {
    const store = createStore(3)
    const beforeRecovery = snapshot(3)
    beforeRecovery.summary.updatedAt = 2_000
    beforeRecovery.lifetime.updatedAt = 2_000
    vi.mocked(store.snapshot).mockReturnValue(beforeRecovery)
    const runtime = new TaskInspectorActivityRuntime(store, new EventBus(), {
      runtimeGeneration: 'generation-b',
      wallNow: () => 9_000,
      monotonicNow: () => 500,
    })
    const task = makeDownloadTask({
      id: 'task-1',
      status: TaskStatus.Finalizing,
    })

    const anchorOrigins = runtime.captureRecoveredAnchorOrigins([task])
    const afterRecovery = snapshot(4)
    afterRecovery.summary.updatedAt = 8_000
    afterRecovery.lifetime.updatedAt = 8_000
    vi.mocked(store.snapshot).mockReturnValue(afterRecovery)
    task.status = TaskStatus.Completed

    await runtime.recordRecoveredAnchors([task], anchorOrigins)

    expect(store.checkpointBatch).toHaveBeenCalledWith([
      expect.objectContaining({
        taskId: 'task-1',
        coverageGapAt: 2_000,
      }),
    ])
    expect(store.transitions.at(-1)).toMatchObject({
      kind: TaskHistoryEventKind.ObservedState,
      toStatus: TaskStatus.Completed,
      occurredAt: 9_000,
    })
  })

  it('isolates a failed pre-recovery snapshot and still records observed state', async () => {
    const store = createStore()
    const onError = vi.fn()
    vi.mocked(store.snapshot)
      .mockImplementationOnce(() => {
        throw new Error('snapshot unavailable')
      })
      .mockReturnValue(snapshot())
    const runtime = new TaskInspectorActivityRuntime(store, new EventBus(), {
      runtimeGeneration: 'generation-a',
      wallNow: () => 9_000,
      monotonicNow: () => 500,
      onError,
    })
    const task = makeDownloadTask({
      id: 'task-1',
      status: TaskStatus.Downloading,
    })

    const anchorOrigins = runtime.captureRecoveredAnchorOrigins([task])
    await expect(
      runtime.recordRecoveredAnchors([task], anchorOrigins)
    ).resolves.toBeUndefined()

    expect(onError).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({
        operation: 'capture_recovered_anchor',
        taskId: 'task-1',
      })
    )
    expect(store.checkpointBatch).not.toHaveBeenCalled()
    expect(store.transitions.at(-1)).toMatchObject({
      kind: TaskHistoryEventKind.ObservedState,
      accuracy: TaskHistoryAccuracy.Recovered,
    })
  })

  it('records a first-v3 recovered observed state without inventing a coverage gap', async () => {
    const store = createStore()
    vi.mocked(store.snapshot)
      .mockReturnValueOnce(null)
      .mockReturnValue(snapshot())
    const runtime = new TaskInspectorActivityRuntime(store, new EventBus(), {
      runtimeGeneration: 'generation-a',
      wallNow: () => 9_000,
      monotonicNow: () => 500,
    })

    const task = makeDownloadTask({
      id: 'task-1',
      status: TaskStatus.Downloading,
    })
    const anchorOrigins = runtime.captureRecoveredAnchorOrigins([task])
    await runtime.recordRecoveredAnchors([task], anchorOrigins)

    expect(store.checkpointBatch).not.toHaveBeenCalled()
    expect(store.transitions).toHaveLength(1)
    expect(store.transitions[0]).toMatchObject({
      kind: TaskHistoryEventKind.ObservedState,
      accuracy: TaskHistoryAccuracy.Recovered,
    })
  })

  it('retries pending exact history before disposal clears producer state', async () => {
    const store = createStore()
    store.failNextTransition()
    const runtime = new TaskInspectorActivityRuntime(store, new EventBus(), {
      runtimeGeneration: 'generation-a',
    })
    await runtime.recordTransition({
      taskId: 'task-1',
      previousStatus: TaskStatus.Downloading,
      nextStatus: TaskStatus.Paused,
      occurredAt: 100,
      monotonicAt: 200,
      accuracy: 'exact',
      errorCode: null,
      errorMessage: null,
    })

    await runtime.dispose()

    expect(store.transitions).toHaveLength(2)
    expect(store.transitions[1]).toMatchObject({
      eventOrdinal: store.transitions[0].eventOrdinal,
      eventKey: store.transitions[0].eventKey,
      delivery: TaskHistoryDelivery.Retry,
    })
  })

  it('buffers pre-parent transitions and replays them after parent durability', async () => {
    const store = createStore()
    let parentDurable = false
    vi.mocked(store.ensureTask).mockImplementation(() => {
      if (!parentDurable) throw new Error('FOREIGN KEY constraint failed')
    })
    const runtime = new TaskInspectorActivityRuntime(store, new EventBus(), {
      runtimeGeneration: 'generation-a',
      monotonicNow: () => 50,
    })
    const task = makeDownloadTask({
      id: 'task-1',
      createdAt: 10,
      status: TaskStatus.Downloading,
    })

    await expect(
      runtime.recordTransition({
        taskId: 'task-1',
        previousStatus: TaskStatus.Downloading,
        nextStatus: TaskStatus.Paused,
        occurredAt: 20,
        monotonicAt: 60,
        accuracy: 'exact',
        errorCode: null,
        errorMessage: null,
      })
    ).resolves.toBeUndefined()
    expect(store.recordTransition).not.toHaveBeenCalled()

    await runtime.parentTaskCreated(task, () => {
      parentDurable = true
    })

    expect(store.transitions.map((event) => event.kind)).toEqual([
      TaskHistoryEventKind.Added,
      TaskHistoryEventKind.Paused,
    ])
    expect(store.transitions.map((event) => event.eventOrdinal)).toEqual([1, 2])
  })

  it('does not turn a durable parent creation into a domain failure when Activity ensure fails', async () => {
    const store = createStore()
    vi.mocked(store.ensureTask).mockImplementation(() => {
      throw new Error('activity database busy')
    })
    const onError = vi.fn()
    const runtime = new TaskInspectorActivityRuntime(store, new EventBus(), {
      onError,
    })
    const persistParent = vi.fn().mockResolvedValue(undefined)

    await expect(
      runtime.parentTaskCreated(
        makeDownloadTask({
          id: 'task-1',
          status: TaskStatus.Downloading,
        }),
        persistParent
      )
    ).resolves.toBeUndefined()

    expect(persistParent).toHaveBeenCalledOnce()
    expect(onError).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({
        operation: 'buffer_parent_created_transition',
        taskId: 'task-1',
      })
    )
  })

  it('rejects snapshots after disposal without touching SQLite', async () => {
    const store = createStore()
    const runtime = new TaskInspectorActivityRuntime(store, new EventBus(), {
      runtimeGeneration: 'generation-a',
    })
    await runtime.dispose()
    vi.mocked(store.snapshot).mockClear()

    expect(() => runtime.snapshot('task-1')).toThrow('disposed')
    expect(store.snapshot).not.toHaveBeenCalled()
  })

  it('persists errorDetailKey/errorDetailParams and bounds oversized values', async () => {
    const store = createStore()
    const runtime = new TaskInspectorActivityRuntime(store, new EventBus(), {
      runtimeGeneration: 'generation-a',
    })

    await runtime.recordTransition({
      taskId: 'task-1',
      previousStatus: TaskStatus.Downloading,
      nextStatus: TaskStatus.Error,
      occurredAt: 100,
      monotonicAt: 200,
      accuracy: 'exact',
      errorCode: DownloadErrorCode.DiskFull,
      errorMessage: 'ENOSPC',
      errorDetailKey: 'task.error.detail.filesMissing',
      errorDetailParams: { cause: 'missing' },
    })

    expect(store.transitions[0]).toMatchObject({
      errorDetailKey: 'task.error.detail.filesMissing',
      errorDetailParams: { cause: 'missing' },
    })

    await runtime.recordTransition({
      taskId: 'task-2',
      previousStatus: TaskStatus.Downloading,
      nextStatus: TaskStatus.Error,
      occurredAt: 100,
      monotonicAt: 200,
      accuracy: 'exact',
      errorCode: null,
      errorMessage: null,
      errorDetailKey: 'x'.repeat(200),
      errorDetailParams: { cause: 'x'.repeat(3_000) },
    })

    expect(store.transitions[1]).toMatchObject({
      errorDetailKey: 'x'.repeat(128),
      errorDetailParams: null,
    })
  })

  it('appends exactly one item when a diagnosis occurrence is dispatched twice', async () => {
    const store = createStore()
    const runtime = new TaskInspectorActivityRuntime(store, new EventBus(), {
      runtimeGeneration: 'generation-a',
      wallNow: () => 500,
      monotonicNow: () => 500,
    })
    const occurrence = makeDiagnosisOccurrence()

    await runtime.recordDiagnosisOccurrence(occurrence)
    await runtime.recordDiagnosisOccurrence(occurrence)

    const appended = store.committedTransitions.filter(
      (event) => event.eventKey === occurrence.occurrenceId
    )
    expect(appended).toHaveLength(1)
    expect(appended[0]).toMatchObject({
      kind: TaskHistoryEventKind.Failed,
      fromStatus: TaskStatus.Error,
      toStatus: TaskStatus.Error,
      errorCode: DownloadErrorCode.DiskFull,
      errorDetailKey: 'task.error.detail.filesMissing',
    })
  })

  it('rejects when the diagnosis item cannot be persisted', async () => {
    const store = createStore()
    const runtime = new TaskInspectorActivityRuntime(store, new EventBus(), {
      runtimeGeneration: 'generation-a',
    })
    store.failNextTransition()

    await expect(
      runtime.recordDiagnosisOccurrence(makeDiagnosisOccurrence())
    ).rejects.toThrow('database busy')
    expect(store.committedTransitions).toHaveLength(0)
  })

  it('appends the Failed item for a terminal occurrence replayed from the outbox', async () => {
    const store = createStore()
    const runtime = new TaskInspectorActivityRuntime(store, new EventBus(), {
      runtimeGeneration: 'generation-a',
    })
    const terminal = makeTerminalOccurrence()

    await runtime.recordOccurrence(terminal)
    await runtime.recordOccurrence(terminal)

    const appended = store.committedTransitions.filter(
      (event) => event.eventKey === terminal.occurrenceId
    )
    expect(appended).toHaveLength(1)
    expect(appended[0]).toMatchObject({
      kind: TaskHistoryEventKind.Failed,
      fromStatus: TaskStatus.Downloading,
      toStatus: TaskStatus.Error,
      errorCode: DownloadErrorCode.DiskFull,
      errorDetailKey: 'task.error.detail.filesMissing',
    })
  })

  it('appends the Completed item for a terminal completion occurrence', async () => {
    const store = createStore()
    const runtime = new TaskInspectorActivityRuntime(store, new EventBus(), {
      runtimeGeneration: 'generation-a',
    })

    await runtime.recordOccurrence(
      makeTerminalOccurrence({
        occurrenceId: 'task-1:completed:100',
        toStatus: TaskStatus.Completed,
        errorGroup: null,
      })
    )

    expect(store.committedTransitions).toHaveLength(1)
    expect(store.committedTransitions[0]).toMatchObject({
      kind: TaskHistoryEventKind.Completed,
      toStatus: TaskStatus.Completed,
      errorCode: null,
      errorDetailKey: null,
    })
  })

  it('appends exactly one item when the live transition already used the occurrence id', async () => {
    const store = createStore()
    const runtime = new TaskInspectorActivityRuntime(store, new EventBus(), {
      runtimeGeneration: 'generation-a',
    })
    const terminal = makeTerminalOccurrence()

    // Live commit path: commitTaskUpdate threads the occurrence id into the
    // transition record, then dispatches the occurrence to this consumer.
    await runtime.recordTransition({
      taskId: terminal.taskId,
      previousStatus: TaskStatus.Downloading,
      nextStatus: TaskStatus.Error,
      occurredAt: terminal.createdAt,
      monotonicAt: 10,
      accuracy: 'exact',
      errorCode: DownloadErrorCode.DiskFull,
      errorMessage: null,
      errorDetailKey: 'task.error.detail.filesMissing',
      errorDetailParams: null,
      occurrenceId: terminal.occurrenceId,
    })
    await runtime.recordOccurrence(terminal)

    expect(
      store.committedTransitions.filter(
        (event) => event.eventKey === terminal.occurrenceId
      )
    ).toHaveLength(1)
  })

  it('rejects when the terminal item cannot be persisted', async () => {
    const store = createStore()
    const runtime = new TaskInspectorActivityRuntime(store, new EventBus(), {
      runtimeGeneration: 'generation-a',
    })
    store.failNextTransition()

    await expect(
      runtime.recordOccurrence(makeTerminalOccurrence())
    ).rejects.toThrow('database busy')
    expect(store.committedTransitions).toHaveLength(0)
  })
})
