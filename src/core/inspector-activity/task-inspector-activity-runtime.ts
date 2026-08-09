import { AsyncLocalStorage } from 'node:async_hooks'
import { randomUUID } from 'node:crypto'
import type { EventBus } from '@core/events/event-bus'
import { Events } from '@shared/protocol/events'
import type { DownloadTask } from '@shared/types/task'
import { TaskStatus } from '@shared/types/task'
import {
  type TaskActivityRevision,
  TaskHistoryAccuracy,
  TaskHistoryDelivery,
  type TaskHistoryEventInput,
  TaskHistoryEventKind,
  type TaskInspectorActivitySnapshot,
  type TaskInspectorActivityUpdatedPayload,
} from '@shared/types/task-inspector-activity'
import type { TaskOccurrence } from '@shared/types/task-occurrence'
import {
  type TaskInspectorActivityPersistence,
  TaskInspectorActivityService,
} from './task-inspector-activity-service'

const ACTIVE_STATUSES = new Set<string>([
  'fetching_metadata',
  'downloading',
  'finalizing',
  'seeding',
])
const TERMINAL_STATUSES = new Set<TaskStatus>([
  TaskStatus.Completed,
  TaskStatus.Error,
  TaskStatus.Removed,
])
const MAX_PRE_PARENT_TRANSITIONS = 32

function boundedNullableText(
  value: string | null,
  maxLength: number
): string | null {
  if (value === null) return null
  const bounded = value.slice(0, maxLength)
  return bounded.length === 0 ? null : bounded
}

/**
 * A JSON object can't be truncated without corrupting its structure, so an
 * oversized `errorDetailParams` degrades to `null` instead — mirroring the
 * repo's validate-on-read convention for malformed detail params.
 */
function boundedNullableParams(
  value: Record<string, string> | null,
  maxJsonLength: number
): Record<string, string> | null {
  if (value === null) return null
  return JSON.stringify(value).length <= maxJsonLength ? value : null
}

export type TaskInspectorActivityRuntimePersistence =
  TaskInspectorActivityPersistence

export interface RuntimeTransitionInput {
  taskId: string
  previousStatus: TaskStatus | null
  nextStatus: TaskStatus
  occurredAt: number
  monotonicAt: number
  accuracy: TaskHistoryAccuracy | 'exact' | 'recovered'
  errorCode: DownloadTask['errorCode']
  errorMessage: string | null
  errorDetailKey?: string | null
  errorDetailParams?: Record<string, string> | null
  /**
   * The terminal occurrence this transition was committed with, when the
   * caller built one. Used verbatim as the history item's `eventKey` so the
   * live commit path and the occurrence-outbox consumer
   * (`recordTerminalOccurrence`) converge on the same row instead of
   * appending the same Completed/Failed item twice.
   */
  occurrenceId?: string | null
}

export interface TaskInspectorActivityRuntimeOptions {
  wallNow?: () => number
  monotonicNow?: () => number
  runtimeGeneration?: string
  onError?: (
    error: unknown,
    context: { operation: string; taskId?: string }
  ) => void
}

interface ProducerState {
  nextOrdinal: number
  pending: TaskHistoryEventInput[]
}

interface PendingRecoveredAnchor {
  generation: number
  gapAt: number | null
  gapDurable: boolean
  input: RuntimeTransitionInput
  event: TaskHistoryEventInput | null
}

interface PendingReconnect {
  generation: number
  gapAt: number
  pollObserved: boolean
  tasks: Map<string, DownloadTask> | null
}

export interface RecoveredAnchorOrigin {
  gapAt: number | null
  status: TaskStatus
}

export type RecoveredAnchorOrigins = ReadonlyMap<string, RecoveredAnchorOrigin>

export class TaskInspectorActivityRuntime {
  readonly runtimeGeneration: string
  private readonly service: TaskInspectorActivityService
  private readonly producerStates = new Map<string, ProducerState>()
  private readonly preParentTransitions = new Map<
    string,
    RuntimeTransitionInput[]
  >()
  private readonly taskTails = new Map<string, Promise<void>>()
  private readonly mutationContext = new AsyncLocalStorage<
    ReadonlySet<string>
  >()
  private readonly tombstones = new Set<string>()
  private readonly recoveredAnchors = new Set<string>()
  private readonly pendingRecoveredAnchors = new Map<
    string,
    PendingRecoveredAnchor
  >()
  private readonly wallNow: () => number
  private readonly monotonicNow: () => number
  private readonly onError: NonNullable<
    TaskInspectorActivityRuntimeOptions['onError']
  >
  private recoveryGeneration = 0
  private pendingReconnect: PendingReconnect | null = null
  private stopped = false
  private disposePromise: Promise<void> | null = null

  private readonly onDisconnected = (): void => {
    if (this.stopped) return
    // The supervisor emits one disconnect per Ready → non-Ready edge. Retain
    // the current generation for duplicate signals before any authoritative
    // poll, while still allowing a second real outage after a poll attempt.
    if (this.pendingReconnect && !this.pendingReconnect.pollObserved) return
    this.recoveryGeneration += 1
    this.recoveredAnchors.clear()
    this.pendingRecoveredAnchors.clear()
    const gapAt = Math.round(this.wallNow())
    this.pendingReconnect = {
      generation: this.recoveryGeneration,
      gapAt,
      pollObserved: false,
      tasks: null,
    }
    this.service.markDisconnected(gapAt)
  }

  constructor(
    private readonly store: TaskInspectorActivityRuntimePersistence,
    private readonly eventBus: EventBus,
    options: TaskInspectorActivityRuntimeOptions = {}
  ) {
    this.wallNow = options.wallNow ?? Date.now
    this.monotonicNow =
      options.monotonicNow ?? performance.now.bind(performance)
    this.runtimeGeneration = options.runtimeGeneration ?? randomUUID()
    this.onError = options.onError ?? (() => {})
    this.service = new TaskInspectorActivityService(store, {
      wallNow: this.wallNow,
      monotonicNow: this.monotonicNow,
      onRevision: (revision) => this.emitRevision(revision),
      onRecoveredTransition: (transition) => {
        void this.recordTransition(transition)
      },
      onError: (error, context) => this.report(error, context),
    })
    this.eventBus.on(Events.EngineDisconnected, this.onDisconnected)
  }

  recordSamples(tasks: readonly DownloadTask[]): void {
    if (this.stopped) return
    this.service.recordSamples(
      tasks.filter((task) => !this.tombstones.has(task.id))
    )
  }

  recordTransition(input: RuntimeTransitionInput): Promise<void> {
    if (this.stopped) {
      return Promise.resolve()
    }
    return this.serialize(input.taskId, async () => {
      if (this.tombstones.has(input.taskId)) return
      let producer: ProducerState
      try {
        producer = this.ensureProducer(input.taskId, input.occurredAt)
      } catch (error) {
        this.bufferPreParent(input)
        this.report(error, {
          operation: 'buffer_pre_parent_transition',
          taskId: input.taskId,
        })
        return
      }
      this.flushPending(producer, input.taskId)
      this.drainPreParent(input.taskId, producer)
      this.enqueueAssignedTransition(producer, input)
      this.flushPending(producer, input.taskId)

      if (
        input.nextStatus === TaskStatus.Paused ||
        input.nextStatus === TaskStatus.Completed ||
        input.nextStatus === TaskStatus.Error ||
        input.nextStatus === TaskStatus.Removed
      ) {
        this.service.forceCheckpoint(input.taskId)
      }
    })
  }

  /**
   * Occurrence-outbox consumer for the timeline. Terminal occurrences append
   * the Completed/Failed item, diagnosis occurrences append the refined
   * error item; both are idempotent by `occurrenceId`.
   *
   * Registered by both shells as the timeline consumer — the dispatcher
   * only stamps an outbox row dispatched once every consumer resolved, so
   * this rejects (rather than logging and returning) whenever the item
   * could not be appended.
   */
  recordOccurrence(occurrence: TaskOccurrence): Promise<void> {
    return occurrence.type === 'diagnosis'
      ? this.recordDiagnosisOccurrence(occurrence)
      : this.recordTerminalOccurrence(occurrence)
  }

  /**
   * Append one error item for a **diagnosis** occurrence — the refined error
   * group a post-terminal diagnosis produced, which no `recordTransition`
   * call covers (the task's status never changed).
   */
  async recordDiagnosisOccurrence(occurrence: TaskOccurrence): Promise<void> {
    if (this.stopped || occurrence.type !== 'diagnosis') return
    const { diagnosis } = occurrence
    await this.appendOccurrenceEvent(occurrence, {
      kind: TaskHistoryEventKind.Failed,
      fromStatus: TaskStatus.Error,
      toStatus: TaskStatus.Error,
      errorCode: diagnosis.errorCode,
      errorMessage: diagnosis.errorMessage,
      errorDetailKey: diagnosis.errorDetailKey,
      errorDetailParams: diagnosis.errorDetailParams,
    })
  }

  /**
   * Append the Completed/Failed item for a **terminal** occurrence.
   *
   * The live commit paths also record this transition through
   * `recordTransition`, but only after the process survived long enough to
   * reach it — a crash between the durable commit and that call would
   * otherwise lose the item forever. Replaying it from the outbox closes
   * that gap; the live path threads the same `occurrenceId` into its
   * transition record as the `eventKey`, so whichever path runs first wins
   * and the other one recognizes the row and skips.
   */
  async recordTerminalOccurrence(occurrence: TaskOccurrence): Promise<void> {
    if (this.stopped || occurrence.type !== 'terminal') return
    const { fromStatus, toStatus, errorGroup } = occurrence
    await this.appendOccurrenceEvent(occurrence, {
      kind:
        toStatus === TaskStatus.Completed
          ? TaskHistoryEventKind.Completed
          : TaskHistoryEventKind.Failed,
      fromStatus,
      toStatus,
      errorCode: errorGroup?.errorCode ?? null,
      errorMessage: errorGroup?.errorMessage ?? null,
      errorDetailKey: errorGroup?.errorDetailKey ?? null,
      errorDetailParams: errorGroup?.errorDetailParams ?? null,
    })
  }

  /**
   * Shared body of the occurrence consumers: append exactly one history item
   * keyed by `occurrenceId`.
   *
   * Idempotent — the persisted timeline is scanned for the key before an
   * ordinal is ever reserved, so a redelivered occurrence (same-process
   * double dispatch, a fresh process replaying an undispatched outbox row,
   * or the live commit path having already written the item) is skipped.
   *
   * Every persistence failure propagates. Unlike `recordTransition`, whose
   * caller is a task mutation that must not fail over telemetry, this path
   * IS the delivery: reporting success while the append is still pending
   * would let the dispatcher stamp the outbox row dispatched and lose the
   * item for good.
   */
  private async appendOccurrenceEvent(
    occurrence: TaskOccurrence,
    fields: {
      kind: TaskHistoryEventKind
      fromStatus: TaskStatus | null
      toStatus: TaskStatus
      errorCode: DownloadTask['errorCode']
      errorMessage: string | null
      errorDetailKey: string | null
      errorDetailParams: Record<string, string> | null
    }
  ): Promise<void> {
    const { taskId, occurrenceId, createdAt } = occurrence
    await this.serialize(taskId, async () => {
      if (this.tombstones.has(taskId)) return

      const existing: TaskInspectorActivitySnapshot | null =
        this.store.snapshot(taskId)
      if (
        existing?.timeline.events.some(
          (event) => event.eventKey === occurrenceId
        )
      ) {
        return
      }

      const producer = this.ensureProducer(taskId, createdAt)
      const blocked = this.flushPending(producer, taskId)
      if (blocked !== null) throw blocked

      const eventOrdinal = producer.nextOrdinal++
      producer.pending.push({
        taskId,
        runtimeGeneration: this.runtimeGeneration,
        eventOrdinal,
        eventKey: occurrenceId,
        kind: fields.kind,
        fromStatus: fields.fromStatus,
        toStatus: fields.toStatus,
        occurredAt: createdAt,
        occurredMonotonicMs: Math.max(0, Math.round(this.monotonicNow())),
        accuracy: TaskHistoryAccuracy.Exact,
        delivery: TaskHistoryDelivery.Initial,
        errorCode:
          fields.errorCode === null
            ? null
            : boundedNullableText(String(fields.errorCode), 128),
        errorMessage: boundedNullableText(fields.errorMessage, 2_048),
        errorDetailKey: boundedNullableText(fields.errorDetailKey, 128),
        errorDetailParams: boundedNullableParams(
          fields.errorDetailParams,
          2_048
        ),
      })
      const failed = this.flushPending(producer, taskId)
      if (failed !== null) throw failed
    })
  }

  captureRecoveredAnchorOrigins(
    tasks: readonly DownloadTask[]
  ): RecoveredAnchorOrigins {
    const origins = new Map<string, RecoveredAnchorOrigin>()
    for (const task of tasks) {
      if (
        this.stopped ||
        this.tombstones.has(task.id) ||
        origins.has(task.id)
      ) {
        continue
      }
      origins.set(task.id, {
        gapAt: null,
        status: task.status,
      })
      try {
        const existing = this.store.snapshot(task.id)
        origins.set(task.id, {
          gapAt: existing
            ? Math.max(
                existing.summary.updatedAt,
                existing.lifetime.points.at(-1)?.t ?? existing.summary.updatedAt
              )
            : null,
          status: task.status,
        })
      } catch (error) {
        this.report(error, {
          operation: 'capture_recovered_anchor',
          taskId: task.id,
        })
      }
    }
    return origins
  }

  async recordRecoveredAnchors(
    tasks: readonly DownloadTask[],
    origins: RecoveredAnchorOrigins
  ): Promise<void> {
    for (const task of tasks) {
      if (
        this.stopped ||
        this.tombstones.has(task.id) ||
        this.recoveredAnchors.has(task.id)
      ) {
        continue
      }
      const origin = origins.get(task.id)
      if (
        origin?.status === task.status &&
        TERMINAL_STATUSES.has(task.status)
      ) {
        this.recoveredAnchors.add(task.id)
        continue
      }
      await this.deliverRecoveredAnchor(
        task,
        origin?.gapAt ?? null,
        this.recoveryGeneration
      )
    }
  }

  /**
   * Called only for a successful full active+waiting poll. The first such poll
   * after a disconnect freezes the observed task set and records one recovered
   * state per task before recordSamples() is allowed to establish a baseline.
   */
  async recordAuthoritativeReconnectAnchors(
    tasks: readonly DownloadTask[]
  ): Promise<void> {
    const reconnect = this.pendingReconnect
    if (this.stopped || !reconnect) return
    reconnect.pollObserved = true
    if (!reconnect.tasks) {
      reconnect.tasks = new Map(
        tasks
          .filter((task) => !this.tombstones.has(task.id))
          .map((task) => [
            task.id,
            {
              ...task,
              instances: task.instances.map((instance) => ({ ...instance })),
            },
          ])
      )
    }

    for (const task of reconnect.tasks.values()) {
      await this.deliverRecoveredAnchor(
        task,
        reconnect.gapAt,
        reconnect.generation
      )
    }

    if (
      this.pendingReconnect === reconnect &&
      [...reconnect.tasks.keys()].every((taskId) =>
        this.recoveredAnchors.has(taskId)
      )
    ) {
      this.pendingReconnect = null
    }
  }

  async parentTaskCreated(
    task: DownloadTask,
    persistParent: () => void | Promise<void>
  ): Promise<void> {
    if (this.stopped) return
    await this.serialize(task.id, async () => {
      if (this.tombstones.has(task.id)) return
      await persistParent()
      this.service.markParentDurable(task.id, task.createdAt)
      const input: RuntimeTransitionInput = {
        taskId: task.id,
        previousStatus: null,
        nextStatus: task.status,
        occurredAt: task.createdAt,
        monotonicAt: this.monotonicNow(),
        accuracy: TaskHistoryAccuracy.Exact,
        errorCode: task.errorCode,
        errorMessage: task.errorMessage,
        errorDetailKey: task.errorDetailKey,
        errorDetailParams: task.errorDetailParams,
      }
      let producer: ProducerState
      try {
        producer = this.ensureProducer(task.id, task.createdAt)
      } catch (error) {
        this.bufferPreParent(input)
        this.report(error, {
          operation: 'buffer_parent_created_transition',
          taskId: task.id,
        })
        return
      }
      producer.pending.push(this.assignTransition(producer, input))
      this.flushPending(producer, task.id)
      this.drainPreParent(task.id, producer)
      this.flushPending(producer, task.id)
    })
  }

  async deleteParentTask(
    taskId: string,
    deleteParent: () => void | Promise<void>
  ): Promise<void> {
    await this.deleteParentTasks([taskId], deleteParent)
  }

  async deleteParentTasks(
    taskIds: readonly string[],
    deleteParents: () => void | Promise<void>
  ): Promise<void> {
    const uniqueTaskIds = [...new Set(taskIds)]
    await this.runTaskMutation(uniqueTaskIds, async () => {
      for (const taskId of uniqueTaskIds) {
        if (!this.tombstones.has(taskId)) {
          this.tombstones.add(taskId)
        }
      }
      try {
        await deleteParents()
      } catch (error) {
        for (const taskId of uniqueTaskIds) {
          this.tombstones.delete(taskId)
        }
        throw error
      }
      for (const taskId of uniqueTaskIds) {
        this.recoveredAnchors.delete(taskId)
        this.pendingRecoveredAnchors.delete(taskId)
        this.pendingReconnect?.tasks?.delete(taskId)
        this.service.tombstone(taskId)
        this.producerStates.delete(taskId)
        this.preParentTransitions.delete(taskId)
      }
      const reconnect = this.pendingReconnect
      if (
        reconnect?.tasks &&
        [...reconnect.tasks.keys()].every((taskId) =>
          this.recoveredAnchors.has(taskId)
        )
      ) {
        this.pendingReconnect = null
      }
    })
  }

  runTaskMutation<T>(
    taskIds: readonly string[],
    operation: () => Promise<T>
  ): Promise<T> {
    if (this.stopped) {
      return Promise.reject(
        new Error('TaskInspectorActivityRuntime is disposed')
      )
    }
    const uniqueTaskIds = [...new Set(taskIds)].sort()
    if (uniqueTaskIds.length === 0) return operation()

    const active = this.mutationContext.getStore()
    if (active) {
      if (uniqueTaskIds.every((taskId) => active.has(taskId))) {
        return operation()
      }
      return Promise.reject(
        new Error('Cannot extend a nested task mutation lock set')
      )
    }

    const acquire = (index: number): Promise<T> => {
      const taskId = uniqueTaskIds[index]
      if (taskId === undefined) {
        return this.mutationContext.run(new Set(uniqueTaskIds), operation)
      }
      return this.serialize(taskId, () => acquire(index + 1))
    }
    return acquire(0)
  }

  snapshot(taskId: string): TaskInspectorActivitySnapshot | null {
    if (this.stopped) {
      throw new Error('TaskInspectorActivityRuntime is disposed')
    }
    return this.store.snapshot(taskId)
  }

  deliverAssignedTransition(
    input: TaskHistoryEventInput
  ): TaskActivityRevision | null {
    if (input.runtimeGeneration !== this.runtimeGeneration) {
      throw new Error('obsolete runtime generation')
    }
    const revision = this.store.recordTransition(input)
    if (revision) this.emitRevision(revision)
    return revision
  }

  dispose(): Promise<void> {
    if (this.disposePromise) return this.disposePromise
    this.stopped = true
    this.eventBus.off(Events.EngineDisconnected, this.onDisconnected)
    this.disposePromise = (async () => {
      await Promise.allSettled([...this.taskTails.values()])
      for (const [taskId, producer] of this.producerStates) {
        this.flushPending(producer, taskId)
      }
      await this.service.dispose()
      this.taskTails.clear()
      this.producerStates.clear()
      this.preParentTransitions.clear()
      this.recoveredAnchors.clear()
      this.pendingRecoveredAnchors.clear()
      this.pendingReconnect = null
    })()
    return this.disposePromise
  }

  private ensureProducer(taskId: string, at: number): ProducerState {
    const existing = this.producerStates.get(taskId)
    if (existing) return existing
    this.store.ensureTask(taskId, at)
    const snapshot = this.store.snapshot(taskId)
    const state: ProducerState = {
      nextOrdinal: (snapshot?.summary.lastEventOrdinal ?? 0) + 1,
      pending: [],
    }
    this.producerStates.set(taskId, state)
    return state
  }

  private assignTransition(
    producer: ProducerState,
    input: RuntimeTransitionInput
  ): TaskHistoryEventInput {
    const eventOrdinal = producer.nextOrdinal++
    const accuracy = this.normalizeAccuracy(input.accuracy)
    return {
      taskId: input.taskId,
      runtimeGeneration: this.runtimeGeneration,
      eventOrdinal,
      // A terminal transition committed alongside an occurrence keys off the
      // occurrence id, so redelivery of that occurrence through the outbox
      // recognizes the item this path already wrote. Everything else keeps
      // the per-generation ordinal key.
      eventKey:
        input.occurrenceId ?? `${this.runtimeGeneration}:${eventOrdinal}`,
      kind: this.deriveKind(input, accuracy),
      fromStatus: input.previousStatus,
      toStatus: input.nextStatus,
      occurredAt: input.occurredAt,
      // performance.now() is fractional in real Electron runtimes, while the
      // durable delivery DTO and SQLite schema intentionally use integers.
      // Keep fractional precision for in-memory integration (noteTransition)
      // and normalize only at this persistence boundary.
      occurredMonotonicMs: Math.max(0, Math.round(input.monotonicAt)),
      accuracy,
      delivery: TaskHistoryDelivery.Initial,
      errorCode:
        input.errorCode === null
          ? null
          : boundedNullableText(String(input.errorCode), 128),
      errorMessage: boundedNullableText(input.errorMessage, 2_048),
      errorDetailKey: boundedNullableText(input.errorDetailKey ?? null, 128),
      errorDetailParams: boundedNullableParams(
        input.errorDetailParams ?? null,
        2_048
      ),
    }
  }

  private enqueueAssignedTransition(
    producer: ProducerState,
    input: RuntimeTransitionInput
  ): void {
    if (input.previousStatus !== null) {
      this.service.noteTransition({
        ...input,
        previousStatus: input.previousStatus,
        accuracy: this.normalizeAccuracy(input.accuracy),
      })
    }
    producer.pending.push(this.assignTransition(producer, input))
  }

  private async deliverRecoveredAnchor(
    task: DownloadTask,
    gapAt: number | null,
    generation: number
  ): Promise<void> {
    if (
      this.stopped ||
      this.tombstones.has(task.id) ||
      this.recoveredAnchors.has(task.id) ||
      generation !== this.recoveryGeneration
    ) {
      return
    }

    let anchor = this.pendingRecoveredAnchors.get(task.id)
    if (!anchor || anchor.generation !== generation) {
      anchor = {
        generation,
        gapAt,
        gapDurable: gapAt === null,
        input: {
          taskId: task.id,
          previousStatus: null,
          nextStatus: task.status,
          occurredAt: Math.round(this.wallNow()),
          monotonicAt: this.monotonicNow(),
          accuracy: TaskHistoryAccuracy.Recovered,
          errorCode: task.errorCode,
          errorMessage: task.errorMessage,
          errorDetailKey: task.errorDetailKey,
          errorDetailParams: task.errorDetailParams,
        },
        event: null,
      }
      this.pendingRecoveredAnchors.set(task.id, anchor)
    }

    try {
      await this.serialize(task.id, async () => {
        if (
          this.stopped ||
          this.tombstones.has(task.id) ||
          generation !== this.recoveryGeneration
        ) {
          return
        }
        if (!anchor.gapDurable && anchor.gapAt !== null) {
          anchor.gapDurable = this.service.markRecoveredAnchor(
            task.id,
            anchor.gapAt
          )
          if (!anchor.gapDurable) return
        }

        let producer: ProducerState
        try {
          producer = this.ensureProducer(task.id, anchor.input.occurredAt)
        } catch (error) {
          this.report(error, {
            operation: 'record_recovered_anchor',
            taskId: task.id,
          })
          return
        }

        if (!anchor.event) {
          // Preserve event ordering: first retry anything accepted earlier.
          this.flushPending(producer, task.id)
          if (producer.pending.length > 0) return
          this.drainPreParent(task.id, producer)
          this.flushPending(producer, task.id)
          if (producer.pending.length > 0) return
          anchor.event = this.assignTransition(producer, anchor.input)
          producer.pending.push(anchor.event)
        }

        this.flushPending(producer, task.id)
        if (producer.pending.includes(anchor.event)) return

        this.recoveredAnchors.add(task.id)
        if (this.pendingRecoveredAnchors.get(task.id) === anchor) {
          this.pendingRecoveredAnchors.delete(task.id)
        }
      })
    } catch (error) {
      this.report(error, {
        operation: 'record_recovered_anchor',
        taskId: task.id,
      })
    }
  }

  private bufferPreParent(input: RuntimeTransitionInput): void {
    const pending = this.preParentTransitions.get(input.taskId) ?? []
    if (pending.length >= MAX_PRE_PARENT_TRANSITIONS) {
      pending.shift()
    }
    pending.push({ ...input })
    this.preParentTransitions.set(input.taskId, pending)
  }

  private drainPreParent(taskId: string, producer: ProducerState): void {
    const pending = this.preParentTransitions.get(taskId)
    if (!pending) return
    this.preParentTransitions.delete(taskId)
    for (const input of pending) {
      this.enqueueAssignedTransition(producer, input)
    }
  }

  /**
   * Drain the producer's queue. Returns the error that stopped the drain
   * (leaving that event and everything behind it queued for a later retry),
   * or `null` when the queue emptied. Callers that only record telemetry
   * ignore the result; the occurrence consumers propagate it.
   */
  private flushPending(producer: ProducerState, taskId: string): Error | null {
    while (producer.pending.length > 0) {
      const event = producer.pending[0]
      try {
        const revision = this.store.recordTransition(event)
        producer.pending.shift()
        if (revision) this.emitRevision(revision)
      } catch (error) {
        event.delivery = TaskHistoryDelivery.Retry
        this.report(error, { operation: 'record_transition', taskId })
        return error instanceof Error ? error : new Error(String(error))
      }
    }
    return null
  }

  private deriveKind(
    input: RuntimeTransitionInput,
    accuracy: TaskHistoryAccuracy
  ): TaskHistoryEventKind {
    if (accuracy === TaskHistoryAccuracy.Recovered) {
      return TaskHistoryEventKind.ObservedState
    }
    if (input.previousStatus === null) return TaskHistoryEventKind.Added
    if (input.nextStatus === TaskStatus.Error) {
      return TaskHistoryEventKind.Failed
    }
    if (input.nextStatus === TaskStatus.Completed) {
      return TaskHistoryEventKind.Completed
    }
    if (input.nextStatus === TaskStatus.Paused) {
      return TaskHistoryEventKind.Paused
    }
    if (
      input.previousStatus === TaskStatus.Paused &&
      ACTIVE_STATUSES.has(input.nextStatus)
    ) {
      return TaskHistoryEventKind.Resumed
    }
    if (
      !ACTIVE_STATUSES.has(input.previousStatus) &&
      ACTIVE_STATUSES.has(input.nextStatus)
    ) {
      return TaskHistoryEventKind.Started
    }
    return TaskHistoryEventKind.StageChanged
  }

  private normalizeAccuracy(
    accuracy: RuntimeTransitionInput['accuracy']
  ): TaskHistoryAccuracy {
    return accuracy === TaskHistoryAccuracy.Recovered
      ? TaskHistoryAccuracy.Recovered
      : TaskHistoryAccuracy.Exact
  }

  private emitRevision(revision: TaskActivityRevision): void {
    const payload: TaskInspectorActivityUpdatedPayload = {
      taskId: revision.taskId,
      revision: revision.revision,
      reason: revision.reason,
    }
    try {
      this.eventBus.emit(Events.TaskInspectorActivityUpdated, payload)
    } catch (error) {
      this.report(error, {
        operation: 'emit_activity_update',
        taskId: revision.taskId,
      })
    }
  }

  private serialize<T>(
    taskId: string,
    operation: () => Promise<T>
  ): Promise<T> {
    if (this.mutationContext.getStore()?.has(taskId)) {
      return operation()
    }
    const previous = this.taskTails.get(taskId) ?? Promise.resolve()
    const current = previous.then(operation, operation)
    const settled = current.then(
      () => undefined,
      () => undefined
    )
    this.taskTails.set(taskId, settled)
    void settled.then(() => {
      if (this.taskTails.get(taskId) === settled) {
        this.taskTails.delete(taskId)
      }
    })
    return current
  }

  private report(
    error: unknown,
    context: { operation: string; taskId?: string }
  ): void {
    try {
      this.onError(error, context)
    } catch {
      // Logging and telemetry never become task lifecycle failures.
    }
  }
}
