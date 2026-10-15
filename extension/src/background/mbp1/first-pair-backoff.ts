import { extensionBrowser as browser } from '@/shared/browser'
/**
 * MBP1 client-side global first-pair backoff (bridge-pairing-protocol.md §7.3).
 *
 * The client analogue of the server's `PairFloodControl` lockout, and the
 * client's half of the defense against online code guessing: the 40-bit code
 * space only holds up because a guesser is limited to ~3 attempts per session
 * *and* the sessions themselves are rate-limited.
 *
 * ```
 * lockout before failure n = min(30 · 2^(n-1), 3600) seconds, from that failure
 * ```
 *
 * ## One counter, keyed by nothing
 *
 * §7.3 requires "a **single truly global** first-pair failure counter — one
 * counter for all unauthenticated first-pair targets, deliberately **not**
 * keyed by `instanceId`, `port`, or any other attacker-controllable value".
 * There is therefore no key parameter anywhere in this API, by construction
 * rather than by convention.
 *
 * Review round 3 found the bug this exists to prevent: a counter keyed by
 * `instanceId` handed a fake listener a fresh counter every session, since the
 * listener simply returns a new `instanceId` each time. `instanceId` is a
 * routing hint and never a security signal (§4.1), so keying on it is keying on
 * the attacker's own input.
 *
 * The known cost — any local process can drive *everyone's* first-pair backoff
 * up by failing pairings — is an **accepted** residual in §1.1. Do not "fix" it
 * by narrowing the key; that reintroduces the round-3 bypass.
 *
 * ## Two reset arms, both required
 *
 * §7.3: the counter "resets on a successful pairing **or after 24 h**". The
 * second arm is not cosmetic. Without it the exponent never decays, so a user
 * who mistypes a code a handful of times spread over months accumulates an
 * unbounded exponent and eventually sits permanently at the 3600 s ceiling —
 * while the server, which does implement the 24 h reset, would impose only
 * 30 s. The client would lock itself out for an hour where the server invites
 * an immediate retry. Line A's `flood-control.ts` uses the same 24 h window, so
 * the two sides agree about when backoff has cleared.
 *
 * This module logs nothing at any level (§11): the only inputs are a failure
 * count and a timestamp, and both are security-sensitive here.
 */

import { createOperationQueue } from '@/background/mbp1/operation-queue'
import { DEV_PAIR_BACKOFF_MS } from '@/shared/buildFlags'

const STORAGE_KEY = 'motrix.mbp1.firstPairBackoff'

/** §7.3 / Line A `flood-control.ts`: the first lockout, in milliseconds. */
export const BASE_LOCKOUT_MS = 30_000

/**
 * The base actually used: the spec constant, unless a local-debug build
 * shrank the window via `MOTRIX_DEV_PAIR_BACKOFF_MS` (dev builds only —
 * `buildFlags.ts` documents the double fence keeping it out of Web Store
 * artifacts). Only the base changes; the doubling and the 1 h ceiling stay.
 */
const EFFECTIVE_BASE_LOCKOUT_MS = DEV_PAIR_BACKOFF_MS ?? BASE_LOCKOUT_MS

/** §7.3 / Line A `flood-control.ts`: the lockout ceiling (1 hour). */
export const MAX_LOCKOUT_MS = 3_600_000

/** §7.3: the counter resets after this much inactivity. */
export const COUNTER_RESET_MS = 24 * 60 * 60 * 1000

interface StoredBackoff {
  version: 1
  consecutiveFailures: number
  lastFailureAt: number
}

/** The result of the pre-`/pair` gate. `retryAtMs` is set only when refused. */
export interface BackoffGate {
  allowed: boolean
  retryAtMs?: number
}

/**
 * Validates the persisted record. Anything uninterpretable — including a
 * future `version` — degrades to "no backoff" rather than to a lockout: a
 * corrupted record must not be able to permanently deny the user a pairing,
 * and the cost of the lenient direction is bounded at one extra session before
 * the counter rebuilds from 1.
 */
function readStored(value: unknown): StoredBackoff | null {
  if (!value || typeof value !== 'object') return null
  const raw = value as Partial<StoredBackoff>
  if (raw.version !== 1) return null
  const failures = raw.consecutiveFailures
  const last = raw.lastFailureAt
  if (
    typeof failures !== 'number' ||
    !Number.isInteger(failures) ||
    failures < 0 ||
    typeof last !== 'number' ||
    !Number.isFinite(last)
  ) {
    return null
  }
  return { version: 1, consecutiveFailures: failures, lastFailureAt: last }
}

/**
 * `min(30 · 2^(n-1), 3600)` seconds in milliseconds, for the `n`th consecutive
 * failure.
 *
 * The ceiling is applied to the *result*, never to the exponent: `2 ** 60`
 * evaluates fine in JS and would silently produce an effectively permanent
 * lockout.
 */
function lockoutMsFor(consecutiveFailures: number): number {
  return Math.min(
    EFFECTIVE_BASE_LOCKOUT_MS * 2 ** (consecutiveFailures - 1),
    MAX_LOCKOUT_MS
  )
}

/**
 * The failure count that is still in force at `now`, applying §7.3's 24 h
 * reset. Shared by the gate and by `recordFailure`, so the stored exponent
 * decays too — a gate-only reset would still let the next failure resume at
 * `n + 1` and grow without bound.
 *
 * A `lastFailureAt` in the *future* is treated as stale as well. A stored
 * timestamp ahead of `now` cannot be read as an elapsed duration, and the
 * alternative — locking the user out for the whole clock delta, which can be
 * months — is a self-inflicted denial of service. It grants an attacker
 * nothing new: anyone who can move the system clock backwards can equally move
 * it forwards past the legitimate 24 h reset, and a local process with that
 * power is already out of scope (§1.1).
 */
function effectiveFailures(stored: StoredBackoff | null, now: number): number {
  if (stored === null || stored.consecutiveFailures === 0) return 0
  const elapsed = now - stored.lastFailureAt
  if (elapsed >= COUNTER_RESET_MS || elapsed < 0) return 0
  return stored.consecutiveFailures
}

async function read(): Promise<StoredBackoff | null> {
  const obj = await browser.storage.local.get(STORAGE_KEY)
  return readStored((obj as Record<string, unknown>)[STORAGE_KEY])
}

async function write(stored: StoredBackoff): Promise<void> {
  await browser.storage.local.set({ [STORAGE_KEY]: stored })
}

/**
 * Module scope, not per instance: the racing callers here are independent call
 * sites rather than holders of a shared object, so only a realm-wide queue
 * closes the race. See `operation-queue.ts`.
 */
const enqueue = createOperationQueue()

export class FirstPairBackoff {
  /**
   * The §7.3 gate, to be consulted **before** opening `/pair` — refusing the
   * connection is the point, so calling it after the socket is open would
   * already have queued a dialog on the user's screen.
   *
   * Deliberately read-only: a gate that wrote would have to decide what to
   * write for a first-ever check, and any record it created would make the
   * first real failure look like the second. The 24 h decay is applied to the
   * *stored* exponent by `recordFailure` instead.
   */
  async check(now: number): Promise<BackoffGate> {
    return enqueue(async () => {
      const stored = await read()
      const failures = effectiveFailures(stored, now)
      if (failures === 0 || stored === null) return { allowed: true }
      const retryAtMs = stored.lastFailureAt + lockoutMsFor(failures)
      if (now >= retryAtMs) return { allowed: true }
      return { allowed: false, retryAtMs }
    })
  }

  /**
   * Records one qualifying §7.3 failure: a first-pair session that reached
   * `pakeA` and ended without mutual confirmation, **for any reason**.
   *
   * That includes a session the extension itself abandoned by closing the
   * socket. §7.3 names the disconnect case explicitly so a guesser cannot dodge
   * the counter by hanging up before exhausting a code, and the caller
   * (`PairingFlow`) is what enforces it — this method cannot tell why it was
   * called.
   */
  async recordFailure(now: number): Promise<void> {
    return enqueue(async () => {
      const failures = effectiveFailures(await read(), now)
      await write({
        version: 1,
        consecutiveFailures: failures + 1,
        lastFailureAt: now,
      })
    })
  }

  /**
   * §7.3's first reset arm: a successful pairing clears the counter outright.
   *
   * Takes no timestamp because there is nothing left to time — the record is
   * removed rather than zeroed, so an absent record and a zero count are the
   * same state and `readStored` never has to distinguish them.
   */
  async recordSuccess(): Promise<void> {
    return enqueue(async () => {
      await browser.storage.local.remove(STORAGE_KEY)
    })
  }
}
