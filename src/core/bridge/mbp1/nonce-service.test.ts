import { describe, expect, it } from 'vitest'
import { NonceService } from './nonce-service'

describe('NonceService (§4.2)', () => {
  it('issues a nonce and lets it be consumed exactly once', () => {
    const svc = new NonceService()
    const issued = svc.issue(null)
    expect('nonce' in issued).toBe(true)
    if (!('nonce' in issued)) throw new Error('expected a nonce')
    expect(svc.consume(issued.nonce)).toBe(true)
    expect(svc.consume(issued.nonce)).toBe(false)
  })

  it('reports a 60s ttl by default', () => {
    const svc = new NonceService()
    const issued = svc.issue(null)
    if (!('nonce' in issued)) throw new Error('expected a nonce')
    expect(issued.ttlSeconds).toBe(60)
  })

  it('rejects the 33rd outstanding nonce under the default cap of 32', () => {
    const svc = new NonceService()
    for (let i = 0; i < 32; i++) {
      const issued = svc.issue(null)
      expect('nonce' in issued).toBe(true)
    }
    const rejected = svc.issue(null)
    expect(rejected).toEqual({ error: 'limited' })
  })

  it('frees outstanding cap slots once entries expire', () => {
    let t = 0
    const svc = new NonceService({
      maxOutstanding: 2,
      ttlMs: 1_000,
      now: () => t,
    })
    expect('nonce' in svc.issue(null)).toBe(true)
    expect('nonce' in svc.issue(null)).toBe(true)
    // cap is exhausted: a 3rd nonce is rejected even though none expired yet
    expect(svc.issue(null)).toEqual({ error: 'limited' })

    t += 1_001 // past the 1s ttl
    const revived = svc.issue(null)
    expect('nonce' in revived).toBe(true)
  })

  it('applies a global issuance rate limit of 60/min by default', () => {
    let t = 0
    const svc = new NonceService({ now: () => t })
    for (let i = 0; i < 60; i++) {
      const issued = svc.issue(null)
      expect('nonce' in issued).toBe(true)
      if ('nonce' in issued) expect(svc.consume(issued.nonce)).toBe(true)
      t += 100 // stay inside the 60s window; consuming avoids the cap of 32
    }
    const rejected = svc.issue(null)
    expect(rejected).toEqual({ error: 'limited' })
  })

  it('lets issuance resume once the rate-limit window rolls forward', () => {
    let t = 0
    const svc = new NonceService({ ratePerMinute: 2, now: () => t })
    expect('nonce' in svc.issue(null)).toBe(true)
    expect('nonce' in svc.issue(null)).toBe(true)
    expect(svc.issue(null)).toEqual({ error: 'limited' })

    t += 60_001 // past the 60s window
    expect('nonce' in svc.issue(null)).toBe(true)
  })

  it('applies a per-verified-origin quota of 10/min by default, counted only when origin is non-null', () => {
    let t = 0
    const svc = new NonceService({ now: () => t })
    for (let i = 0; i < 10; i++) {
      const issued = svc.issue('https://a.example')
      expect('nonce' in issued).toBe(true)
      if ('nonce' in issued) expect(svc.consume(issued.nonce)).toBe(true)
      t += 100
    }
    const rejected = svc.issue('https://a.example')
    expect(rejected).toEqual({ error: 'limited' })

    // A distinct origin has its own quota.
    const otherOrigin = svc.issue('https://b.example')
    expect('nonce' in otherOrigin).toBe(true)

    // Null origin (no verified origin) is never subject to the per-origin
    // quota, even past the per-origin count.
    for (let i = 0; i < 15; i++) {
      const issued = svc.issue(null)
      expect('nonce' in issued).toBe(true)
      if ('nonce' in issued) expect(svc.consume(issued.nonce)).toBe(true)
      t += 100
    }
  })
})
