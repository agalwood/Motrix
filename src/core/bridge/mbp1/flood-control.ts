// MBP1 pairing flood control (docs/bridge-pairing-protocol.md §7.3).
//
// This defends against a local process that can rotate a fake `Origin` on
// every connection attempt (unlike a cross-origin web page, which the
// `/nonce` header requirement already excludes entirely) from spamming the
// user with approval dialogs. That is why the pending cap and the failure
// lockout are both GLOBAL, not per-origin: per-origin bookkeeping would let
// such a process simply mint a new origin per attempt and never be
// throttled. The pending-pair dedup below IS per-origin, but only as a
// convenience against a single origin double-submitting — it does nothing
// against a rotating-origin flood, which the global cap and lockout cover.
//
// §7.3 is explicit that the failure counter must increment on a session that
// queued a dialog or consumed an attempt and then ended without
// confirmation — including one that simply disconnects early — so a guesser
// cannot dodge the counter by closing the socket before exhausting a code.
//
// This module logs nothing at any level (§11): origins and outcome
// booleans are the only inputs, and both are security-sensitive here.

const DEFAULT_PENDING_CAP = 3
const BASE_LOCKOUT_SECONDS = 30
const MAX_LOCKOUT_SECONDS = 3600
const RESET_AFTER_MS = 24 * 60 * 60 * 1000

export interface PairFloodControlOptions {
  /** Global cap on concurrently pending `/pair` dialogs. Default 3 (§7.3). */
  pendingCap?: number
  /** Injectable clock (tests). Default `Date.now`. */
  now?: () => number
}

export type AdmitResult =
  | { ok: true }
  | { ok: false; code: 'busy' | 'rateLimited' }

export interface PairOutcome {
  /** An approval dialog was shown to the user for this session. */
  queuedDialog: boolean
  /** The session reached `pakeA` and consumed at least one pairing attempt. */
  consumedAttempt: boolean
  /** The session ended in mutual confirmation. */
  confirmed: boolean
}

export class PairFloodControl {
  private readonly pendingCap: number
  private readonly now: () => number

  /** Verified origins with a currently-admitted, not-yet-released dialog. */
  private readonly pendingOrigins = new Set<string>()

  /** Consecutive failures since the last confirmed pairing or 24h reset. */
  private failureCount = 0
  /** Timestamp of the most recent qualifying failure, or `null` if none. */
  private lastFailureAt: number | null = null

  constructor(opts: PairFloodControlOptions = {}) {
    this.pendingCap = opts.pendingCap ?? DEFAULT_PENDING_CAP
    this.now = opts.now ?? Date.now
  }

  /**
   * Admits a new `/pair` session for `verifiedOrigin`, or refuses it
   * **before any session mutation** (§7.3):
   *
   *   - `rateLimited` while the global failure lockout is active, regardless
   *     of pending-slot availability — a fresh origin gets no free pass
   *     during a lockout.
   *   - `busy` if this origin already has a pending dialog (dedup), or if
   *     the global pending cap is already full.
   */
  admit(verifiedOrigin: string): AdmitResult {
    if (this.lockoutRemainingMs() > 0) {
      return { ok: false, code: 'rateLimited' }
    }
    if (this.pendingOrigins.has(verifiedOrigin)) {
      return { ok: false, code: 'busy' }
    }
    if (this.pendingOrigins.size >= this.pendingCap) {
      return { ok: false, code: 'busy' }
    }
    this.pendingOrigins.add(verifiedOrigin)
    return { ok: true }
  }

  /** Frees the pending slot for `verifiedOrigin`, e.g. once its dialog
   *  resolves or its session ends. */
  release(verifiedOrigin: string): void {
    this.pendingOrigins.delete(verifiedOrigin)
  }

  /**
   * Records how a pairing session ended. A qualifying failure — one that
   * queued a dialog OR consumed at least one attempt, and did not end in
   * confirmation — increments the global counter regardless of *why* it
   * failed (bad code, abort, dismissal, or an early disconnect: §7.3 names
   * the disconnect case explicitly so it cannot be used to dodge the
   * counter). `confirmed: true` always resets the counter, even if it also
   * reports a queued dialog or consumed attempt.
   */
  recordOutcome(outcome: PairOutcome): void {
    const t = this.now()
    this.resetIfStale(t)

    if (outcome.confirmed) {
      this.failureCount = 0
      this.lastFailureAt = null
      return
    }

    if (outcome.queuedDialog || outcome.consumedAttempt) {
      this.failureCount += 1
      this.lastFailureAt = t
    }
  }

  /** Milliseconds remaining in the current global lockout, or 0 if none is
   *  active. Before dialog `n` (the `n`th consecutive failure), the lockout
   *  is `min(30 * 2^(n-1), 3600)` seconds from that failure (§7.3). */
  lockoutRemainingMs(): number {
    const t = this.now()
    this.resetIfStale(t)
    if (this.failureCount === 0 || this.lastFailureAt === null) {
      return 0
    }
    const lockoutSeconds = Math.min(
      BASE_LOCKOUT_SECONDS * 2 ** (this.failureCount - 1),
      MAX_LOCKOUT_SECONDS
    )
    const lockoutEndsAt = this.lastFailureAt + lockoutSeconds * 1000
    return Math.max(0, lockoutEndsAt - t)
  }

  /** Lazily resets the failure counter once 24h have passed since the last
   *  failure (§7.3), so a long-idle instance does not carry a stale
   *  escalated lockout into an unrelated future session. */
  private resetIfStale(t: number): void {
    if (
      this.lastFailureAt !== null &&
      t - this.lastFailureAt >= RESET_AFTER_MS
    ) {
      this.failureCount = 0
      this.lastFailureAt = null
    }
  }
}
