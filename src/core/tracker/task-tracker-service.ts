import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import type {
  BtTrackerPolicy,
  EngineAdapter,
} from '@core/engine/engine-adapter'
import { hasLegacyImport } from '@core/legacy-import/legacy-task-policy'
import type { TaskManager } from '@core/task/task-manager'
import { AppError, ErrorCode } from '@shared/errors'
import type {
  TaskTrackerOwnership,
  TaskTrackerPlan,
  TaskTrackerState,
} from '@shared/schemas/task-tracker'
import { type DownloadTask, TaskStatus } from '@shared/types/task'
import parseTorrent from 'parse-torrent'
import type { TaskTrackerRepository } from './task-tracker-repository'
import type { TrackerTaskActions } from './tracker-manager'

const unique = (urls: readonly string[]) => [...new Set(urls)]
const same = (a: string[], b: string[]) =>
  a.length === b.length && a.every((url) => b.includes(url))
const active = (task: DownloadTask) =>
  [
    TaskStatus.Downloading,
    TaskStatus.Seeding,
    TaskStatus.FetchingMetadata,
  ].includes(task.status)
const terminal = (task: DownloadTask) =>
  [
    TaskStatus.Completed,
    TaskStatus.Error,
    TaskStatus.Removed,
    TaskStatus.Finalizing,
    TaskStatus.MetadataReady,
  ].includes(task.status)

export interface TaskTrackerDependencies {
  adapter: EngineAdapter
  tasks: Pick<TaskManager, 'getById' | 'getByEngineTaskId' | 'getAll'>
  repository: Pick<TaskTrackerRepository, 'get' | 'save' | 'pendingTaskIds'>
  selected: () => string[]
  actions: TrackerTaskActions
}

/** Owns only supplemental options. Native announce tiers never pass through a write. */
export class TaskTrackerService {
  private operations = new Map<string, Promise<unknown>>()
  private stopped = false
  private controlIntents = new Map<string, boolean>()
  constructor(private readonly deps: TaskTrackerDependencies) {}

  private current(taskId: string, gid: string): DownloadTask {
    const task = this.deps.tasks.getById(taskId)
    if (!task || task.engineTaskId !== gid || terminal(task))
      throw new Error('Tracker task changed; refresh and try again')
    return task
  }

  private writable(taskId: string, gid: string): DownloadTask {
    const task = this.current(taskId, gid)
    if (hasLegacyImport(task))
      throw new AppError(
        ErrorCode.EngineFeatureUnavailable,
        'legacyImport.trackersReadOnly'
      )
    return task
  }

  private run<T>(taskId: string, operation: () => Promise<T>): Promise<T> {
    if (this.stopped)
      return Promise.reject(new Error('Tracker service stopped'))
    const prior = this.operations.get(taskId) ?? Promise.resolve()
    const next = prior
      .catch(() => undefined)
      .then(() =>
        this.deps.actions.runTaskMutation
          ? this.deps.actions.runTaskMutation([taskId], operation)
          : operation()
      )
    this.operations.set(taskId, next)
    void next
      .finally(() => {
        if (this.operations.get(taskId) === next) {
          this.operations.delete(taskId)
          this.controlIntents.delete(taskId)
        }
      })
      .catch(() => undefined)
    return next
  }

  noteTaskControl(taskId: string, paused: boolean): void {
    const task = this.deps.tasks.getById(taskId)
    if (task && hasLegacyImport(task)) return
    if (this.operations.has(taskId)) this.controlIntents.set(taskId, paused)
    const state = this.deps.repository.get(taskId)
    if (state?.pending)
      this.deps.repository.save(taskId, {
        ...state,
        pending: { ...state.pending, resumeRequired: !paused },
      })
  }

  /** Called after a durable reserved owner exists, before every engine add/re-add.
   * Unknown magnets get no global supplements until metadata confirms public BT. */
  readonly prepareCreation: BtTrackerPolicy = async ({
    engineGid,
    metadata,
    manual,
    isPrivate,
  }) => {
    if (this.stopped) throw new Error('Tracker service stopped')
    let privacy: boolean | null = isPrivate === true ? true : null
    let original: string[] = []
    if (metadata) {
      try {
        const parsed = await parseTorrent(metadata)
        privacy = isPrivate === true || parsed.private === true
        original = unique(parsed.announce ?? [])
      } catch {
        /* Invalid metadata is rejected by the engine; never expand it. */
      }
    }
    const task = engineGid
      ? this.deps.tasks.getByEngineTaskId(engineGid)
      : undefined
    if (!task || task.engineTaskId !== engineGid)
      return { trackers: manual, isPrivate: privacy === true }
    // A re-add keeps the reserved owner's terminal status until the engine
    // accepts its new GID. Creation owns that GID; live-edit eligibility does
    // not apply, but imported tasks still cannot acquire tracker ownership.
    if (hasLegacyImport(task))
      throw new AppError(
        ErrorCode.EngineFeatureUnavailable,
        'legacyImport.trackersReadOnly'
      )
    const saved = this.deps.repository.get(task.id)
    const retainedManual =
      privacy === true
        ? saved?.isPrivate === true
          ? saved.manual
          : []
        : unique([...(saved?.manual ?? []), ...manual])
    const excluded = saved?.excluded ?? []
    const managed =
      privacy === false
        ? this.deps
            .selected()
            .filter((url) => !excluded.includes(url) && !original.includes(url))
        : []
    const trackers = unique([...retainedManual, ...managed])
    const next: TaskTrackerOwnership = {
      engineGid,
      revision: (saved?.revision ?? 0) + 1,
      original,
      manual: retainedManual,
      managed,
      excluded,
      isPrivate: privacy,
    }
    // The intent is durable before dispatch. Recovery verifies actual options;
    // never infer successful engine application from a desired snapshot alone.
    this.deps.repository.save(task.id, {
      ...next,
      pending: { before: [], after: trackers, next, resumeRequired: false },
    })
    return { trackers, isPrivate: privacy === true }
  }

  private async read(taskId: string, gid: string) {
    this.current(taskId, gid)
    const effective = unique(await this.deps.adapter.getTaskBtTracker(gid))
    const task = this.current(taskId, gid)
    const saved = this.deps.repository.get(taskId)
    const matching = saved?.engineGid === gid ? saved : null
    // Existing upgrades are deliberately unowned. Observed URLs become manual,
    // never managed merely because they also occur in the global selection.
    // aria2 tellStatus announceList includes supplemental options. Only the
    // original metainfo (or a creation-time snapshot of it) proves nativeness.
    let original = matching?.original ?? []
    let privacy = matching?.isPrivate ?? null
    if (!matching) {
      if (task.torrentMetaPath) {
        try {
          const parsed = await parseTorrent(
            await readFile(task.torrentMetaPath)
          )
          original = unique(parsed.announce ?? [])
          privacy = parsed.private === true
        } catch {
          // Missing metadata cannot establish a removable native baseline.
          original = unique(task.bt?.announceList.flat() ?? [])
        }
      } else {
        original = unique(
          task.uris
            .filter((uri) => uri.startsWith('magnet:'))
            .flatMap((uri) => new URL(uri).searchParams.getAll('tr'))
        )
      }
      this.current(taskId, gid)
    }
    const state: TaskTrackerState = matching ?? {
      engineGid: gid,
      revision: saved?.revision ?? 0,
      original,
      manual: effective,
      managed: [],
      excluded: saved?.excluded ?? [],
      isPrivate: privacy,
      pending: null,
    }
    const isPrivate = task.bt?.isPrivate === true ? true : state.isPrivate
    const manual = unique([
      ...state.manual.filter((url) => effective.includes(url)),
      ...effective.filter((url) => !state.managed.includes(url)),
    ])
    return { task, effective, state: { ...state, original, manual, isPrivate } }
  }

  private async build(taskId: string, gid: string) {
    const { task, effective, state } = await this.read(taskId, gid)
    if (state.pending)
      throw new Error('Tracker update awaits recovery; retry shortly')
    const selected =
      state.isPrivate === false
        ? unique(this.deps.selected()).filter(
            (url) =>
              !state.excluded.includes(url) && !state.original.includes(url)
          )
        : []
    // A private/unknown task may retire previously managed public supplements,
    // but must never gain new ones. Original/manual overlap remains protected.
    const after = unique([
      ...state.manual,
      ...effective.filter((url) => state.original.includes(url)),
      ...selected,
    ])
    const next = { ...state, managed: selected, revision: state.revision + 1 }
    const added = after.filter((url) => !effective.includes(url))
    const removed = effective.filter((url) => !after.includes(url))
    const fingerprint = createHash('sha256')
      .update(
        JSON.stringify({
          taskId,
          gid,
          effective: [...effective].sort(),
          state,
          after,
          active: active(task),
        })
      )
      .digest('hex')
    const plan: TaskTrackerPlan = {
      taskId,
      engineGid: gid,
      fingerprint,
      added,
      removed,
      retained: effective.filter((url) => after.includes(url)),
      original: state.original,
      excluded: state.excluded,
      requiresPause: active(task) && added.length + removed.length > 0,
      protected: state.isPrivate !== false,
    }
    return { plan, state, next, effective, after }
  }

  plan(taskId: string, gid: string): Promise<TaskTrackerPlan> {
    return this.run(taskId, async () => {
      this.writable(taskId, gid)
      await this.recoverTask(taskId)
      return (await this.build(taskId, gid)).plan
    })
  }

  apply(taskId: string, gid: string, fingerprint: string): Promise<void> {
    return this.run(taskId, async () => {
      this.writable(taskId, gid)
      await this.recoverTask(taskId)
      const { plan, state, next, effective, after } = await this.build(
        taskId,
        gid
      )
      if (plan.fingerprint !== fingerprint)
        throw new Error('Tracker preview is stale; refresh and try again')
      await this.write(taskId, gid, state, next, effective, after)
    })
  }

  edit(taskId: string, gid: string, urls: string[]): Promise<void> {
    return this.run(taskId, async () => {
      this.writable(taskId, gid)
      await this.recoverTask(taskId)
      const { effective, state } = await this.read(taskId, gid)
      const requested = unique(urls)
      if (requested.some((url) => !/^(https?|udp):\/\/[^\s,]+$/i.test(url)))
        throw new Error('Invalid tracker URL')
      const removed = state.managed.filter((url) => !requested.includes(url))
      const excluded = unique([...state.excluded, ...removed]).filter(
        (url) => !requested.includes(url)
      )
      const managed = state.managed.filter((url) => requested.includes(url))
      // Unchanged managed rows stay managed; explicitly re-added excluded rows
      // become manual. Editing is never allowed to alter native announce tiers.
      const manual = requested.filter(
        (url) => !managed.includes(url) || state.manual.includes(url)
      )
      const after = unique([
        ...requested,
        ...effective.filter((url) => state.original.includes(url)),
      ])
      const next = {
        ...state,
        revision: state.revision + 1,
        manual,
        managed,
        excluded,
      }
      await this.write(taskId, gid, state, next, effective, after)
    })
  }

  private async write(
    taskId: string,
    gid: string,
    state: TaskTrackerState,
    next: TaskTrackerOwnership,
    before: string[],
    after: string[]
  ): Promise<void> {
    this.writable(taskId, gid)
    const task = await this.deps.adapter.getTaskStatus(gid)
    this.writable(taskId, gid)
    if (!task || terminal(task))
      throw new Error('Tracker engine task unavailable')
    if (same(before, after)) {
      this.deps.repository.save(taskId, { ...next, pending: null })
      return
    }
    const journal: TaskTrackerState = {
      ...state,
      lastError: undefined,
      pending: {
        before,
        after,
        next,
        resumeRequired:
          this.controlIntents.get(taskId) !== true && active(task),
      },
    }
    this.deps.repository.save(taskId, journal)
    let phase: 'pause' | 'write' = 'pause'
    try {
      if (active(task)) await this.deps.actions.pauseTask(taskId)
      this.writable(taskId, gid)
      if (
        this.current(taskId, gid).bt?.isPrivate === true &&
        next.isPrivate === false
      )
        throw new Error('Torrent privacy changed')
      phase = 'write'
      await this.deps.adapter.setTaskBtTracker(gid, after)
      this.writable(taskId, gid)
    } catch (error) {
      this.recordFailure(taskId, phase)
      throw error
    } finally {
      // RPC may apply then reject/lose its response. Re-read actual options,
      // commit only what is proven, and retain the journal if recovery fails.
      await this.recoverTask(taskId)
    }
  }

  private recordFailure(
    taskId: string,
    phase: 'pause' | 'write' | 'resume' | 'recovery'
  ): void {
    const state = this.deps.repository.get(taskId)
    if (state?.pending)
      this.deps.repository.save(taskId, {
        ...state,
        lastError: { phase, at: Date.now() },
      })
  }

  private async recoverTask(taskId: string): Promise<void> {
    try {
      await this.reconcilePending(taskId)
    } catch (error) {
      this.recordFailure(taskId, 'recovery')
      throw error
    }
  }

  private async reconcilePending(taskId: string): Promise<void> {
    const state = this.deps.repository.get(taskId)
    const pending = state?.pending
    if (!state || !pending) return
    const task = this.deps.tasks.getById(taskId)
    if (
      !task ||
      hasLegacyImport(task) ||
      task.engineTaskId !== state.engineGid ||
      terminal(task)
    )
      return
    const engineTask = await this.deps.adapter.getTaskStatus(state.engineGid)
    if (!engineTask)
      throw new Error('Tracker engine task unavailable; recovery pending')
    const actual = unique(
      await this.deps.adapter.getTaskBtTracker(state.engineGid)
    )
    this.current(taskId, state.engineGid)
    let recovered: TaskTrackerOwnership = state
    if (same(actual, pending.after)) recovered = pending.next
    else if (!same(actual, pending.before)) {
      // An external client or an interrupted generation changed the options.
      // Preserve every observed URL and surrender ambiguous ownership.
      recovered = {
        ...state,
        manual: actual,
        managed: [],
        revision: state.revision + 1,
      }
    }
    const latest = this.deps.repository.get(taskId)
    if (
      latest?.pending?.resumeRequired &&
      this.controlIntents.get(taskId) !== true
    ) {
      const current = this.writable(taskId, state.engineGid)
      if (
        current.status === TaskStatus.Paused ||
        engineTask.status === TaskStatus.Paused
      )
        try {
          await this.deps.actions.resumeTask(taskId)
        } catch (error) {
          this.recordFailure(taskId, 'resume')
          throw error
        }
      this.current(taskId, state.engineGid)
    }
    this.deps.repository.save(taskId, {
      ...recovered,
      lastError: latest?.lastError,
      pending: null,
    })
  }

  private recovery: Promise<void> | null = null
  recover(): Promise<void> {
    if (this.stopped) return Promise.resolve()
    if (this.recovery) return this.recovery
    const ids = unique([
      ...this.deps.repository.pendingTaskIds(),
      ...this.deps.tasks
        .getAll()
        .filter(
          (task) =>
            task.bt &&
            !hasLegacyImport(task) &&
            !terminal(task) &&
            !this.deps.repository.get(task.id)
        )
        .map((task) => task.id),
    ])
    // Bound background RPC work; never pause an active task to adopt a legacy
    // baseline. Existing addresses are retained as manual, not guessed managed.
    this.recovery = (async () => {
      let index = 0
      await Promise.allSettled(
        Array.from({ length: Math.min(4, ids.length) }, async () => {
          while (index < ids.length && !this.stopped) {
            const id = ids[index++]
            if (!id) break
            await this.run(id, async () => {
              await this.recoverTask(id)
              if (this.deps.repository.get(id)) return
              const task = this.deps.tasks.getById(id)
              if (!task || hasLegacyImport(task) || terminal(task)) return
              if (!(await this.deps.adapter.getTaskStatus(task.engineTaskId)))
                return
              const { state } = await this.read(id, task.engineTaskId)
              this.deps.repository.save(id, state)
            }).catch(() => undefined)
          }
        })
      )
    })().finally(() => {
      this.recovery = null
    })
    return this.recovery
  }
  async stopAndDrain(): Promise<void> {
    this.stopped = true
    await Promise.allSettled([...this.operations.values()])
  }
}
