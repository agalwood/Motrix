import type { EngineAdapter } from '@core/engine/engine-adapter'
import { type DownloadTask, TaskStatus } from '@shared/types/task'
import type { TaskOccurrence } from '@shared/types/task-occurrence'
import {
  buildTerminalOccurrence,
  terminalSnapshotFromTask,
} from './actions/shared'
import {
  isCompletedDirectOutput,
  isDirectFinalOutput,
} from './completed-direct-task-policy'
import { mergeEngineTask } from './merge-engine-task'
import { syncTerminalInstanceStatus } from './task-instance'
import type { TaskManager } from './task-manager'

interface CleanupDeps {
  taskManager: Pick<
    TaskManager,
    'getById' | 'getByEngineTaskId' | 'set' | 'isEngineTaskIdRetired'
  >
  adapter: Pick<EngineAdapter, 'forceRemoveTask' | 'removeDownloadResult'>
  mintTaskId: () => string
  persist: (
    task: DownloadTask,
    occurrence: TaskOccurrence | null
  ) => Promise<void>
  adopt: (task: DownloadTask, persist: () => Promise<void>) => Promise<void>
  publish: () => void
  dispatch: (occurrence: TaskOccurrence) => Promise<void>
  prepareFiles?: (task: DownloadTask) => Promise<void>
  runTaskMutation: <T>(
    ids: readonly string[],
    operation: () => Promise<T>
  ) => Promise<T>
  log: { warn(context: Record<string, unknown>, message: string): void }
}

interface PendingCompletion {
  snapshot: DownloadTask
  ownerId: string
  adopted: boolean
  attempts: number
  retryAt: number
}

function completeMetrics(task: DownloadTask): void {
  task.totalBytes = Math.max(task.totalBytes, task.downloadedBytes)
  task.downloadedBytes = task.totalBytes
  task.sizeWhenDone = task.totalBytes
  task.progress = 1
  syncTerminalInstanceStatus(task, TaskStatus.Completed)
  for (const instance of task.instances) {
    instance.totalBytes = task.totalBytes
    instance.downloadedBytes = task.downloadedBytes
    instance.progress = 100
  }
}

/**
 * Owns final-path completion from a notified snapshot through durable history
 * and engine cleanup. Failed terminal snapshots are retained for targeted
 * retries: active/waiting polling cannot rediscover an already stopped GID.
 * Persisted Completed rows remain the crash-recovery source of truth.
 */
export class CompletedEngineTaskCleanup {
  private readonly pending = new Map<string, PendingCompletion>()
  private readonly inFlight = new Map<string, Promise<void>>()
  private readonly cleaned = new Map<string, string>()
  private timer: ReturnType<typeof setTimeout> | null = null
  private stopped = false

  constructor(private readonly deps: CleanupDeps) {}

  async observe(snapshot: DownloadTask): Promise<boolean> {
    const gid = snapshot.engineTaskId
    const owner = this.deps.taskManager.getByEngineTaskId(gid)
    if (!gid || !isDirectFinalOutput(owner ?? snapshot)) return false
    if (
      !isCompletedDirectOutput(owner ?? snapshot) &&
      snapshot.status !== TaskStatus.Completed
    )
      return false
    // Other terminal outcomes and recovery quarantines retain their owners.
    if (
      owner?.status === TaskStatus.Error ||
      owner?.status === TaskStatus.Removed
    )
      return false
    if (this.stopped || this.deps.taskManager.isEngineTaskIdRetired(gid))
      return true

    const completionKey = owner ? `${owner.id}:${owner.finishedAt}` : ''
    if (
      snapshot.status === TaskStatus.Completed &&
      completionKey &&
      this.cleaned.get(gid) === completionKey
    )
      return true
    const previous = this.pending.get(gid)
    this.pending.set(gid, {
      snapshot: structuredClone(snapshot),
      ownerId: owner?.id ?? previous?.ownerId ?? this.deps.mintTaskId(),
      adopted: owner !== undefined || previous?.adopted === true,
      attempts: previous?.attempts ?? 0,
      retryAt: 0,
    })
    await this.run(gid)
    return true
  }

  async stopAndDrain(): Promise<void> {
    this.stopped = true
    if (this.timer !== null) clearTimeout(this.timer)
    this.timer = null
    await Promise.allSettled([...this.inFlight.values()])
    this.pending.clear()
  }

  private run(gid: string): Promise<void> {
    const existing = this.inFlight.get(gid)
    if (existing) return existing
    const operation = this.processPending(gid).finally(() => {
      this.inFlight.delete(gid)
      this.scheduleRetry()
    })
    this.inFlight.set(gid, operation)
    return operation
  }

  private async processPending(gid: string): Promise<void> {
    while (!this.stopped) {
      const pending = this.pending.get(gid)
      if (!pending) return
      try {
        await this.complete(gid, pending)
        if (this.pending.get(gid) === pending) this.pending.delete(gid)
      } catch (err) {
        pending.attempts++
        pending.retryAt =
          Date.now() +
          Math.min(1000 * 2 ** Math.min(pending.attempts - 1, 5), 30000)
        this.deps.log.warn(
          { err, gid, taskId: pending.ownerId },
          'completed engine task cleanup deferred'
        )
        return
      }
    }
  }

  private async complete(
    gid: string,
    pending: PendingCompletion
  ): Promise<void> {
    if (this.deps.taskManager.isEngineTaskIdRetired(gid)) return
    if (!pending.adopted) {
      const existing = this.deps.taskManager.getByEngineTaskId(gid)
      if (existing) {
        pending.ownerId = existing.id
        pending.adopted = true
      } else {
        const task = structuredClone(pending.snapshot)
        task.id = pending.ownerId
        for (const instance of task.instances) instance.motrixId = task.id
        completeMetrics(task)
        const occurrence = buildTerminalOccurrence(
          terminalSnapshotFromTask(task),
          TaskStatus.Queued,
          'engine'
        )
        await this.deps.adopt(task, () => this.deps.persist(task, occurrence))
        this.deps.taskManager.set(task.id, task)
        pending.adopted = true
        this.deps.publish()
        if (occurrence) await this.deps.dispatch(occurrence)
      }
    }

    await this.deps.runTaskMutation([pending.ownerId], async () => {
      const current = this.deps.taskManager.getById(pending.ownerId)
      if (
        !current ||
        current.engineTaskId !== gid ||
        !isDirectFinalOutput(current)
      )
        return
      if (
        current.status === TaskStatus.Error ||
        current.status === TaskStatus.Removed
      )
        return
      let completed = current
      if (!isCompletedDirectOutput(current)) {
        if (pending.snapshot.status !== TaskStatus.Completed) return
        completed = structuredClone(mergeEngineTask(current, pending.snapshot))
        completeMetrics(completed)
        const occurrence = buildTerminalOccurrence(
          terminalSnapshotFromTask(completed),
          current.status,
          'engine'
        )
        await this.deps.persist(completed, occurrence)
        this.deps.taskManager.set(completed.id, completed)
        this.deps.publish()
        if (occurrence) await this.deps.dispatch(occurrence)
      }
      const key = `${completed.id}:${completed.finishedAt}`
      if (
        pending.snapshot.status === TaskStatus.Completed &&
        this.cleaned.get(gid) === key
      )
        return
      await this.deps.prepareFiles?.(completed)
      if (
        ![TaskStatus.Completed, TaskStatus.Error, TaskStatus.Removed].includes(
          pending.snapshot.status
        )
      ) {
        await this.deps.adapter.forceRemoveTask(gid)
      }
      await this.deps.adapter.removeDownloadResult(gid)
      this.cleaned.set(gid, key)
      // Cache only avoids redundant RPCs; eviction never weakens durable history.
      if (this.cleaned.size > 4096) {
        const oldest = this.cleaned.keys().next().value
        if (oldest !== undefined) this.cleaned.delete(oldest)
      }
    })
  }

  private scheduleRetry(): void {
    if (this.stopped || this.timer !== null || this.pending.size === 0) return
    const waiting = [...this.pending].filter(([gid]) => !this.inFlight.has(gid))
    if (waiting.length === 0) return
    const next = Math.min(...waiting.map(([, entry]) => entry.retryAt))
    this.timer = setTimeout(
      () => {
        this.timer = null
        for (const [gid, entry] of this.pending) {
          if (entry.retryAt <= Date.now()) void this.run(gid)
        }
        this.scheduleRetry()
      },
      Math.max(1, next - Date.now())
    )
    this.timer.unref?.()
  }
}
