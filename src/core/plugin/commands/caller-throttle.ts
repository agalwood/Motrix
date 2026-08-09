// src/core/plugin/commands/caller-throttle.ts
//
// Anti-DoS throttle that blocks a misbehaving caller plugin after it
// accumulates too many schema-invalid args attempts.
//
// Why this exists (Plan D Spec §5 / I9):
// - When a caller plugin sends arguments that fail the callee's command
//   schema, the callee's `callee-breaker` would normally trip on repeated
//   failures. A malicious caller could therefore weaponize a single
//   well-known callee command to brick *every* callee it can reach.
// - To stop that, the cross-plugin invoker also runs each invalid args
//   event through this caller-side throttle. Once a single caller
//   accumulates `threshold` invalid attempts inside `windowMs`, the
//   caller itself is blocked for `blockMs` regardless of which callee it
//   was targeting.
//
// Implementation notes:
// - Two internal Maps: `invalidWindows` holds the sliding-window
//   timestamps of recent invalid attempts; `blockedUntil` holds the
//   absolute expiry timestamp once a block is armed.
// - All operations are synchronous and rely on `Date.now()` at the
//   point of inspection — no internal timers or schedulers. Tests use
//   `vi.useFakeTimers()` to drive the clock.
// - `isBlocked` cleans up expired blocks transparently to keep memory
//   bounded across long-lived processes.

export interface CallerThrottleOpts {
  threshold: number
  windowMs: number
  blockMs: number
}

export class CallerThrottle {
  private readonly threshold: number
  private readonly windowMs: number
  private readonly blockMs: number
  private readonly invalidWindows = new Map<string, number[]>()
  private readonly blockedUntil = new Map<string, number>()

  constructor(opts: CallerThrottleOpts) {
    this.threshold = opts.threshold
    this.windowMs = opts.windowMs
    this.blockMs = opts.blockMs
  }

  isBlocked(caller: string): boolean {
    const until = this.blockedUntil.get(caller)
    if (until === undefined) {
      return false
    }
    if (Date.now() >= until) {
      // Block has expired — clean up so memory stays bounded.
      this.blockedUntil.delete(caller)
      return false
    }
    return true
  }

  recordInvalid(caller: string): void {
    const now = Date.now()
    const cutoff = now - this.windowMs
    const existing = this.invalidWindows.get(caller)
    const fresh =
      existing === undefined ? [] : existing.filter((ts) => ts > cutoff)
    fresh.push(now)

    if (fresh.length >= this.threshold) {
      // Arm the block and reset the rolling window — once blocked, we
      // restart accounting from scratch so post-block records have to
      // accumulate a fresh `threshold` to re-arm.
      this.blockedUntil.set(caller, now + this.blockMs)
      this.invalidWindows.delete(caller)
      return
    }

    this.invalidWindows.set(caller, fresh)
  }

  reset(caller: string): void {
    this.invalidWindows.delete(caller)
    this.blockedUntil.delete(caller)
  }
}
