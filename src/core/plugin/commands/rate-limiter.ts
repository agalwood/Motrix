// src/core/plugin/commands/rate-limiter.ts
//
// Sliding-window rate limiter for cross-plugin command invocations.
//
// Keyed on (caller pluginId, callee pluginId) pairs. Plan D's
// CrossPluginInvoker calls consume() before forwarding a command and
// throws PluginRuntimeFault when the budget is exhausted.
//
// Implementation notes:
// - Per-key timestamp array. On each consume() we drop entries older than
//   `windowMs`, then either reject (>= limit) or push the new timestamp.
// - Map entries persist for the lifetime of the limiter. Plugin IDs are
//   bounded and there is no explicit prune step, so total memory stays at
//   O(active pairs * limit) timestamps — acceptable for this workload.
// - In-memory only; state does not persist across restarts (matches the
//   caller-throttle posture in the spec).

export interface RateLimiterOpts {
  limit: number
  windowMs: number
}

export class RateLimiter {
  private readonly limit: number
  private readonly windowMs: number
  private readonly windows = new Map<string, number[]>()

  constructor(opts: RateLimiterOpts) {
    this.limit = opts.limit
    this.windowMs = opts.windowMs
  }

  consume(caller: string, callee: string): boolean {
    const key = `${caller}->${callee}`
    const now = Date.now()
    const cutoff = now - this.windowMs
    const existing = this.windows.get(key)
    const fresh =
      existing === undefined ? [] : existing.filter((ts) => ts > cutoff)

    if (fresh.length >= this.limit) {
      // Saturated. Persist the trimmed window so future calls see the
      // accurate state, then reject.
      this.windows.set(key, fresh)
      return false
    }

    fresh.push(now)
    this.windows.set(key, fresh)
    return true
  }
}
