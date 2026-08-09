import type { DownloadTask } from '@shared/types/task'
import { TaskStatus } from '@shared/types/task'
import { isTerminalTaskStatus } from '@shared/types/task-actions'
import type {
  OccurrenceCause,
  TaskOccurrence,
  TaskTerminalOccurrence,
} from '@shared/types/task-occurrence'
import { terminalOccurrenceId } from '@shared/types/task-occurrence'
import type { EngineAdapter } from '../../engine/engine-adapter'
import type { EventBus } from '../../events/event-bus'
import type { Logger } from '../../logger'
import { mergeEngineTask } from '../merge-engine-task'
import type { OccurrenceDispatcher } from '../occurrences/occurrence-dispatcher'
import type { TaskManager } from '../task-manager'

/**
 * Dependency bundle shared by every task action (pause, resume, move,
 * remove, stopSeeding, …). Lives here rather than in any one action file so
 * siblings don't import from an unrelated peer just to reach the common type.
 */
export interface TaskActionDeps {
  taskManager: TaskManager
  adapter: EngineAdapter
  eventBus: EventBus
  log: Logger
  /**
   * Active aria2 segment gids for a coordinator-managed media task (kind
   * Mux/Hls), whose `engineTaskId` is '' because it has no single aria2 handle.
   * Supplied by the bridge runtime so pause/resume can act on the real segment
   * downloads. Undefined for non-media call sites.
   */
  getMediaSegmentGids?: (taskId: string) => string[]
  /**
   * Persist an unpublished candidate. Shells bind this to the SessionManager
   * ownership queue; the helper never publishes the candidate before it
   * resolves.
   */
  persistTask?: (task: DownloadTask) => Promise<void>
  /**
   * Persist a task and (when non-null) its terminal occurrence in a single
   * durable transaction. Shells bind this to
   * `SessionManager.persistTaskWithOccurrence`. `commitTaskUpdate` calls this
   * INSTEAD OF `persistTask`/`options.persist` whenever it builds an
   * occurrence — see `buildTerminalOccurrence`.
   */
  persistTaskWithOccurrence?: (
    task: DownloadTask,
    occurrence: TaskOccurrence | null
  ) => Promise<void>
  /** Delivers a just-committed terminal occurrence to in-process consumers
   *  (log, notification producer, timeline). Optional so tests and call
   *  sites that never reach a terminal transition can omit it. Narrowed to
   *  `dispatch` (rather than the full `OccurrenceDispatcher`) so tests can
   *  supply a plain `{ dispatch }` double. */
  occurrenceDispatcher?: Pick<OccurrenceDispatcher, 'dispatch'>
  recordTransition?: (input: TaskTransitionRecordInput) => void | Promise<void>
  /**
   * Establish the Inspector Activity deletion barrier for every public task id
   * before deleting the durable parent row(s). The runtime tombstones the ids
   * and drains already-queued producers before invoking `deleteParents`.
   */
  deleteParentTasks?: (
    taskIds: readonly string[],
    deleteParents: () => void | Promise<void>
  ) => Promise<void>
  runTaskMutation?: <T>(
    taskIds: readonly string[],
    operation: () => Promise<T>
  ) => Promise<T>
  now?: () => number
  monotonicNow?: () => number
  /**
   * Coalesced TaskUpdated publication (TaskUpdatePublisher.publish): schedule
   * a trailing snapshot emit instead of emitting inline. Shells bind this to
   * the one TaskUpdatePublisher they construct next to the EventBus; tests
   * that only assert "a snapshot was broadcast" can bind the synchronous
   * pass-through from `@test-utils/task-update`.
   */
  publishTaskUpdate: () => void
  /**
   * Immediate TaskUpdated publication (TaskUpdatePublisher.publishNow), used
   * whenever the commit produced a terminal occurrence so the terminal
   * snapshot never waits out the coalescing window and the
   * emit-before-occurrence-dispatch ordering is preserved.
   */
  publishTaskUpdateNow: () => void
}

export interface TaskTransitionRecordInput {
  taskId: string
  previousStatus: TaskStatus
  nextStatus: TaskStatus
  occurredAt: number
  monotonicAt: number
  accuracy: 'exact' | 'recovered'
  errorCode: DownloadTask['errorCode']
  errorMessage: string | null
  errorDetailKey: string | null
  errorDetailParams: Record<string, string> | null
  /**
   * The terminal occurrence committed with this transition, when the caller
   * built one. The Activity runtime uses it as the history item's event key
   * so the occurrence-outbox consumer — which replays the same
   * Completed/Failed item after a crash between commit and this call —
   * recognizes the row instead of appending a duplicate. Omitted (or null)
   * for every non-terminal transition.
   */
  occurrenceId?: string | null
}

export interface CommitTaskUpdateOptions {
  accuracy?: TaskTransitionRecordInput['accuracy']
  persist?: (task: DownloadTask) => Promise<void>
  /**
   * Status observed before an accepted engine mutation. An authoritative poll
   * can publish the destination status before reconciliation commits; retain
   * the accepted action's source status so its durable history stays exact.
   */
  transitionFromStatus?: TaskStatus
  /**
   * Attribution for the terminal occurrence this commit may produce. Defaults
   * to `'engine'` (the natural-poll/reconcile path) when omitted — every
   * caller that reaches a terminal state through a distinct pipeline
   * (finalize, media, recovery, a user-initiated cancel) should pass its own
   * cause explicitly.
   */
  terminalCause?: OccurrenceCause
}

/**
 * The subset of a task's fields needed to decide whether a status change
 * qualifies for a terminal occurrence, and to build one. Normalized (rather
 * than `Pick<DownloadTask, ...>`) so callers holding a `TaskRow` (MagnetTracker)
 * can build the same snapshot without going through a `DownloadTask`.
 */
export interface TerminalTaskSnapshot {
  taskId: string
  status: TaskStatus
  finishedAt: number | null
  errorCode: DownloadTask['errorCode']
  errorMessage: string | null
  errorDetailKey: string | null
  errorDetailParams: Record<string, string> | null
}

export function terminalSnapshotFromTask(
  task: DownloadTask
): TerminalTaskSnapshot {
  return {
    taskId: task.id,
    status: task.status,
    finishedAt: task.finishedAt,
    errorCode: task.errorCode,
    errorMessage: task.errorMessage,
    errorDetailKey: task.errorDetailKey,
    errorDetailParams: task.errorDetailParams,
  }
}

/**
 * Build the terminal occurrence for a status transition, or `null` when the
 * transition doesn't qualify — the destination isn't Completed/Error, or the
 * status didn't actually change (a same-status re-commit, e.g. Error→Error
 * from a duplicate engine notification). Every commit path (this file,
 * finalizeTask, MediaTaskCoordinator, TaskRecoveryService, MagnetTracker)
 * calls this so occurrence eligibility rules live in exactly one place.
 */
export function buildTerminalOccurrence(
  snapshot: TerminalTaskSnapshot,
  fromStatus: TaskStatus,
  cause: OccurrenceCause,
  /**
   * Clock reading to fall back to when `snapshot.finishedAt` is absent.
   * Defaults to a fresh `Date.now()` for backward compatibility with every
   * caller that doesn't need to share a clock reading with sibling work in
   * the same commit. `commitTaskUpdate` resolves its clock once per commit
   * and passes the same value here and to `recordTransition`'s
   * `occurredAt`, so a single commit never straddles two different reads
   * of "now".
   */
  now: number = Date.now()
): TaskTerminalOccurrence | null {
  if (fromStatus === snapshot.status) return null
  if (!isTerminalTaskStatus(snapshot.status)) {
    return null
  }
  const finishedAt = snapshot.finishedAt ?? now
  return {
    occurrenceId: terminalOccurrenceId(
      snapshot.taskId,
      snapshot.status,
      finishedAt
    ),
    type: 'terminal',
    taskId: snapshot.taskId,
    fromStatus,
    toStatus: snapshot.status,
    cause,
    errorGroup: {
      errorCode: snapshot.errorCode,
      errorMessage: snapshot.errorMessage,
      errorDetailKey: snapshot.errorDetailKey,
      errorDetailParams: snapshot.errorDetailParams,
    },
    createdAt: finishedAt,
  }
}

/**
 * Warn that a just-persisted terminal occurrence has no dispatcher to reach
 * live consumers (timeline, failure-log) with — it isn't lost (the caller
 * always persists it before checking this), but it won't surface until the
 * next startup drain. Shared by MagnetTracker's two cleanup-path call sites
 * (markMetadataFailure, deferCleanup), which hit this gap identically.
 */
export function warnOccurrenceUndispatchable(
  log: { warn(ctx: Record<string, unknown>, msg: string): void },
  ctx: { taskId: string; occurrenceId: string },
  callerName: string
): void {
  log.warn(
    ctx,
    `${callerName}: built a terminal occurrence but occurrenceDispatcher is not wired; occurrence is persisted but will not be dispatched until the next startup drain`
  )
}

/**
 * The "fetch the task or warn and bail" guard shared by every by-id action
 * (pause, resume, move, stopSeeding, remove, reAdd, finalize). Typed against
 * narrow structural slices so callers with a partial TaskManager (finalize)
 * can use it too.
 */
export function getTaskOrWarn(
  deps: {
    taskManager: { getById(id: string): DownloadTask | undefined }
    log: { warn(ctx: Record<string, unknown>, msg: string): void }
  },
  taskId: string,
  callerName: string
): DownloadTask | undefined {
  const task = deps.taskManager.getById(taskId)
  if (!task) {
    deps.log.warn({ taskId }, `${callerName}: task not found`)
  }
  return task
}

export interface PollTerminalCommitDeps {
  persistTaskWithOccurrence: (
    task: DownloadTask,
    occurrence: TaskOccurrence | null
  ) => Promise<void>
  occurrenceDispatcher?: Pick<OccurrenceDispatcher, 'dispatch'>
  /**
   * Publish the terminal state to TaskManager. Invoked only after the
   * durable write resolved, and inside the same per-task mutation, so no
   * reader ever observes a terminal task that isn't on disk yet.
   */
  publish: (task: DownloadTask) => void
  runTaskMutation?: <T>(
    taskIds: readonly string[],
    operation: () => Promise<T>
  ) => Promise<T>
  log: Pick<Logger, 'warn'>
}

/**
 * `'not-terminal'` — nothing to commit; the caller publishes as usual.
 * `'published'` — durably written and published by this function.
 * `'persist-failed'` — the write failed and nothing was published; the
 * caller must leave the previous in-memory state alone so the next poll
 * observes the same delta and retries.
 */
export type PolledTerminalCommitOutcome =
  | 'not-terminal'
  | 'published'
  | 'persist-failed'

/**
 * Commit a poll-detected transition into Completed/Error through the
 * occurrence-aware durable path — shared by both shells' handlePolledTasks
 * so the terminal-vs-non-terminal split is identical everywhere. Used
 * INSTEAD OF the batch `requestSave()` those loops otherwise trigger for a
 * status change: a terminal transition gets its own single-task durable
 * write (task row + occurrence row, one transaction) rather than waiting on
 * — or duplicating — the batch flush.
 *
 * Durability and publication are one step, taken under the task's mutation
 * lock: a terminal status that reached TaskManager without its row (and
 * occurrence) on disk would survive in memory until the next restart, then
 * silently revert — with no occurrence ever written for the transition.
 *
 * Safe to call on every observed status change without a separate terminal
 * check: `buildTerminalOccurrence`'s guard makes this a no-op (returns
 * `'not-terminal'`, writes nothing, publishes nothing, dispatches nothing)
 * whenever the destination isn't Completed/Error, or whenever
 * `previousStatus` already equals the task's current status (a same-status
 * re-observation of an already-terminal task — e.g. a second poll tick, or
 * a race with another commit path that got there first). That guard plus
 * `persistTaskWithOccurrence`'s `INSERT OR IGNORE` on `occurrence_id` is
 * what makes a duplicate poll observation, or a poll racing another
 * committing path for the exact same transition, safe to call
 * unconditionally.
 */
export async function commitPolledTerminalTransition(
  previousStatus: TaskStatus,
  task: DownloadTask,
  deps: PollTerminalCommitDeps
): Promise<PolledTerminalCommitOutcome> {
  const occurrence = buildTerminalOccurrence(
    terminalSnapshotFromTask(task),
    previousStatus,
    'engine'
  )
  if (!occurrence) return 'not-terminal'

  const commit = async (): Promise<PolledTerminalCommitOutcome> => {
    try {
      await deps.persistTaskWithOccurrence(task, occurrence)
    } catch (err) {
      deps.log.warn(
        { err, taskId: task.id, occurrenceId: occurrence.occurrenceId },
        'poll terminal commit failed; keeping the previous state until the next poll retries'
      )
      return 'persist-failed'
    }
    deps.publish(task)
    await deps.occurrenceDispatcher?.dispatch(occurrence)
    return 'published'
  }

  return deps.runTaskMutation
    ? deps.runTaskMutation([task.id], commit)
    : commit()
}

export interface PersistWithOccurrenceOrWarnDeps {
  persistTaskWithOccurrence?: (
    task: DownloadTask,
    occurrence: TaskOccurrence | null
  ) => Promise<void>
  log: { warn(ctx: Record<string, unknown>, msg: string): void }
}

/**
 * The persist-or-warn branch shared by every commit path that may produce a
 * terminal occurrence (commitTaskUpdate, finalizeTask.persistTaskTransition,
 * MediaTaskCoordinator.commitTaskTransitionSerialized,
 * TaskRecoveryService.persistRecoveredTransition): use the occurrence-aware
 * persist when wired, else warn loudly — the occurrence would otherwise be
 * silently dropped — and fall back to `persistPlain`.
 *
 * Covers ONLY this branch. Each caller keeps its own pre/post steps
 * (taskManager.set timing, structuredClone, bestEffort wrapping, ...) —
 * those differ enough between sites that unifying them would change
 * behavior. The boolean return tells a caller whose post-persist step only
 * runs for one of the two branches (see finalize-task.ts,
 * task-recovery-service.ts) which one fired.
 */
export async function persistWithOccurrenceOrWarn(
  deps: PersistWithOccurrenceOrWarnDeps,
  task: DownloadTask,
  occurrence: TaskOccurrence | null,
  callerName: string,
  persistPlain: (task: DownloadTask) => Promise<void>,
  options: { persistOverrideIgnored?: boolean } = {}
): Promise<boolean> {
  if (occurrence && deps.persistTaskWithOccurrence) {
    if (options.persistOverrideIgnored) {
      deps.log.warn(
        { taskId: task.id, occurrenceId: occurrence.occurrenceId },
        `${callerName}: options.persist is ignored because a terminal occurrence applies; using persistTaskWithOccurrence instead`
      )
    }
    await deps.persistTaskWithOccurrence(task, occurrence)
    return true
  }
  if (occurrence) {
    deps.log.warn(
      { taskId: task.id, occurrenceId: occurrence.occurrenceId },
      `${callerName}: built a terminal occurrence but persistTaskWithOccurrence is not wired; falling back to plain persist and dropping the occurrence`
    )
  }
  await persistPlain(task)
  return false
}

export interface RecordTransitionDeps {
  recordTransition?: (input: TaskTransitionRecordInput) => void | Promise<void>
  monotonicNow?: () => number
  log: { error(ctx: Record<string, unknown>, msg: string): void }
}

/**
 * Guarded Activity transition recording shared by the detached commit paths
 * (finalizeTask, TaskRecoveryService): skips when the hook is unwired or the
 * status didn't change, and never lets a recording failure poison the
 * surrounding commit — the durable write already succeeded.
 * `failureMessage` is caller-supplied so each pipeline keeps its own log
 * message key.
 */
export async function recordTaskTransitionOrWarn(
  task: DownloadTask,
  previousStatus: TaskStatus,
  deps: RecordTransitionDeps,
  options: {
    occurredAt?: number
    accuracy: TaskTransitionRecordInput['accuracy']
    occurrenceId?: string | null
    failureMessage: string
  }
): Promise<void> {
  if (!deps.recordTransition || previousStatus === task.status) return
  try {
    await deps.recordTransition({
      taskId: task.id,
      previousStatus,
      nextStatus: task.status,
      occurredAt: options.occurredAt ?? Date.now(),
      monotonicAt: deps.monotonicNow?.() ?? performance.now(),
      accuracy: options.accuracy,
      errorCode: task.errorCode,
      errorMessage: task.errorMessage,
      errorDetailKey: task.errorDetailKey,
      errorDetailParams: task.errorDetailParams,
      occurrenceId: options.occurrenceId ?? null,
    })
  } catch (err) {
    deps.log.error({ err, taskId: task.id }, options.failureMessage)
  }
}

export interface TerminalTransitionCommitDeps extends RecordTransitionDeps {
  /** `set` is optional to match RecoveryDeps' read-only TaskManager slice. */
  taskManager: { set?(id: string, task: DownloadTask): void }
  persistTaskWithOccurrence?: (
    task: DownloadTask,
    occurrence: TaskOccurrence | null
  ) => Promise<void>
  occurrenceDispatcher?: Pick<OccurrenceDispatcher, 'dispatch'>
  log: {
    warn(ctx: Record<string, unknown>, msg: string): void
    error(ctx: Record<string, unknown>, msg: string): void
  }
}

/**
 * The detached terminal-commit tail shared by `finalizeTask`'s
 * `persistTaskTransition` and `TaskRecoveryService`'s
 * `persistRecoveredTransition`: build the occurrence → persist-or-warn →
 * republish the detached candidate when the occurrence path persisted it →
 * record the Activity transition → dispatch the occurrence. The two callers
 * differ only in `cause`, `accuracy`, log naming, and the plain-persist
 * fallback — everything else must stay in lockstep, so it lives here once.
 *
 * The occurrence write is deliberately NOT wrapped in try/catch: a failure
 * must propagate and abort the commit, the same way a plain persist()
 * failure already does.
 */
export async function commitTerminalTaskTransition(
  task: DownloadTask,
  previousStatus: TaskStatus,
  deps: TerminalTransitionCommitDeps,
  options: {
    cause: OccurrenceCause
    /** Names the caller in persist-fallback warnings. */
    callerName: string
    /** Log message when Activity recording fails (differs per pipeline). */
    recordFailureMessage: string
    accuracy: TaskTransitionRecordInput['accuracy']
    occurredAt?: number
    persistPlain: (task: DownloadTask) => Promise<void>
  }
): Promise<void> {
  const occurrence = buildTerminalOccurrence(
    terminalSnapshotFromTask(task),
    previousStatus,
    options.cause
  )
  const persistedViaOccurrence = await persistWithOccurrenceOrWarn(
    deps,
    task,
    occurrence,
    options.callerName,
    options.persistPlain
  )
  if (persistedViaOccurrence) {
    deps.taskManager.set?.(task.id, structuredClone(task))
  }
  await recordTaskTransitionOrWarn(task, previousStatus, deps, {
    occurredAt: options.occurredAt,
    accuracy: options.accuracy,
    occurrenceId: occurrence?.occurrenceId ?? null,
    failureMessage: options.recordFailureMessage,
  })
  if (occurrence) {
    await deps.occurrenceDispatcher?.dispatch(occurrence)
  }
}

/**
 * Single post-durable publication point shared by engine, media, and
 * reconciliation branches.
 */
export async function commitTaskUpdate(
  previous: DownloadTask,
  next: DownloadTask,
  deps: TaskActionDeps,
  options: CommitTaskUpdateOptions = {}
): Promise<void> {
  const commit = async (): Promise<void> => {
    let publication = next
    if (deps.runTaskMutation) {
      const current = deps.taskManager.getById(next.id)
      if (current !== previous) {
        const sameGeneration =
          current?.engineTaskId === previous.engineTaskId &&
          current.status === next.status
        if (!sameGeneration) {
          deps.log.debug(
            { taskId: next.id },
            'skip stale task mutation after concurrent replacement or deletion'
          )
          return
        }
        // An authoritative poll can publish the accepted destination while the
        // action is reconciling. Preserve its fresher metrics instead of
        // treating the object-identity change as a deleted/replaced task.
        publication = current
      }
    }

    const transitionFromStatus = options.transitionFromStatus ?? previous.status
    // Resolved once so the occurrence and the transition record below never
    // straddle two different clock reads for the same commit.
    const now = deps.now?.() ?? Date.now()
    // The occurrence write is deliberately NOT wrapped in try/catch: a
    // failure here must propagate and abort the commit, the same way a
    // plain persist() failure already does — an occurrence is durable state,
    // not a best-effort side channel.
    const occurrence = buildTerminalOccurrence(
      terminalSnapshotFromTask(publication),
      transitionFromStatus,
      options.terminalCause ?? 'engine',
      now
    )
    // The occurrence path always uses persistTaskWithOccurrence instead of a
    // caller-supplied persist override — persistOverrideIgnored surfaces that
    // so a caller relying on its own persist (e.g. stopSeedingTask) notices
    // it silently didn't run for this terminal transition.
    await persistWithOccurrenceOrWarn(
      deps,
      publication,
      occurrence,
      'commitTaskUpdate',
      async (t) => {
        await (options.persist ?? deps.persistTask)?.(t)
      },
      { persistOverrideIgnored: options.persist != null }
    )

    deps.taskManager.set(publication.id, publication)
    if (transitionFromStatus !== publication.status) {
      try {
        await deps.recordTransition?.({
          taskId: publication.id,
          previousStatus: transitionFromStatus,
          nextStatus: publication.status,
          occurredAt: now,
          monotonicAt: deps.monotonicNow?.() ?? performance.now(),
          accuracy: options.accuracy ?? 'exact',
          errorCode: publication.errorCode,
          errorMessage: publication.errorMessage,
          errorDetailKey: publication.errorDetailKey,
          errorDetailParams: publication.errorDetailParams,
          occurrenceId: occurrence?.occurrenceId ?? null,
        })
      } catch (err) {
        deps.log.error(
          { err: String(err), taskId: publication.id },
          'task transition recording failed'
        )
      }
    }
    // Terminal commits flush immediately (the occurrence dispatch below and
    // its notification consumers assume the snapshot is already on the bus);
    // everything else — including terminal→non-terminal re-add edges — may
    // coalesce: the bridge's terminal dedup keys on the terminal IDENTITY
    // (status + finishedAt, mirroring terminalOccurrenceId), so a re-added
    // task that re-terminates notifies again without needing an emitted
    // frame of the intermediate non-terminal state. Forcing a flush here
    // instead would turn bulk ReAddTasks back into N full-list broadcasts.
    if (occurrence != null) {
      deps.publishTaskUpdateNow()
    } else {
      deps.publishTaskUpdate()
    }
    if (occurrence) {
      await deps.occurrenceDispatcher?.dispatch(occurrence)
    }
  }

  await (deps.runTaskMutation
    ? deps.runTaskMutation([next.id], commit)
    : commit())
}

/**
 * Authoritatively reconcile a task against the engine after a mutating
 * action, then emit TaskUpdated.
 *
 * Pass the optimistic local state as `fallback`: if the engine query
 * succeeds it is merged over the fallback; if it fails the fallback stands.
 * `emitFallback: false` suppresses the emit when the engine query yields
 * nothing (used on error paths that should not surface an optimistic value).
 */
export async function reconcileTask(
  fallback: DownloadTask,
  deps: TaskActionDeps,
  options: {
    emitFallback?: boolean
    ignoreErrorStatus?: boolean
    accuracy?: TaskTransitionRecordInput['accuracy']
    transitionFromStatus?: TaskStatus
  } = {}
): Promise<DownloadTask | null> {
  const emitFallback = options.emitFallback ?? true
  let next = fallback
  let shouldEmit = emitFallback
  try {
    const engineTask = await deps.adapter.getTaskStatus(fallback.engineTaskId)
    if (engineTask) {
      if (
        options.ignoreErrorStatus === true &&
        engineTask.status === TaskStatus.Error
      ) {
        next = fallback
      } else {
        // aria2 can acknowledge a mutation before tellStatus reflects it.
        // Treat only the accepted action's exact source status as unsettled;
        // other outcomes (for example Queued after Resume) remain
        // authoritative. Metrics from the response are still reconciled.
        const settledEngineTask =
          options.transitionFromStatus !== undefined &&
          fallback.status !== options.transitionFromStatus &&
          engineTask.status === options.transitionFromStatus
            ? { ...engineTask, status: fallback.status }
            : engineTask
        next = mergeEngineTask(fallback, settledEngineTask)
      }
      shouldEmit = true
    }
  } catch (err) {
    deps.log.debug(
      { err: String(err), taskId: fallback.id },
      'task reconcile failed'
    )
  }
  if (!shouldEmit) return null
  const previous = deps.taskManager.getById(fallback.id) ?? fallback
  await commitTaskUpdate(previous, next, deps, {
    accuracy: options.accuracy ?? 'recovered',
    transitionFromStatus: options.transitionFromStatus,
  })
  return next
}
