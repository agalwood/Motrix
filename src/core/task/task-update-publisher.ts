import { Events } from '@shared/protocol/events'
import type { EventBus } from '../events/event-bus'
import type { TaskManager } from './task-manager'

/**
 * Trailing coalescing window for TaskUpdated broadcasts. One bulk action
 * commits hundreds of tasks within a few milliseconds; every commit inside
 * this window collapses into a single snapshot emit at its end. 16 ms is
 * below one animation frame and two orders of magnitude below the 1 Hz poll
 * cadence; measured against 2 ms-latency engine RPCs it already collapses a
 * 200-task burst into one emit (see
 * docs/superpowers/specs/2026-08-07-task-updated-emit-coalescing-design.md).
 */
export const TASK_UPDATED_COALESCE_MS = 16

/**
 * Injectable timer so tests can drive the trailing window deterministically.
 * Defaults to setTimeout/clearTimeout.
 */
export interface TaskUpdateScheduler {
  set(fn: () => void, ms: number): unknown
  clear(handle: unknown): void
}

export interface TaskUpdatePublisherDeps {
  taskManager: Pick<TaskManager, 'getAll'>
  eventBus: Pick<EventBus, 'emit'>
}

export interface TaskUpdatePublisherOptions {
  windowMs?: number
  scheduler?: TaskUpdateScheduler
}

const defaultScheduler: TaskUpdateScheduler = {
  set: (fn, ms) => setTimeout(fn, ms),
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
}

/**
 * Trailing, last-wins coalescer for `Events.TaskUpdated`.
 *
 * Takes no payload: the snapshot is built via `taskManager.getAll()` when the
 * window fires, so only intermediate snapshots are dropped — the newest state
 * is always the one delivered. Terminal transitions are sticky (a Completed
 * task stays Completed in every later snapshot) and deletions are absences
 * (a removed id is missing from every later snapshot), so the terminal /
 * removal invariants hold structurally. Callers that must not wait out the
 * window (terminal occurrences, shutdown) use `publishNow()` / `flush()`.
 *
 * Contrast with `MediaTaskCoordinator.emitUpdate`, a leading-edge
 * drop-throttle that discards in-window calls outright and therefore needs
 * its `force` escape hatch.
 */
export class TaskUpdatePublisher {
  private readonly windowMs: number
  private readonly scheduler: TaskUpdateScheduler
  private pendingHandle: unknown = null
  private hasPending = false

  constructor(
    private readonly deps: TaskUpdatePublisherDeps,
    options: TaskUpdatePublisherOptions = {}
  ) {
    this.windowMs = options.windowMs ?? TASK_UPDATED_COALESCE_MS
    this.scheduler = options.scheduler ?? defaultScheduler
  }

  /** Schedule a trailing flush; calls inside an open window coalesce. */
  publish(): void {
    if (this.hasPending) return
    this.hasPending = true
    this.pendingHandle = this.scheduler.set(() => {
      this.hasPending = false
      this.pendingHandle = null
      this.emitSnapshot()
    }, this.windowMs)
  }

  /**
   * Emit immediately, absorbing any pending window. Used for terminal
   * commits so emit-before-occurrence-dispatch ordering is preserved.
   */
  publishNow(): void {
    this.cancelPending()
    this.emitSnapshot()
  }

  /** Drain a pending snapshot, if any. For shutdown. */
  flush(): void {
    if (!this.hasPending) return
    this.cancelPending()
    this.emitSnapshot()
  }

  private cancelPending(): void {
    if (!this.hasPending) return
    this.scheduler.clear(this.pendingHandle)
    this.hasPending = false
    this.pendingHandle = null
  }

  private emitSnapshot(): void {
    this.deps.eventBus.emit(Events.TaskUpdated, this.deps.taskManager.getAll())
  }
}
