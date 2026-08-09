import { describe, expect, it } from 'vitest'
import { TokenBucket } from './rate-limiter'

describe('TokenBucket', () => {
  it('allows requests up to capacity', () => {
    const b = new TokenBucket({ capacity: 3, refillPerSec: 1, now: () => 0 })
    expect(b.tryAcquire()).toBe(true)
    expect(b.tryAcquire()).toBe(true)
    expect(b.tryAcquire()).toBe(true)
    expect(b.tryAcquire()).toBe(false)
  })

  it('refills over time', () => {
    let time = 0
    const b = new TokenBucket({ capacity: 2, refillPerSec: 1, now: () => time })
    expect(b.tryAcquire()).toBe(true)
    expect(b.tryAcquire()).toBe(true)
    expect(b.tryAcquire()).toBe(false)
    time = 1500 // 1.5 seconds later
    expect(b.tryAcquire()).toBe(true) // one token refilled
    expect(b.tryAcquire()).toBe(false)
  })

  it('does not over-fill beyond capacity', () => {
    let time = 0
    const b = new TokenBucket({
      capacity: 2,
      refillPerSec: 10,
      now: () => time,
    })
    b.tryAcquire()
    b.tryAcquire()
    time = 10_000
    expect(b.tryAcquire()).toBe(true)
    expect(b.tryAcquire()).toBe(true)
    expect(b.tryAcquire()).toBe(false)
  })

  it('reports timeUntilNextToken', () => {
    let time = 0
    const b = new TokenBucket({ capacity: 1, refillPerSec: 1, now: () => time })
    expect(b.tryAcquire()).toBe(true)
    expect(b.timeUntilNextToken()).toBeCloseTo(1000, -1)
    time = 400
    expect(b.timeUntilNextToken()).toBeCloseTo(600, -1)
  })

  it('throws when count exceeds capacity', () => {
    const b = new TokenBucket({ capacity: 2, refillPerSec: 1, now: () => 0 })
    expect(() => b.tryAcquire(3)).toThrow(RangeError)
  })
})
