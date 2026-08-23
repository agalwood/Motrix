import { rename, rm } from 'node:fs/promises'
import type { EngineAdapter } from '@core/engine/engine-adapter'
import { pathExists } from '@core/fs/path-exists'
import type { HookOrchestrator } from '@core/plugin/hooks/hook-orchestrator'
import type { MotrixDatabase } from '@core/session/motrix-database'
import { ErrorCode } from '@shared/errors'
import type { DownloadTask } from '@shared/types/task'
import { TaskStatus, type TaskType, TransitionPhase } from '@shared/types/task'
import { isMediaKind, isTorrentLikeType } from '@shared/types/task-actions'
import {
  TaskActivityAccuracy,
  type TaskActivityRecorder,
} from '@shared/types/task-activity'
import type { TaskOccurrence } from '@shared/types/task-occurrence'
import {
  commitTerminalTaskTransition,
  type TaskTransitionRecordInput,
} from './actions/shared'
import { applyTerminalTransition } from './apply-terminal-transition'
import { getBtPayloadPath } from './bt-storage-layout'
import { applyDiagnosisUpgrade } from './diagnosis-upgrade'
import { fireAfterComplete, fireOnError } from './hook-dispatch'
import type { OccurrenceDispatcher } from './occurrences/occurrence-dispatcher'
import {
  applyTerminalStatusToTask,
  collectTaskGids,
  completeTaskAfterRename,
  setTaskTransitionPhase,
  syncPrimaryInstanceIdentity,
} from './task-instance'

export enum RecoveryAction {
  ResumeFromRename = 'resume_from_rename',
  ResumeFromReseed = 'resume_from_reseed',
  AdoptExistingGid = 'adopt_existing_gid',
  MarkCompleted = 'mark_completed',
  MarkError = 'mark_error',
  NoOp = 'noop',
}

export type FsState = 'temp_only' | 'final_only' | 'both' | 'neither'

export interface RecoveryInput {
  phase: TransitionPhase
  fsState: FsState
  aria2HasMatchingInfoHash: boolean
  taskType: TaskType
}

/**
 * Pure decision function mapping (phase × fsState × taskType × aria2 state)
 * to a recovery action. See design spec §5.7.
 */
export function determineAction(input: RecoveryInput): RecoveryAction {
  const { phase, fsState, aria2HasMatchingInfoHash, taskType } = input

  if (phase === TransitionPhase.Idle) return RecoveryAction.NoOp

  if (phase === TransitionPhase.Renaming) {
    if (fsState === 'temp_only') return RecoveryAction.ResumeFromRename
    if (fsState === 'final_only') {
      return isTorrentLikeType(taskType)
        ? RecoveryAction.ResumeFromReseed
        : RecoveryAction.MarkCompleted
    }
    // 'both' included: two distinct paths do not prove that the final path
    // belongs to this download. It may have appeared after the task started
    // and caused the rename to fail. Preserve both paths for manual review
    // instead of deleting the only known-good temporary output.
    return RecoveryAction.MarkError
  }

  if (phase === TransitionPhase.Reseeding) {
    if (fsState === 'final_only') {
      return aria2HasMatchingInfoHash
        ? RecoveryAction.AdoptExistingGid
        : RecoveryAction.ResumeFromReseed
    }
    if (fsState === 'temp_only') return RecoveryAction.ResumeFromRename
    return RecoveryAction.MarkError
  }

  return RecoveryAction.NoOp
}

export interface RecoveryReport {
  totalScanned: number
  recovered: Array<{ taskId: string; action: RecoveryAction; note?: string }>
  warnings: Array<{ taskId: string; action: RecoveryAction; issue: string }>
  errors: Array<{ taskId: string; action: RecoveryAction; issue: string }>
  durationMs: number
}

/**
 * Pluggable filesystem probe. Enables unit testing without touching real
 * disk — bootstrap supplies a default backed by `fs.access`.
 */
export interface RecoveryFs {
  pathExists(absPath: string): Promise<boolean>
  renameAtomic(src: string, dst: string): Promise<void>
  removePathRecursive(absPath: string): Promise<void>
}

export const defaultRecoveryFs: RecoveryFs = {
  pathExists(p: string): Promise<boolean> {
    return pathExists(p)
  },
  renameAtomic(src: string, dst: string): Promise<void> {
    return rename(src, dst)
  },
  removePathRecursive(absPath: string): Promise<void> {
    return rm(absPath, { recursive: true, force: true })
  },
}

export interface RecoveryDeps {
  taskManager: {
    getAll(): DownloadTask[]
    set?(id: string, task: DownloadTask): void
    persist(task: DownloadTask): Promise<void>
  }
  adapter: Pick<EngineAdapter, 'listActiveAndWaiting'>
  fs: RecoveryFs
  activityRecorder: TaskActivityRecorder
  finalizeTask: (taskId: string) => Promise<void>
  /**
   * Persist a task and (when non-null) its terminal occurrence in a single
   * durable transaction — used INSTEAD OF `taskManager.persist` whenever a
   * recovered transition qualifies for one (see `buildTerminalOccurrence`).
   * Optional; absence degrades to plain `taskManager.persist`.
   */
  persistTaskWithOccurrence?: (
    task: DownloadTask,
    occurrence: TaskOccurrence | null
  ) => Promise<void>
  /** Delivers a just-committed terminal occurrence to in-process consumers.
   *  Narrowed to `dispatch` so tests can supply a plain `{ dispatch }`
   *  double. */
  occurrenceDispatcher?: Pick<OccurrenceDispatcher, 'dispatch'>
  /**
   * Backing store for `applyDiagnosisUpgrade`'s CAS-guarded diagnosis
   * upgrade. RecoveryAction.MarkError uses this (together with
   * `occurrenceDispatcher`) to set a specific `errorDetailKey` on a task
   * that has already reached Error — including one a prior finalize rename
   * failure already put there. Optional so tests that never reach
   * MarkError can omit it; when either this or `occurrenceDispatcher` is
   * missing, the diagnosis upgrade is skipped (the task still lands in
   * Error, just without the refined detail key).
   */
  db?: Pick<MotrixDatabase, 'applyDiagnosisUpgradeRow'>
  log: {
    info(ctx: Record<string, unknown>, msg: string): void
    warn(ctx: Record<string, unknown>, msg: string): void
    error(ctx: Record<string, unknown>, msg: string): void
  }
  // Optional plugin-hook plumbing (Plan C / T15). When set, MarkCompleted /
  // MarkError transitions fire the parallel afterComplete / onError chains.
  // Absent → no-op.
  orchestrator?: HookOrchestrator
  recordTransition?: (input: TaskTransitionRecordInput) => void | Promise<void>
  runTaskMutation?: <T>(
    taskIds: readonly string[],
    operation: () => Promise<T>
  ) => Promise<T>
  monotonicNow?: () => number
}

export interface TaskRecoveryService {
  recoverOnStartup(): Promise<RecoveryReport>
}

export class TaskRecoveryServiceImpl implements TaskRecoveryService {
  constructor(private readonly deps: RecoveryDeps) {}

  async recoverOnStartup(): Promise<RecoveryReport> {
    const start = Date.now()
    const report: RecoveryReport = {
      totalScanned: 0,
      recovered: [],
      warnings: [],
      errors: [],
      durationMs: 0,
    }

    const publishedTasks = this.deps.taskManager.getAll()
    // Recovery mutates its working copies before republishing them, so the
    // in-flight subset is detached via structuredClone (when a publishing
    // TaskManager is wired). Filter BEFORE cloning: the normal launch has
    // zero in-flight tasks, and cloning every restored task just to discard
    // them would sit on the awaited startup path.
    const inFlightPublished = publishedTasks.filter(
      (t) =>
        t.transitionPhase !== TransitionPhase.Idle ||
        t.status === TaskStatus.Finalizing
    )
    const inFlight = this.deps.taskManager.set
      ? inFlightPublished.map((task) => structuredClone(task))
      : inFlightPublished
    report.totalScanned = inFlight.length

    if (inFlight.length === 0) {
      report.durationMs = Date.now() - start
      return report
    }

    // Only active/waiting rows can supply a live identity to adopt.
    const active = await this.deps.adapter.listActiveAndWaiting()
    const byInfoHash = new Map<string, Set<string>>()
    // Only active/waiting rows can be adopted as a live seeding identity.
    // A stopped result with the same infoHash is historical, not a seeder;
    // adopting it would strand the task in Seeding with no live engine work.
    for (const t of active) {
      if (!t.infoHash) continue
      const infoHash = t.infoHash.toLowerCase()
      const gids = byInfoHash.get(infoHash) ?? new Set<string>()
      gids.add(t.gid)
      byInfoHash.set(infoHash, gids)
    }
    // Index maps copy only primitive fields, so they are built from the
    // uncloned published list — no aliasing back into live task objects.
    const ownerByGid = new Map<string, string>()
    const taskIdsByInfoHash = new Map<string, Set<string>>()
    for (const task of publishedTasks) {
      for (const gid of collectTaskGids(task)) ownerByGid.set(gid, task.id)
      if (task.infoHash) {
        const infoHash = task.infoHash.toLowerCase()
        const taskIds = taskIdsByInfoHash.get(infoHash) ?? new Set<string>()
        taskIds.add(task.id)
        taskIdsByInfoHash.set(infoHash, taskIds)
      }
    }

    for (const task of inFlight) {
      try {
        const recover = () =>
          this.recoverTask(
            task,
            byInfoHash,
            ownerByGid,
            taskIdsByInfoHash,
            report
          )
        await (this.deps.runTaskMutation
          ? this.deps.runTaskMutation([task.id], recover)
          : recover())
      } catch (e) {
        report.errors.push({
          taskId: task.id,
          action: RecoveryAction.MarkError,
          issue: (e as Error).message,
        })
      }
    }

    report.durationMs = Date.now() - start
    this.deps.log.info(
      {
        totalScanned: report.totalScanned,
        recovered: report.recovered.length,
        warnings: report.warnings.length,
        errors: report.errors.length,
        durationMs: report.durationMs,
      },
      'recovery_completed'
    )
    return report
  }

  private async recoverTask(
    task: DownloadTask,
    byInfoHash: Map<string, Set<string>>,
    ownerByGid: Map<string, string>,
    taskIdsByInfoHash: Map<string, Set<string>>,
    report: RecoveryReport
  ): Promise<void> {
    const fsState = await this.inspectFs(task)
    const matchingGid = this.selectMatchingGid(
      task,
      byInfoHash,
      ownerByGid,
      taskIdsByInfoHash
    )

    const action = determineAction({
      phase: task.transitionPhase,
      fsState,
      aria2HasMatchingInfoHash: matchingGid !== undefined,
      taskType: task.type,
    })

    await this.applyAction(task, action, fsState, matchingGid, report)
  }

  private selectMatchingGid(
    task: DownloadTask,
    byInfoHash: Map<string, Set<string>>,
    ownerByGid: Map<string, string>,
    taskIdsByInfoHash: Map<string, Set<string>>
  ): string | undefined {
    if (!task.infoHash) return undefined
    const normalizedInfoHash = task.infoHash.toLowerCase()
    const candidates = byInfoHash.get(normalizedInfoHash)
    if (!candidates || candidates.size === 0) return undefined

    // A persisted instance GID is strong identity even when several
    // independent tasks share the same torrent content.
    const persistedGids = collectTaskGids(task)
    const exactMatches = [...candidates].filter((gid) => persistedGids.has(gid))
    if (exactMatches.length === 1) {
      const exact = exactMatches[0]
      const owner = ownerByGid.get(exact)
      if (!owner || owner === task.id) return exact
    }

    // infoHash identifies content, not a task instance. A hash-only adoption
    // is safe solely when aria2 exposes one candidate and no other Motrix task
    // already owns it. Ambiguity falls back to a fresh reseed.
    if (candidates.size !== 1) return undefined
    if ((taskIdsByInfoHash.get(normalizedInfoHash)?.size ?? 0) !== 1) {
      return undefined
    }
    const candidate = candidates.values().next().value
    if (!candidate) return undefined
    const owner = ownerByGid.get(candidate)
    return !owner || owner === task.id ? candidate : undefined
  }

  private async inspectFs(task: DownloadTask): Promise<FsState> {
    const temporaryPath = getBtPayloadPath(task) ?? task.diskPath
    if (temporaryPath === task.finalPath) {
      return (await this.deps.fs.pathExists(task.finalPath))
        ? 'final_only'
        : 'neither'
    }
    const [temp, final] = await Promise.all([
      this.deps.fs.pathExists(temporaryPath),
      this.deps.fs.pathExists(task.finalPath),
    ])
    if (temp && final) return 'both'
    if (temp) return 'temp_only'
    if (final) return 'final_only'
    return 'neither'
  }

  private async applyAction(
    task: DownloadTask,
    action: RecoveryAction,
    fsState: FsState,
    matchingGid: string | undefined,
    report: RecoveryReport
  ): Promise<void> {
    switch (action) {
      case RecoveryAction.ResumeFromRename:
        if (isMediaKind(task.kind)) {
          await this.resumeMediaRename(task, report)
          break
        }
        await this.deps.finalizeTask(task.id)
        report.recovered.push({ taskId: task.id, action })
        break
      case RecoveryAction.ResumeFromReseed:
        this.recordRecoveredCompletion(task)
        this.normalizeAlreadyRenamedPaths(task)
        setTaskTransitionPhase(task, TransitionPhase.Reseeding)
        await this.persistRecoveredState(task)
        await this.deps.finalizeTask(task.id)
        report.recovered.push({ taskId: task.id, action })
        break
      case RecoveryAction.AdoptExistingGid: {
        this.recordRecoveredCompletion(task)
        this.normalizeAlreadyRenamedPaths(task)
        // determineAction only returns AdoptExistingGid when a matching gid
        // was found; the guard restates that coupling for the type system.
        if (matchingGid === undefined) break
        const previousStatus = task.status
        task.engineTaskId = matchingGid
        setTaskTransitionPhase(task, TransitionPhase.Idle)
        Object.assign(task, applyTerminalTransition(task, TaskStatus.Seeding))
        syncPrimaryInstanceIdentity(task)
        await this.persistRecoveredTransition(task, previousStatus)
        report.warnings.push({
          taskId: task.id,
          action,
          issue: 'aria2 already had matching task; adopted its gid',
        })
        break
      }
      case RecoveryAction.MarkCompleted: {
        const detectedAt = this.recordRecoveredCompletion(task)
        const previousStatus = task.status
        this.normalizeAlreadyRenamedPaths(task)
        applyTerminalStatusToTask(task, TaskStatus.Completed, {}, detectedAt)
        setTaskTransitionPhase(task, TransitionPhase.Idle)
        await this.persistRecoveredTransition(task, previousStatus, detectedAt)
        report.recovered.push({ taskId: task.id, action })
        fireAfterComplete(this.deps, task, 'recovery')
        break
      }
      case RecoveryAction.MarkError: {
        const previousStatus = task.status
        const hasOutputConflict = fsState === 'both'
        if (!hasOutputConflict) {
          setTaskTransitionPhase(task, TransitionPhase.Idle)
        }
        const errorDetailKey = hasOutputConflict
          ? 'task.error.detail.recoveryOutputConflict'
          : 'task.error.detail.filesMissing'
        const issue = hasOutputConflict
          ? 'temporary and final outputs both exist; preserved both paths for manual review'
          : 'files missing'
        const hookErrorCode = hasOutputConflict
          ? ErrorCode.TaskRecoveryFsMismatch
          : 'RECOVERY_FILES_MISSING'
        const hookMessage = hasOutputConflict
          ? 'Recovery paused because temporary and final outputs both exist; both paths were preserved for manual review'
          : 'Files missing after app restart'

        // First, land the task in Error through the normal terminal
        // transition (a no-op if a prior finalize rename failure already put
        // it there). Only once it is guaranteed terminal can the CAS-guarded
        // diagnostic upgrade below refine its error group — applyTerminalTransition
        // intentionally preserves metadata across a repeated same-status
        // terminal transition, so it can never carry this more specific
        // diagnosis itself.
        applyTerminalStatusToTask(task, TaskStatus.Error)
        await this.persistRecoveredTransition(task, previousStatus)

        if (this.deps.db && this.deps.occurrenceDispatcher) {
          const upgrade = await applyDiagnosisUpgrade(
            { db: this.deps.db, dispatcher: this.deps.occurrenceDispatcher },
            task,
            { errorDetailKey, errorMessage: null, errorDetailParams: null },
            task.diagnosisRevision
          )
          if (upgrade.ok) {
            // The upgrade advanced the durable row and mutated `task` in
            // place, but the copy persistRecoveredTransition published above
            // is a detached pre-upgrade clone. Republish so TaskManager —
            // and the next SessionManager save, which rebuilds its payload
            // from TaskManager — carries the refined group instead of
            // overwriting it back to the pre-upgrade values at revision 0.
            this.deps.taskManager.set?.(task.id, structuredClone(task))
          } else {
            this.deps.log.warn(
              { taskId: task.id, reason: upgrade.reason },
              'recovery diagnostic upgrade skipped'
            )
          }
        }

        report.errors.push({ taskId: task.id, action, issue })
        if (hasOutputConflict) {
          this.deps.log.error(
            {
              code: ErrorCode.TaskRecoveryFsMismatch,
              taskId: task.id,
              diskPath: task.diskPath,
              finalPath: task.finalPath,
            },
            'recovery_output_conflict_preserved'
          )
        }
        fireOnError(
          this.deps,
          task,
          {
            code: hookErrorCode,
            message: hookMessage,
          },
          'recovery'
        )
        break
      }
      case RecoveryAction.NoOp:
        break
      default:
        break
    }
  }

  private recordRecoveredCompletion(task: DownloadTask): number {
    const detectedAt = Date.now()
    this.deps.activityRecorder.recordDownloadCompleted({
      taskId: task.id,
      occurredAt: detectedAt,
      accuracy: TaskActivityAccuracy.Recovered,
    })
    return detectedAt
  }

  private normalizeAlreadyRenamedPaths(task: DownloadTask): void {
    task.diskPath = task.finalPath
    for (const instance of task.instances) {
      instance.diskPath = task.finalPath
    }
  }

  private async resumeMediaRename(
    task: DownloadTask,
    report: RecoveryReport
  ): Promise<void> {
    await this.deps.fs.renameAtomic(task.diskPath, task.finalPath)
    const completedAt = Date.now()
    const previousStatus = task.status
    completeTaskAfterRename(
      task,
      task.finalPath,
      completedAt,
      this.deps.activityRecorder
    )
    await this.persistRecoveredTransition(task, previousStatus, completedAt)
    report.recovered.push({
      taskId: task.id,
      action: RecoveryAction.ResumeFromRename,
    })
    fireAfterComplete(this.deps, task, 'recovery')
  }

  private async persistRecoveredTransition(
    task: DownloadTask,
    previousStatus: TaskStatus,
    occurredAt = Date.now()
  ): Promise<void> {
    // cause: 'recovery' — every status change this function commits happens
    // during startup recovery replay (ResumeFromRename/Reseed,
    // AdoptExistingGid, MarkCompleted, MarkError).
    await commitTerminalTaskTransition(task, previousStatus, this.deps, {
      cause: 'recovery',
      callerName: 'persistRecoveredTransition',
      recordFailureMessage: 'recovery Activity transition recording failed',
      accuracy: 'recovered',
      occurredAt,
      persistPlain: (t) => this.persistRecoveredState(t),
    })
  }

  private async persistRecoveredState(task: DownloadTask): Promise<void> {
    await this.deps.taskManager.persist(task)
    this.deps.taskManager.set?.(task.id, structuredClone(task))
  }
}
