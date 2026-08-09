// src/core/plugin/commands/chain-depth.ts
//
// Per-task chain depth tracker for cross-plugin command invocations.
//
// Why this exists (Plan D Spec §5):
// - Plugin A invokes a command on plugin B; B's handler in turn invokes a
//   command on plugin C (or back on A). Without a hop ceiling, two
//   plugins can ping-pong each other indefinitely and exhaust the stack.
// - CrossPluginInvoker scopes the counter by the root-task id that
//   originated the chain, so concurrent root tasks each get their own
//   independent depth budget.
//
// This class is intentionally a pure counter:
// - It does NOT enforce `max` — callers compare the returned depth
//   against `tracker.max` and reject. Keeping ChainDepth dumb lets the
//   invoker own the access-denial path (audit logging, AppError
//   construction, telemetry) without having to catch from inside this
//   class.
// - It does NOT clamp at zero by mutating state — `exit` on a missing
//   or already-zero entry is a no-op rather than throwing, so a buggy
//   caller cannot poison the map with negative counts.

export class ChainDepth {
  readonly max: number
  private readonly depths = new Map<string, number>()

  constructor(max = 8) {
    this.max = max
  }

  enter(taskId: string): number {
    const next = (this.depths.get(taskId) ?? 0) + 1
    this.depths.set(taskId, next)
    return next
  }

  exit(taskId: string): void {
    const current = this.depths.get(taskId)
    if (current === undefined) {
      return
    }
    if (current <= 1) {
      this.depths.delete(taskId)
      return
    }
    this.depths.set(taskId, current - 1)
  }

  current(taskId: string): number {
    return this.depths.get(taskId) ?? 0
  }
}
