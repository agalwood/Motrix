// MBP1 pairing nonce issuance (docs/bridge-pairing-protocol.md §4.2).
//
// `POST /nonce` is unauthenticated by design (a fresh caller has no
// credential yet), so it is the surface a blind flooder — one that cannot
// read responses, since the custom `X-Motrix-Bridge` header keeps a
// cross-origin web page from ever reaching it at all — can still hit
// directly. The three caps here (outstanding, global rate, per-origin rate)
// bound that flood without depending on the header holding in every runtime.
//
// Nonces themselves are secret-adjacent bearer material for `/pair`, so this
// module logs nothing at any level (§11).

import { randomBytes } from 'node:crypto'
import { toBase64Url } from './canonical'

const DEFAULT_TTL_MS = 60_000
const DEFAULT_MAX_OUTSTANDING = 32
const DEFAULT_RATE_PER_MINUTE = 60
const DEFAULT_PER_ORIGIN_PER_MINUTE = 10
const RATE_WINDOW_MS = 60_000
export const MBP1_PAIR_NONCE_BYTES = 16
const CANONICAL_MBP1_PAIR_NONCE = /^[A-Za-z0-9_-]{21}[AQgw]$/u

/** Canonical unpadded base64url encoding of the 16-byte §4.2 nonce. */
export function isCanonicalMbp1PairNonce(value: unknown): value is string {
  return typeof value === 'string' && CANONICAL_MBP1_PAIR_NONCE.test(value)
}

export interface NonceServiceOptions {
  /** Nonce lifetime. Default 60s (§4.2). */
  ttlMs?: number
  /** Max unconsumed nonces at once. Default 32 (§4.2). */
  maxOutstanding?: number
  /** Global `issue()` calls per rolling minute. Default 60 (§4.2). */
  ratePerMinute?: number
  /** Per-verified-origin `issue()` calls per rolling minute. Default 10
   *  (§4.2). Only enforced when `issue()` is called with a non-null origin. */
  perOriginPerMinute?: number
  /** Injectable clock (tests). Default `Date.now`. */
  now?: () => number
}

export type IssueResult =
  | { nonce: string; ttlSeconds: number }
  | { error: 'limited' }

export class NonceService {
  private readonly ttlMs: number
  private readonly maxOutstanding: number
  private readonly ratePerMinute: number
  private readonly perOriginPerMinute: number
  private readonly now: () => number

  /** Outstanding nonce -> its expiry timestamp. */
  private readonly nonces = new Map<string, number>()
  /** Global issuance timestamps within the current rate window. */
  private issueTimes: number[] = []
  /** Per-verified-origin issuance timestamps within the current rate window. */
  private readonly originIssueTimes = new Map<string, number[]>()

  constructor(opts: NonceServiceOptions = {}) {
    this.ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS
    this.maxOutstanding = opts.maxOutstanding ?? DEFAULT_MAX_OUTSTANDING
    this.ratePerMinute = opts.ratePerMinute ?? DEFAULT_RATE_PER_MINUTE
    this.perOriginPerMinute =
      opts.perOriginPerMinute ?? DEFAULT_PER_ORIGIN_PER_MINUTE
    this.now = opts.now ?? Date.now
  }

  /**
   * Issues a one-shot pairing nonce, or `{ error: 'limited' }` if any cap is
   * hit. Nothing is mutated on a rejection (§4.2's caps gate before any state
   * change, mirroring the pending-pair "before any session mutation" rule in
   * §7.3). `verifiedOrigin` is the caller's Chromium-verified `Origin`, or
   * `null` when none exists (e.g. the native-messaging host); the per-origin
   * quota only applies when it is non-null.
   */
  issue(verifiedOrigin: string | null): IssueResult {
    const t = this.now()
    this.sweepExpiredNonces(t)

    if (this.nonces.size >= this.maxOutstanding) {
      return { error: 'limited' }
    }

    const cutoff = t - RATE_WINDOW_MS
    const recentGlobal = this.issueTimes.filter((ts) => ts > cutoff)
    if (recentGlobal.length >= this.ratePerMinute) {
      this.issueTimes = recentGlobal
      return { error: 'limited' }
    }

    let recentOrigin: number[] | undefined
    if (verifiedOrigin !== null) {
      recentOrigin = (this.originIssueTimes.get(verifiedOrigin) ?? []).filter(
        (ts) => ts > cutoff
      )
      if (recentOrigin.length >= this.perOriginPerMinute) {
        this.originIssueTimes.set(verifiedOrigin, recentOrigin)
        return { error: 'limited' }
      }
    }

    recentGlobal.push(t)
    this.issueTimes = recentGlobal
    if (verifiedOrigin !== null && recentOrigin) {
      recentOrigin.push(t)
      this.originIssueTimes.set(verifiedOrigin, recentOrigin)
    }

    const nonce = toBase64Url(randomBytes(MBP1_PAIR_NONCE_BYTES))
    if (!isCanonicalMbp1PairNonce(nonce)) {
      throw new Error('mbp1 nonce generation failed')
    }
    this.nonces.set(nonce, t + this.ttlMs)
    return { nonce, ttlSeconds: Math.floor(this.ttlMs / 1000) }
  }

  /** One-shot consume: `true` only for an outstanding, unexpired nonce.
   *  Removes the entry either way, so a replayed or expired nonce can never
   *  be consumed twice. */
  consume(nonce: string): boolean {
    const expiresAt = this.nonces.get(nonce)
    if (expiresAt === undefined) {
      return false
    }
    this.nonces.delete(nonce)
    return expiresAt > this.now()
  }

  /** Drops expired entries so the outstanding cap frees up over time instead
   *  of being permanently consumed by abandoned/never-consumed nonces. */
  private sweepExpiredNonces(t: number): void {
    for (const [nonce, expiresAt] of this.nonces) {
      if (expiresAt <= t) {
        this.nonces.delete(nonce)
      }
    }
  }
}
