import type { CompletionShutdownState } from '@shared/schemas/completion-shutdown'
import {
  type DownloadTask,
  TaskStatus,
  TransitionPhase,
} from '@shared/types/task'

export interface ShutdownPreparation {
  drain(): Promise<void>
  hasIncomingWork(): boolean
  release(): void
}

interface Dependencies {
  supported: boolean
  getTasks(): DownloadTask[]
  isReady(): boolean
  probe(): Promise<void>
  prepare(): ShutdownPreparation
  save(): Promise<void>
  requestShutdown(): Promise<void>
  onState(state: CompletionShutdownState): void
  onError(error: unknown): void
}

const COUNTDOWN_MS = 60_000

function isFinished(task: DownloadTask): boolean {
  return (
    (task.status === TaskStatus.Completed ||
      task.status === TaskStatus.Seeding) &&
    task.transitionPhase === TransitionPhase.Idle
  )
}

/** Process-local, one-shot intent. Neither restored history nor an empty queue arms it. */
export class CompletionShutdownController {
  private state: CompletionShutdownState
  private generation = 0
  private participants = new Set<string>()
  private historical: Set<string> | null = null
  private authorizing = false
  private timer: ReturnType<typeof setInterval> | null = null
  private lastTick = 0
  private lastMonotonicTick = 0
  private monotonicDeadline = 0
  private preparation: ShutdownPreparation | null = null
  private disposed = false

  constructor(private readonly deps: Dependencies) {
    this.state = {
      supported: deps.supported,
      phase: 'off',
      deadline: null,
      error: null,
    }
  }

  getState(): CompletionShutdownState {
    return { ...this.state }
  }

  async setEnabled(enabled: boolean): Promise<CompletionShutdownState> {
    if (this.disposed) return this.getState()
    if (!enabled) {
      this.cancel()
      return this.getState()
    }
    if (
      this.authorizing ||
      ['waiting', 'countdown', 'preparing', 'requested'].includes(
        this.state.phase
      )
    )
      return this.getState()
    const generation = ++this.generation
    this.participants.clear()
    this.historical = null
    this.authorizing = true
    this.collectTasks()
    try {
      if (!this.deps.supported)
        throw new Error('Shutdown is unavailable on this host')
      await this.deps.probe()
    } catch (error) {
      if (generation === this.generation) {
        this.authorizing = false
        this.deps.onError(error)
        this.update('failed', null, 'unavailable')
      }
      return this.getState()
    }
    if (generation !== this.generation) return this.getState()
    this.authorizing = false
    this.update('waiting')
    this.lastTick = Date.now()
    this.lastMonotonicTick = performance.now()
    this.timer = setInterval(() => this.evaluate(), 1_000)
    this.evaluate()
    return this.getState()
  }

  cancel(): void {
    ++this.generation
    this.clearTimer()
    this.preparation?.release()
    this.preparation = null
    this.participants.clear()
    this.historical = null
    this.authorizing = false
    this.update('off')
  }

  /** Suspend, reconnect and new work always invalidate the old deadline. */
  interrupt(): void {
    if (this.state.phase !== 'countdown' && this.state.phase !== 'preparing')
      return
    ++this.generation
    this.preparation?.release()
    this.preparation = null
    this.update('waiting')
  }

  evaluate(): void {
    if (this.authorizing) {
      this.collectTasks()
      return
    }
    if (['waiting', 'countdown', 'preparing'].includes(this.state.phase))
      this.observeClock()
    if (this.state.phase === 'preparing') {
      if (!this.ready()) this.interrupt()
      return
    }
    if (this.state.phase !== 'waiting' && this.state.phase !== 'countdown')
      return
    if (!this.ready()) {
      if (this.state.phase === 'countdown') this.interrupt()
      return
    }
    if (this.state.phase === 'waiting') {
      this.monotonicDeadline = performance.now() + COUNTDOWN_MS
      this.update('countdown', Date.now() + COUNTDOWN_MS)
    } else if (
      this.state.deadline !== null &&
      performance.now() >= this.monotonicDeadline
    ) {
      void this.execute()
    }
  }

  private observeClock(): void {
    const wall = Date.now()
    const monotonic = performance.now()
    const elapsed = monotonic - this.lastMonotonicTick
    if (elapsed > 5_000 || Math.abs(wall - this.lastTick - elapsed) > 5_000)
      this.interrupt()
    this.lastTick = wall
    this.lastMonotonicTick = monotonic
  }

  private collectTasks(): DownloadTask[] | null {
    // Establish the history baseline only once startup/restore is ready.
    if (!this.deps.isReady()) return null
    const tasks = this.deps
      .getTasks()
      .filter((task) => task.status !== TaskStatus.Removed)
    this.historical ??= new Set(
      tasks
        .filter((task) => task.status === TaskStatus.Completed)
        .map((task) => task.id)
    )
    const ids = new Set(tasks.map((task) => task.id))
    // Removing participating tasks cancels the plan; deleting is not completion.
    if ([...this.participants].some((id) => !ids.has(id))) {
      this.cancel()
      return null
    }
    let added = false
    for (const task of tasks) {
      if (
        (!this.historical.has(task.id) ||
          task.status !== TaskStatus.Completed) &&
        !this.participants.has(task.id)
      ) {
        this.participants.add(task.id)
        added = true
      }
    }
    if (added) this.interrupt()
    return tasks
  }

  private ready(): boolean {
    const tasks = this.collectTasks()
    return (
      tasks !== null && this.participants.size > 0 && tasks.every(isFinished)
    )
  }

  private async execute(): Promise<void> {
    const generation = ++this.generation
    this.update('preparing')
    let timeout: ReturnType<typeof setTimeout> | undefined
    let preparation: ShutdownPreparation | undefined
    const current = () => generation === this.generation && !this.disposed
    try {
      preparation = this.deps.prepare()
      this.preparation = preparation
      const lease = preparation
      let saved = false
      await Promise.race([
        lease.drain().then(async () => {
          if (
            !current() ||
            lease.hasIncomingWork() ||
            !this.ready() ||
            !current()
          )
            return
          await this.deps.save()
          saved = true
        }),
        new Promise<never>((_, reject) => {
          timeout = setTimeout(
            () => reject(new Error('Shutdown preparation timed out')),
            10_000
          )
        }),
      ])
      if (!current()) return
      this.observeClock()
      if (!current()) return
      if (!saved || lease.hasIncomingWork() || !this.ready() || !current()) {
        if (current()) this.update('waiting')
        return
      }
      // No await between the last check and invoking the fixed platform action.
      this.clearTimer()
      this.update('requested')
      if (!current()) return
      await this.deps.requestShutdown()
    } catch (error) {
      if (current()) {
        ++this.generation
        this.clearTimer()
        this.deps.onError(error)
        this.update('failed', null, 'failed')
      }
    } finally {
      if (timeout !== undefined) clearTimeout(timeout)
      preparation?.release()
      if (this.preparation === preparation) this.preparation = null
    }
  }

  private update(
    phase: CompletionShutdownState['phase'],
    deadline: number | null = null,
    error: CompletionShutdownState['error'] = null
  ): void {
    this.state = { supported: this.deps.supported, phase, deadline, error }
    this.deps.onState(this.getState())
  }

  private clearTimer(): void {
    if (this.timer !== null) clearInterval(this.timer)
    this.timer = null
  }

  dispose(): void {
    this.disposed = true
    this.cancel()
  }
}
