import { describe, expect, it } from 'vitest'
import { PairFloodControl } from './flood-control'

describe('PairFloodControl (§7.3)', () => {
  it('dedups a same-origin admit while one is already pending', () => {
    const fc = new PairFloodControl()
    expect(fc.admit('https://a.example')).toEqual({ ok: true })
    expect(fc.admit('https://a.example')).toEqual({
      ok: false,
      code: 'busy',
    })
  })

  it('rejects a 4th distinct-origin pending under the default global cap of 3', () => {
    const fc = new PairFloodControl()
    expect(fc.admit('https://a.example')).toEqual({ ok: true })
    expect(fc.admit('https://b.example')).toEqual({ ok: true })
    expect(fc.admit('https://c.example')).toEqual({ ok: true })
    expect(fc.admit('https://d.example')).toEqual({
      ok: false,
      code: 'busy',
    })
  })

  it('frees a pending slot on release, letting a new origin admit', () => {
    const fc = new PairFloodControl()
    fc.admit('https://a.example')
    fc.admit('https://b.example')
    fc.admit('https://c.example')
    expect(fc.admit('https://d.example')).toEqual({
      ok: false,
      code: 'busy',
    })
    fc.release('https://a.example')
    expect(fc.admit('https://d.example')).toEqual({ ok: true })
  })

  it('locks out for 30s after the 1st consecutive failure (n=1)', () => {
    let t = 0
    const fc = new PairFloodControl({ now: () => t })
    fc.recordOutcome({
      queuedDialog: true,
      consumedAttempt: false,
      confirmed: false,
    })
    expect(fc.lockoutRemainingMs()).toBe(30_000)
    expect(fc.admit('https://a.example')).toEqual({
      ok: false,
      code: 'rateLimited',
    })

    t += 29_999
    expect(fc.admit('https://a.example')).toEqual({
      ok: false,
      code: 'rateLimited',
    })

    t += 2 // now 30_001ms since the failure
    expect(fc.lockoutRemainingMs()).toBe(0)
    expect(fc.admit('https://a.example')).toEqual({ ok: true })
  })

  it('locks out for 60s after the 2nd consecutive failure (n=2)', () => {
    let t = 0
    const fc = new PairFloodControl({ now: () => t })
    fc.recordOutcome({
      queuedDialog: true,
      consumedAttempt: false,
      confirmed: false,
    })
    t += 30_001 // clear the n=1 lockout
    fc.recordOutcome({
      queuedDialog: true,
      consumedAttempt: false,
      confirmed: false,
    })
    expect(fc.lockoutRemainingMs()).toBe(60_000)

    t += 60_001
    expect(fc.lockoutRemainingMs()).toBe(0)
  })

  it('caps the lockout at 3600s once consecutive failures reach n=8', () => {
    let t = 0
    const fc = new PairFloodControl({ now: () => t })
    // n=1..7 escalate: 30, 60, 120, 240, 480, 960, 1920 -- clear each lockout
    // before recording the next failure so the count keeps climbing.
    const priorLockouts = [30, 60, 120, 240, 480, 960, 1920]
    for (const lockoutS of priorLockouts) {
      fc.recordOutcome({
        queuedDialog: true,
        consumedAttempt: false,
        confirmed: false,
      })
      t += lockoutS * 1_000 + 1
    }
    // 8th consecutive failure: min(30 * 2^7, 3600) = 3600
    fc.recordOutcome({
      queuedDialog: true,
      consumedAttempt: false,
      confirmed: false,
    })
    expect(fc.lockoutRemainingMs()).toBe(3_600_000)
  })

  it('resets the failure counter on a confirmed pairing', () => {
    let t = 0
    const fc = new PairFloodControl({ now: () => t })
    fc.recordOutcome({
      queuedDialog: true,
      consumedAttempt: false,
      confirmed: false,
    })
    t += 30_001
    fc.recordOutcome({
      queuedDialog: true,
      consumedAttempt: true,
      confirmed: true,
    })
    expect(fc.lockoutRemainingMs()).toBe(0)

    // The next failure is n=1 again (30s), not n=3 (120s).
    fc.recordOutcome({
      queuedDialog: true,
      consumedAttempt: false,
      confirmed: false,
    })
    expect(fc.lockoutRemainingMs()).toBe(30_000)
  })

  it('increments the counter when an attempt was consumed even without a dialog queued (§7.3 disconnect-early dodge)', () => {
    const t = 0
    const fc = new PairFloodControl({ now: () => t })
    fc.recordOutcome({
      queuedDialog: false,
      consumedAttempt: true,
      confirmed: false,
    })
    expect(fc.lockoutRemainingMs()).toBe(30_000)
  })

  it('does not increment the counter for an outcome with neither a queued dialog nor a consumed attempt', () => {
    const t = 0
    const fc = new PairFloodControl({ now: () => t })
    fc.recordOutcome({
      queuedDialog: false,
      consumedAttempt: false,
      confirmed: false,
    })
    expect(fc.lockoutRemainingMs()).toBe(0)
  })

  it('resets the failure counter after 24h of silence', () => {
    let t = 0
    const fc = new PairFloodControl({ now: () => t })
    fc.recordOutcome({
      queuedDialog: true,
      consumedAttempt: false,
      confirmed: false,
    })
    t += 24 * 60 * 60 * 1000 // exactly 24h later
    expect(fc.lockoutRemainingMs()).toBe(0)

    // The next failure is n=1 again (30s), not n=2 (60s).
    fc.recordOutcome({
      queuedDialog: true,
      consumedAttempt: false,
      confirmed: false,
    })
    expect(fc.lockoutRemainingMs()).toBe(30_000)
  })
})
