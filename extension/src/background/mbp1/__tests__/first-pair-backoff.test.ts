import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  BASE_LOCKOUT_MS,
  COUNTER_RESET_MS,
  FirstPairBackoff,
  MAX_LOCKOUT_MS,
} from '@/background/mbp1/first-pair-backoff'

declare const browser: {
  storage: {
    local: {
      get: (k: string | string[]) => Promise<Record<string, unknown>>
      set: (items: Record<string, unknown>) => Promise<void>
      remove: (k: string | string[]) => Promise<void>
    }
  }
}

const STORAGE_KEY = 'motrix.mbp1.firstPairBackoff'

let backing: Record<string, unknown> = {}

beforeEach(() => {
  backing = {}
  browser.storage.local.get = vi.fn(async (k: string | string[]) => {
    const snapshot: Record<string, unknown> = {}
    for (const key of typeof k === 'string' ? [k] : k) {
      if (key in backing) snapshot[key] = backing[key]
    }
    return snapshot
  })
  browser.storage.local.set = vi.fn(async (items: Record<string, unknown>) => {
    backing = { ...backing, ...items }
  })
  browser.storage.local.remove = vi.fn(async (k: string | string[]) => {
    for (const key of Array.isArray(k) ? k : [k]) delete backing[key]
  })
})

function persisted(): Record<string, unknown> {
  return backing[STORAGE_KEY] as Record<string, unknown>
}

describe('FirstPairBackoff (§7.3 client-side global backoff)', () => {
  it('locks out with min(30·2^(n-1), 3600)s and is not keyed by instance', async () => {
    const b = new FirstPairBackoff()
    const t0 = 1_000_000
    await b.recordFailure(t0) // n=1
    const r1 = await b.check(t0 + 1000)
    expect(r1.allowed).toBe(false)
    expect(r1.retryAtMs).toBe(t0 + 30_000)
    await b.recordFailure(t0 + 31_000) // n=2 -> 60s
    expect((await b.check(t0 + 32_000)).retryAtMs).toBe(t0 + 31_000 + 60_000)
    await b.recordSuccess()
    expect((await b.check(t0 + 200_000)).allowed).toBe(true) // reset
  })

  it('allows the very first attempt with no stored record', async () => {
    const b = new FirstPairBackoff()
    expect(await b.check(1_000_000)).toEqual({ allowed: true })
    // A read-only gate: checking must not create a record, or the first
    // failure would already be counted as the second.
    expect(persisted()).toBeUndefined()
  })

  it('allows again exactly at retryAtMs, not one tick before', async () => {
    const b = new FirstPairBackoff()
    const t0 = 5_000_000
    await b.recordFailure(t0)
    expect((await b.check(t0 + BASE_LOCKOUT_MS - 1)).allowed).toBe(false)
    expect((await b.check(t0 + BASE_LOCKOUT_MS)).allowed).toBe(true)
  })

  it('doubles per consecutive failure and saturates at the 3600 s ceiling', async () => {
    const b = new FirstPairBackoff()
    const t0 = 0
    const seen: number[] = []
    // Eight consecutive failures: 30, 60, 120, 240, 480, 960, 1920, 3600
    // (the eighth would be 3840 without the cap).
    for (let n = 1; n <= 8; n++) {
      await b.recordFailure(t0)
      const gate = await b.check(t0)
      seen.push((gate.retryAtMs ?? 0) - t0)
    }
    expect(seen).toEqual([
      30_000,
      60_000,
      120_000,
      240_000,
      480_000,
      960_000,
      1_920_000,
      MAX_LOCKOUT_MS,
    ])
    expect(MAX_LOCKOUT_MS).toBe(3_600_000)
  })

  it('holds the ceiling instead of growing past it on further failures', async () => {
    const b = new FirstPairBackoff()
    for (let n = 1; n <= 20; n++) await b.recordFailure(0)
    // 2^19 · 30 s would overflow into an effectively permanent lockout if the
    // ceiling were applied to the exponent rather than to the result.
    expect((await b.check(0)).retryAtMs).toBe(MAX_LOCKOUT_MS)
  })

  // §7.3 says the counter "resets on a successful pairing OR after 24 h".
  // Without the second arm the exponent never decays, so a user who mistypes
  // a code a few times spread over months eventually sits permanently at the
  // 3600 s ceiling while the server — which does implement the 24 h reset —
  // would impose only 30 s.
  describe('24 h staleness reset', () => {
    // Deliberately NOT asserted through `check`: because the lockout ceiling
    // (1 h) is far below the reset window (24 h), any record stale enough to
    // reset has already outlived its lockout, so the gate would answer
    // `allowed` either way. Mutating the 24 h arm out of `effectiveFailures`
    // leaves every gate-only assertion green — the reset is observable only in
    // the *stored* exponent, which is what these two tests pin.
    it('does not decay the exponent one millisecond early', async () => {
      const b = new FirstPairBackoff()
      const t0 = 1_700_000_000_000
      await b.recordFailure(t0)
      await b.recordFailure(t0 + COUNTER_RESET_MS - 1)
      expect(persisted().consecutiveFailures).toBe(2)
    })

    it('restarts the exponent at n=1 after a 24 h gap', async () => {
      const b = new FirstPairBackoff()
      const t0 = 1_700_000_000_000
      for (let n = 1; n <= 6; n++) await b.recordFailure(t0)
      expect((await b.check(t0)).retryAtMs).toBe(t0 + 960_000)

      // The gate alone allowing the attempt is not enough: the *stored*
      // exponent has to decay too, or the next failure resumes at n=7 and
      // the escalation is unbounded across a user's whole install lifetime.
      const later = t0 + COUNTER_RESET_MS + 5000
      await b.recordFailure(later)
      const gate = await b.check(later)
      expect(gate.retryAtMs).toBe(later + BASE_LOCKOUT_MS)
      expect(persisted().consecutiveFailures).toBe(1)
    })

    it('resets on a clock that moved backwards past the last failure', async () => {
      const b = new FirstPairBackoff()
      const t0 = 1_700_000_000_000
      await b.recordFailure(t0)
      // A stored timestamp in the future cannot be interpreted as an elapsed
      // duration; without this arm the user is locked out for the whole clock
      // delta, which can be months.
      expect((await b.check(t0 - COUNTER_RESET_MS)).allowed).toBe(true)
    })
  })

  describe('a single truly global counter (§7.3)', () => {
    // Review round 3 found a counter keyed by `instanceId`: a fake listener
    // returning a fresh `instanceId` every session got a fresh counter and
    // the lockout never bit. There is no key parameter on this API at all,
    // so the property is proven by two *independent* instances sharing one
    // count — which is exactly what a fake listener rotating its identity
    // would try to avoid.
    it('shares one count across separate FirstPairBackoff instances', async () => {
      const t0 = 9_000_000
      await new FirstPairBackoff().recordFailure(t0)
      await new FirstPairBackoff().recordFailure(t0 + 31_000)
      const gate = await new FirstPairBackoff().check(t0 + 32_000)
      expect(gate.allowed).toBe(false)
      expect(gate.retryAtMs).toBe(t0 + 31_000 + 60_000)
    })

    it('persists one record under one unkeyed storage key', async () => {
      const b = new FirstPairBackoff()
      await b.recordFailure(1234)
      expect(Object.keys(backing)).toEqual([STORAGE_KEY])
      expect(persisted()).toEqual({
        version: 1,
        consecutiveFailures: 1,
        lastFailureAt: 1234,
      })
    })

    it('removes the record entirely on success', async () => {
      const b = new FirstPairBackoff()
      await b.recordFailure(1234)
      await b.recordSuccess()
      expect(backing[STORAGE_KEY]).toBeUndefined()
      expect((await b.check(1235)).allowed).toBe(true)
    })
  })

  describe('persisted record hygiene', () => {
    it('treats an unreadable record as no backoff rather than a hard lockout', async () => {
      for (const value of [
        null,
        42,
        'nope',
        {},
        { version: 2, consecutiveFailures: 5, lastFailureAt: 0 },
        { version: 1, consecutiveFailures: -1, lastFailureAt: 0 },
        { version: 1, consecutiveFailures: 1.5, lastFailureAt: 0 },
        { version: 1, consecutiveFailures: 3 },
        { version: 1, consecutiveFailures: 3, lastFailureAt: Number.NaN },
        { version: 1, lastFailureAt: 0 },
      ]) {
        backing = { [STORAGE_KEY]: value }
        expect((await new FirstPairBackoff().check(1_000_000)).allowed).toBe(
          true
        )
      }
    })

    it('starts a fresh count from an unreadable record on the next failure', async () => {
      backing = { [STORAGE_KEY]: { version: 1, consecutiveFailures: 'many' } }
      const b = new FirstPairBackoff()
      await b.recordFailure(777)
      expect(persisted()).toEqual({
        version: 1,
        consecutiveFailures: 1,
        lastFailureAt: 777,
      })
    })
  })

  it('serializes concurrent failures so none is lost', async () => {
    const b = new FirstPairBackoff()
    // Three overlapping read-modify-write cycles against one storage key. An
    // unserialized store would have all three read `consecutiveFailures: 0`
    // and the last write would leave 1, letting a guesser run three sessions
    // for the price of one.
    await Promise.all([
      b.recordFailure(1000),
      b.recordFailure(1000),
      b.recordFailure(1000),
    ])
    expect(persisted().consecutiveFailures).toBe(3)
  })
})
