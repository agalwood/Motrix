import type { EventChannel } from '@shared/protocol/events'
import { Events } from '@shared/protocol/events'
import {
  type GetTaskActivityParams,
  TaskActivityAccuracy,
  TaskActivityKind,
  type TaskActivityRecorder,
  type TaskActivitySnapshot,
  type TaskActivityUpdatedPayload,
} from '@shared/types/task-activity'
import type {
  TaskActivityInsertResult,
  TaskActivityRecordInput,
  TaskActivityStore,
} from './task-activity-store'
import { parseGetTaskActivityParams } from './validators'

interface ActivityEventEmitter {
  emit(channel: EventChannel, ...args: unknown[]): void
}

export type TaskActivityServiceOperation =
  | 'record'
  | 'persist_coverage_gap'
  | 'emit_update'

export interface TaskActivityServiceOptions {
  onError?: (
    error: unknown,
    context: { operation: TaskActivityServiceOperation }
  ) => void
  now?: () => number
}

export const NOOP_TASK_ACTIVITY_RECORDER: TaskActivityRecorder = Object.freeze({
  recordSubmitted(): void {},
  recordDownloadCompleted(): void {},
})

/**
 * Best-effort lifecycle recorder plus strict query facade.
 *
 * Write and notification failures never escape into task lifecycle code.
 * Query validation and read failures intentionally remain visible to callers.
 */
export class TaskActivityService implements TaskActivityRecorder {
  private readonly onError: NonNullable<TaskActivityServiceOptions['onError']>
  private readonly now: () => number
  private pendingCoverageGapAt: number | null = null

  constructor(
    private readonly store: TaskActivityStore,
    private readonly eventEmitter: ActivityEventEmitter,
    options: TaskActivityServiceOptions = {}
  ) {
    this.onError = options.onError ?? (() => {})
    this.now = options.now ?? Date.now
  }

  recordSubmitted(input: { taskId: string; occurredAt: number }): void {
    this.recordBestEffort({
      taskId: input.taskId,
      kind: TaskActivityKind.Submitted,
      occurredAt: input.occurredAt,
      accuracy: TaskActivityAccuracy.Exact,
    })
  }

  recordDownloadCompleted(input: {
    taskId: string
    occurredAt: number
    accuracy?: TaskActivityAccuracy
  }): void {
    this.recordBestEffort({
      taskId: input.taskId,
      kind: TaskActivityKind.DownloadCompleted,
      occurredAt: input.occurredAt,
      accuracy: input.accuracy ?? TaskActivityAccuracy.Exact,
    })
  }

  snapshot(params: GetTaskActivityParams): TaskActivitySnapshot {
    const validated = parseGetTaskActivityParams(params)
    this.flushPendingCoverageGap()
    const snapshot = this.store.snapshot(validated.days)
    const pendingGapAt = this.pendingCoverageGapAt
    if (pendingGapAt === null) return snapshot

    const durableGapAt = snapshot.coverage.coverageGapAt
    const coverageGapAt =
      durableGapAt === null
        ? pendingGapAt
        : Math.min(durableGapAt, pendingGapAt)
    if (coverageGapAt === durableGapAt) return snapshot

    return {
      ...snapshot,
      coverage: {
        ...snapshot.coverage,
        coverageGapAt,
      },
    }
  }

  // Every callee is self-guarding, so a store failure is the only escape
  // path and lifecycle callers never observe an exception.
  private recordBestEffort(input: TaskActivityRecordInput): void {
    this.flushPendingCoverageGap()

    let result: TaskActivityInsertResult | null
    try {
      result = this.store.record(input)
    } catch (error) {
      this.rememberCoverageGap(input.occurredAt)
      this.reportError(error, 'record')
      this.flushPendingCoverageGap()
      return
    }

    if (result) {
      this.emitUpdate({
        type: 'inserted',
        generation: result.generation,
        revision: result.revision,
        event: result.event,
      })
    }
  }

  private rememberCoverageGap(occurredAt: number): void {
    let fallback = 1
    try {
      const now = this.now()
      if (Number.isSafeInteger(now) && now > 0) {
        fallback = now
      }
    } catch {
      // A clock dependency is observability input, not a lifecycle failure.
    }
    const gapAt =
      Number.isSafeInteger(occurredAt) && occurredAt > 0 ? occurredAt : fallback
    this.pendingCoverageGapAt =
      this.pendingCoverageGapAt === null
        ? gapAt
        : Math.min(this.pendingCoverageGapAt, gapAt)
  }

  private flushPendingCoverageGap(): void {
    const gapAt = this.pendingCoverageGapAt
    if (gapAt === null) return

    try {
      const change = this.store.markCoverageGap(gapAt)
      this.pendingCoverageGapAt = null
      if (change) {
        this.emitUpdate({
          type: 'coverage_degraded',
          generation: change.generation,
          revision: change.revision,
          coverageGapAt: change.coverageGapAt,
        })
      }
    } catch (error) {
      this.reportError(error, 'persist_coverage_gap')
    }
  }

  private emitUpdate(payload: TaskActivityUpdatedPayload): void {
    try {
      this.eventEmitter.emit(Events.TaskActivityUpdated, payload)
    } catch (error) {
      this.reportError(error, 'emit_update')
    }
  }

  private reportError(
    error: unknown,
    operation: TaskActivityServiceOperation
  ): void {
    try {
      this.onError(error, { operation })
    } catch {
      // An observability callback must never become a task lifecycle failure.
    }
  }
}
