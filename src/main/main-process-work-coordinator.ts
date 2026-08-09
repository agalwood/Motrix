import { AsyncWorkTracker } from '@core/inspector-activity'

/**
 * Owns every main-process operation that may touch lifecycle-managed state.
 *
 * Startup has a separate settled barrier because renderer/bridge requests may
 * be accepted before restore begins. Both startup and those accepted requests
 * still run through the same tracker, so shutdown can gate new work and drain
 * the whole dependency chain before disposing Activity or closing SQLite.
 */
export class MainProcessWorkCoordinator {
  private readonly tracker = new AsyncWorkTracker()
  private readonly startupSettled: Promise<void>
  private resolveStartupSettled!: () => void
  private startupWork: Promise<void> | null = null
  private startupDidSettle = false

  constructor() {
    this.startupSettled = new Promise<void>((resolve) => {
      this.resolveStartupSettled = resolve
    })
  }

  startStartup(operation: () => Promise<void>): Promise<void> {
    if (this.startupWork) return this.startupWork

    const work = this.tracker.run(operation)
    this.startupWork = work
    void work
      .finally(() => {
        this.settleStartup()
      })
      .catch(() => {
        // The caller owns startup error reporting. This catch observes only the
        // derived finally promise so it cannot become an unhandled rejection.
      })
    return work
  }

  waitForStartup(): Promise<void> {
    return this.startupSettled
  }

  run<T>(operation: () => Promise<T>): Promise<T> {
    return this.tracker.run(operation)
  }

  isAccepting(): boolean {
    return this.tracker.isAccepting()
  }

  stopAndDrain(): Promise<void> {
    // Fatal cleanup can begin before app.whenReady starts restore. Release any
    // already-waiting request; its tracked wrapper will then drain or reject
    // before Activity/SQLite disposal.
    if (!this.startupWork) this.settleStartup()
    return this.tracker.stopAndDrain()
  }

  private settleStartup(): void {
    if (this.startupDidSettle) return
    this.startupDidSettle = true
    this.resolveStartupSettled()
  }
}
