import type { TaskProgressParams } from '@motrix/mdxp'

/**
 * Latest `$/task/progress` per task id + an active-set change observer. The
 * popup renders progress from the polled `task/list` (which already carries
 * `progress`), so this store is the background's record of in-flight pushes
 * — read on completion/error to clean up and to enrich the OS notification.
 * `take` removes and returns the entry.
 *
 * `onChange` fires only when the set of in-flight ids changes membership
 * (first sight of an id, or its removal) — not on every progress tick — so
 * a badge listener refreshes on start/stop, not on every push.
 */
export class TaskEventStore {
  private readonly latest = new Map<string, TaskProgressParams>()
  private readonly listeners: Array<() => void> = []

  onChange(cb: () => void): void {
    this.listeners.push(cb)
  }

  private fire(): void {
    for (const cb of this.listeners) cb()
  }

  get size(): number {
    return this.latest.size
  }

  recordProgress(p: TaskProgressParams): void {
    const had = this.latest.has(p.taskId)
    this.latest.set(p.taskId, p)
    if (!had) this.fire()
  }

  take(taskId: string): TaskProgressParams | undefined {
    const v = this.latest.get(taskId)
    if (v !== undefined) {
      this.latest.delete(taskId)
      this.fire()
    }
    return v
  }

  /**
   * Drop all in-flight entries. Call on each fresh connection so a task that
   * completed during a WS blip (and whose `TaskCompleted` push was lost)
   * doesn't leave a stale entry that keeps `hasActiveTasks()` true forever.
   */
  clear(): void {
    if (this.latest.size > 0) {
      this.latest.clear()
      this.fire()
    }
  }
}
