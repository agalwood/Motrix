// MBP1 reconnect rate limiting (docs/bridge-pairing-protocol.md §8).
//
// §8 closes with "Reconnect attempts are rate-limited per verified origin and
// globally." This is that limiter, and it is deliberately NOT `PairFloodControl`:
//
//   - §7.3's counter bounds how often the USER is interrupted by an approval
//     dialog, and escalates a lockout on failed code guesses. Its unit is a
//     pairing attempt that a human saw.
//   - This one bounds how fast a peer may attempt the §8 challenge–response at
//     all. No human is involved and nothing is being guessed: the credential
//     either verifies or it does not.
//
// Sharing counters between the two would be a bug in both directions. Reconnect
// churn — which a flaky network produces on its own — would drive the pairing
// lockout and stop the user from pairing a new browser; and a run of failed
// code entries would block a legitimate extension from reconnecting.
//
// `PreAuthTable` is not a substitute either. Its cap of 32 bounds CONCURRENT
// pre-authentication sockets, which is a concurrency bound, not a rate: a peer
// that connects, fails the challenge, and disconnects holds no slot and can
// repeat immediately, as fast as the loop allows.
//
// This module logs nothing at any level (§11): verified origins are the only
// input, and they identify a principal.

/** Per-verified-origin attempts per rolling minute. */
const DEFAULT_PER_ORIGIN_PER_MINUTE = 10

/**
 * Global attempts per rolling minute.
 *
 * It MUST stay above the per-origin allowance, and the gap is what stops one
 * noisy origin from starving every other: a single origin is cut off by its own
 * quota long before it can consume the global budget. A `perOrigin` raised to
 * meet `global` would reintroduce exactly that starvation.
 */
const DEFAULT_GLOBAL_PER_MINUTE = 60

const RATE_WINDOW_MS = 60_000

export interface ReconnectRateLimitOptions {
  /** Per-verified-origin attempts per rolling minute. Default 10 (§8). */
  perOriginPerMinute?: number
  /** Global attempts per rolling minute. Default 60 (§8). */
  globalPerMinute?: number
  /** Injectable clock (tests). Default `Date.now`. */
  now?: () => number
}

export class ReconnectRateLimit {
  private readonly perOriginPerMinute: number
  private readonly globalPerMinute: number
  private readonly now: () => number

  /** Attempt timestamps within the current window, across all origins. */
  private globalAttempts: number[] = []
  /** Per-verified-origin attempt timestamps within the current window. */
  private readonly originAttempts = new Map<string, number[]>()

  constructor(opts: ReconnectRateLimitOptions = {}) {
    this.perOriginPerMinute =
      opts.perOriginPerMinute ?? DEFAULT_PER_ORIGIN_PER_MINUTE
    this.globalPerMinute = opts.globalPerMinute ?? DEFAULT_GLOBAL_PER_MINUTE
    this.now = opts.now ?? Date.now
  }

  /**
   * Admits one `/v1` attempt from `verifiedOrigin`, or refuses it.
   *
   * A refusal records nothing, so a peer being throttled cannot deepen its own
   * throttle — and, with the stale-bucket prune below, that is also what bounds
   * memory here. At most `globalPerMinute` timestamps can exist in the window,
   * so at most that many origin buckets can be non-empty. This matters more
   * than it looks: unlike a browser page, a local process can put any `Origin`
   * it likes on a `/v1` upgrade, so a per-origin map that grew on every
   * *attempt* would be an unbounded allocation driven by a rotating attacker.
   */
  admit(verifiedOrigin: string): boolean {
    const t = this.now()
    const cutoff = t - RATE_WINDOW_MS

    this.globalAttempts = this.globalAttempts.filter((ts) => ts > cutoff)
    if (this.globalAttempts.length >= this.globalPerMinute) {
      return false
    }

    const recent = (this.originAttempts.get(verifiedOrigin) ?? []).filter(
      (ts) => ts > cutoff
    )
    if (recent.length >= this.perOriginPerMinute) {
      this.originAttempts.set(verifiedOrigin, recent)
      return false
    }

    this.globalAttempts.push(t)
    recent.push(t)
    this.originAttempts.set(verifiedOrigin, recent)
    this.pruneStaleOrigins(cutoff)
    return true
  }

  /** Number of origins currently holding at least one in-window attempt.
   *  Exposed so a test can pin the memory bound described on `admit`. */
  trackedOrigins(): number {
    return this.originAttempts.size
  }

  /** Drops buckets whose every timestamp has aged out. Without this an origin
   *  seen once would occupy an entry forever. */
  private pruneStaleOrigins(cutoff: number): void {
    for (const [origin, times] of this.originAttempts) {
      if (times.length === 0 || times[times.length - 1] <= cutoff) {
        this.originAttempts.delete(origin)
      }
    }
  }
}
