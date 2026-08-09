// src/core/plugin/commands/rate-limiter.test.ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { RateLimiter } from './rate-limiter'

describe('RateLimiter', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-05-12T00:00:00Z'))
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('allows up to the limit within the window', () => {
    const limiter = new RateLimiter({ limit: 10, windowMs: 1000 })
    for (let i = 0; i < 10; i++) {
      expect(limiter.consume('a', 'b')).toBe(true)
    }
  })

  it('rejects the 11th call in the same window', () => {
    const limiter = new RateLimiter({ limit: 10, windowMs: 1000 })
    for (let i = 0; i < 10; i++) {
      expect(limiter.consume('a', 'b')).toBe(true)
    }
    expect(limiter.consume('a', 'b')).toBe(false)
  })

  it('refills budget after the window elapses', () => {
    const limiter = new RateLimiter({ limit: 10, windowMs: 1000 })
    for (let i = 0; i < 10; i++) {
      expect(limiter.consume('a', 'b')).toBe(true)
    }
    expect(limiter.consume('a', 'b')).toBe(false)

    vi.advanceTimersByTime(1100)
    expect(limiter.consume('a', 'b')).toBe(true)
  })

  it('isolates budgets across different callees for the same caller', () => {
    const limiter = new RateLimiter({ limit: 10, windowMs: 1000 })
    for (let i = 0; i < 10; i++) {
      expect(limiter.consume('a', 'b')).toBe(true)
    }
    expect(limiter.consume('a', 'b')).toBe(false)

    // Different callee — fresh budget.
    for (let i = 0; i < 10; i++) {
      expect(limiter.consume('a', 'c')).toBe(true)
    }
    expect(limiter.consume('a', 'c')).toBe(false)
  })

  it('accumulates same-caller different-callee budgets independently', () => {
    const limiter = new RateLimiter({ limit: 10, windowMs: 1000 })

    // Interleave a->b and a->c so we exercise both keys without saturating
    // either, then push each to its individual limit.
    for (let i = 0; i < 5; i++) {
      expect(limiter.consume('a', 'b')).toBe(true)
      expect(limiter.consume('a', 'c')).toBe(true)
    }
    for (let i = 0; i < 5; i++) {
      expect(limiter.consume('a', 'b')).toBe(true)
      expect(limiter.consume('a', 'c')).toBe(true)
    }
    expect(limiter.consume('a', 'b')).toBe(false)
    expect(limiter.consume('a', 'c')).toBe(false)
  })

  it('isolates budgets across different callers for the same callee', () => {
    const limiter = new RateLimiter({ limit: 10, windowMs: 1000 })
    for (let i = 0; i < 10; i++) {
      expect(limiter.consume('a', 'b')).toBe(true)
    }
    expect(limiter.consume('a', 'b')).toBe(false)

    // Different caller targeting the same callee — fresh budget.
    for (let i = 0; i < 10; i++) {
      expect(limiter.consume('x', 'b')).toBe(true)
    }
    expect(limiter.consume('x', 'b')).toBe(false)
  })

  it('partially advancing time does not refill the window', () => {
    const limiter = new RateLimiter({ limit: 10, windowMs: 1000 })
    for (let i = 0; i < 10; i++) {
      expect(limiter.consume('a', 'b')).toBe(true)
    }

    // Half the window — still saturated, no entries have aged out.
    vi.advanceTimersByTime(500)
    expect(limiter.consume('a', 'b')).toBe(false)

    // Cross the original t=0 entries' expiry (500 + 501 = 1001ms total).
    vi.advanceTimersByTime(501)
    for (let i = 0; i < 10; i++) {
      expect(limiter.consume('a', 'b')).toBe(true)
    }
    expect(limiter.consume('a', 'b')).toBe(false)
  })

  it('prunes stale timestamps when a new call lands after the window', () => {
    const limiter = new RateLimiter({ limit: 10, windowMs: 1000 })
    for (let i = 0; i < 10; i++) {
      expect(limiter.consume('a', 'b')).toBe(true)
    }
    expect(limiter.consume('a', 'b')).toBe(false)

    // Walk past windowMs so the original 10 timestamps are all stale.
    vi.advanceTimersByTime(1100)

    // The next consume should succeed AND the internal state must be
    // pruned. We verify pruning behaviorally: a single consume cannot
    // leave 11 entries in the window — if it did, the next 9 consumes
    // would saturate at entry #10 rather than at #11.
    expect(limiter.consume('a', 'b')).toBe(true)
    for (let i = 0; i < 9; i++) {
      expect(limiter.consume('a', 'b')).toBe(true)
    }
    // Now we should be exactly at the limit (10 fresh entries), so the
    // next call must be rejected.
    expect(limiter.consume('a', 'b')).toBe(false)
  })
})
