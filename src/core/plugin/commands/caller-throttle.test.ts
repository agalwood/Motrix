// src/core/plugin/commands/caller-throttle.test.ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CallerThrottle } from './caller-throttle'

const OPTS = { threshold: 10, windowMs: 60_000, blockMs: 5 * 60_000 }

describe('CallerThrottle', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-05-12T00:00:00Z'))
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('reports unknown callers as not blocked', () => {
    const throttle = new CallerThrottle(OPTS)
    expect(throttle.isBlocked('a')).toBe(false)
  })

  it('does not block while invalid count stays under the threshold', () => {
    const throttle = new CallerThrottle(OPTS)
    for (let i = 0; i < 9; i++) {
      throttle.recordInvalid('a')
    }
    expect(throttle.isBlocked('a')).toBe(false)
  })

  it('blocks once the threshold-th invalid lands', () => {
    const throttle = new CallerThrottle(OPTS)
    for (let i = 0; i < 9; i++) {
      throttle.recordInvalid('a')
    }
    expect(throttle.isBlocked('a')).toBe(false)
    throttle.recordInvalid('a')
    expect(throttle.isBlocked('a')).toBe(true)
  })

  it('does not extend the block when fewer than threshold records arrive while blocked', () => {
    const throttle = new CallerThrottle(OPTS)
    for (let i = 0; i < 10; i++) {
      throttle.recordInvalid('a')
    }
    expect(throttle.isBlocked('a')).toBe(true)

    // Record 9 more during the block — not enough to re-arm.
    vi.advanceTimersByTime(1)
    for (let i = 0; i < 9; i++) {
      throttle.recordInvalid('a')
    }

    // Sit just before the original block expiry: still blocked.
    vi.advanceTimersByTime(OPTS.blockMs - 2)
    expect(throttle.isBlocked('a')).toBe(true)

    // Cross the original expiry — block lifts on schedule, proving it
    // was not extended by the in-block records.
    vi.advanceTimersByTime(2)
    expect(throttle.isBlocked('a')).toBe(false)
  })

  it('lifts the block after blockMs elapses and cleans the entry', () => {
    const throttle = new CallerThrottle(OPTS)
    for (let i = 0; i < 10; i++) {
      throttle.recordInvalid('a')
    }
    expect(throttle.isBlocked('a')).toBe(true)

    vi.advanceTimersByTime(OPTS.blockMs)
    expect(throttle.isBlocked('a')).toBe(false)

    // After the cleanup, repeated isBlocked stays false without
    // resurrecting the entry.
    expect(throttle.isBlocked('a')).toBe(false)
  })

  it('filters out invalid entries older than windowMs', () => {
    const throttle = new CallerThrottle(OPTS)
    for (let i = 0; i < 5; i++) {
      throttle.recordInvalid('a')
    }

    // Walk past the rolling window so the first 5 entries age out.
    vi.advanceTimersByTime(OPTS.windowMs + 1_000)
    for (let i = 0; i < 5; i++) {
      throttle.recordInvalid('a')
    }

    // Only 5 entries are fresh — well below threshold, so no block.
    expect(throttle.isBlocked('a')).toBe(false)
  })

  it('reset() clears an active block immediately', () => {
    const throttle = new CallerThrottle(OPTS)
    for (let i = 0; i < 10; i++) {
      throttle.recordInvalid('a')
    }
    expect(throttle.isBlocked('a')).toBe(true)

    throttle.reset('a')
    expect(throttle.isBlocked('a')).toBe(false)
  })

  it('reset() clears accumulated invalid counts', () => {
    const throttle = new CallerThrottle(OPTS)
    for (let i = 0; i < 9; i++) {
      throttle.recordInvalid('a')
    }

    throttle.reset('a')

    // After reset, 9 fresh records must NOT trigger a block (the prior
    // counts have been wiped).
    for (let i = 0; i < 9; i++) {
      throttle.recordInvalid('a')
    }
    expect(throttle.isBlocked('a')).toBe(false)

    // The 10th still arms the block, confirming the threshold logic
    // continues to work after a reset.
    throttle.recordInvalid('a')
    expect(throttle.isBlocked('a')).toBe(true)
  })

  it('keeps callers independent — blocking one does not affect another', () => {
    const throttle = new CallerThrottle(OPTS)
    for (let i = 0; i < 10; i++) {
      throttle.recordInvalid('a')
    }
    expect(throttle.isBlocked('a')).toBe(true)
    expect(throttle.isBlocked('b')).toBe(false)

    // 'b' can still accumulate independently right up to its own
    // threshold without 'a''s state interfering.
    for (let i = 0; i < 9; i++) {
      throttle.recordInvalid('b')
    }
    expect(throttle.isBlocked('b')).toBe(false)

    throttle.recordInvalid('b')
    expect(throttle.isBlocked('b')).toBe(true)
  })
})
