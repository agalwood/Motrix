import { describe, expect, it } from 'vitest'
import { ReconnectRateLimit } from './reconnect-rate-limit'

const ORIGIN_A = 'chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
const ORIGIN_B = 'chrome-extension://bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'

/** A controllable clock, so nothing here depends on wall time. */
function fakeClock(start = 1_000_000) {
  const state = { t: start }
  return {
    now: () => state.t,
    advance: (ms: number) => {
      state.t += ms
    },
  }
}

describe('ReconnectRateLimit (§8)', () => {
  it('admits up to the per-origin quota and refuses the next attempt', () => {
    const clock = fakeClock()
    const limit = new ReconnectRateLimit({
      perOriginPerMinute: 3,
      globalPerMinute: 100,
      now: clock.now,
    })

    expect([1, 2, 3].map(() => limit.admit(ORIGIN_A))).toEqual([
      true,
      true,
      true,
    ])
    expect(limit.admit(ORIGIN_A)).toBe(false)
  })

  it('meters each origin separately', () => {
    const clock = fakeClock()
    const limit = new ReconnectRateLimit({
      perOriginPerMinute: 2,
      globalPerMinute: 100,
      now: clock.now,
    })

    limit.admit(ORIGIN_A)
    limit.admit(ORIGIN_A)
    expect(limit.admit(ORIGIN_A)).toBe(false)
    // B's own budget is untouched by A exhausting its quota.
    expect(limit.admit(ORIGIN_B)).toBe(true)
  })

  it('refuses past the global quota even for an origin with budget left', () => {
    const clock = fakeClock()
    const limit = new ReconnectRateLimit({
      perOriginPerMinute: 10,
      globalPerMinute: 2,
      now: clock.now,
    })

    expect(limit.admit(ORIGIN_A)).toBe(true)
    expect(limit.admit(ORIGIN_B)).toBe(true)
    // The rotating-origin dodge: a fresh origin gets no free pass, because the
    // global counter is what a local process rotating its Origin cannot escape.
    expect(
      limit.admit('chrome-extension://cccccccccccccccccccccccccccccccc')
    ).toBe(false)
  })

  it('is a rolling window, not a fixed bucket', () => {
    const clock = fakeClock()
    const limit = new ReconnectRateLimit({
      perOriginPerMinute: 2,
      globalPerMinute: 100,
      now: clock.now,
    })

    limit.admit(ORIGIN_A)
    clock.advance(30_000)
    limit.admit(ORIGIN_A)
    expect(limit.admit(ORIGIN_A)).toBe(false)

    // 31s later the FIRST attempt has aged out but the second has not, so
    // exactly one slot frees up — a fixed 60s bucket would have freed both.
    clock.advance(31_000)
    expect(limit.admit(ORIGIN_A)).toBe(true)
    expect(limit.admit(ORIGIN_A)).toBe(false)
  })

  it('does not let a refused attempt deepen the throttle', () => {
    const clock = fakeClock()
    const limit = new ReconnectRateLimit({
      perOriginPerMinute: 1,
      globalPerMinute: 100,
      now: clock.now,
    })

    limit.admit(ORIGIN_A)
    // Hammer while throttled. If a refusal recorded a timestamp, the window
    // would keep sliding forward and the origin could never recover.
    for (let i = 0; i < 20; i++) {
      expect(limit.admit(ORIGIN_A)).toBe(false)
      clock.advance(1_000)
    }
    // 21s after the single admitted attempt, it has NOT yet aged out...
    expect(limit.admit(ORIGIN_A)).toBe(false)
    // ...and at 60s it has.
    clock.advance(40_000)
    expect(limit.admit(ORIGIN_A)).toBe(true)
  })

  it('bounds tracked origins by the global quota, not by origins seen', () => {
    const clock = fakeClock()
    const limit = new ReconnectRateLimit({
      perOriginPerMinute: 10,
      globalPerMinute: 5,
      now: clock.now,
    })

    // A local process can put any Origin it likes on a /v1 upgrade, so this is
    // the shape of a real attack, not a hypothetical.
    for (let i = 0; i < 500; i++) {
      limit.admit(`chrome-extension://rotating${i}`)
    }
    expect(limit.trackedOrigins()).toBeLessThanOrEqual(5)
  })

  it('forgets an origin once its attempts age out', () => {
    const clock = fakeClock()
    const limit = new ReconnectRateLimit({
      perOriginPerMinute: 10,
      globalPerMinute: 100,
      now: clock.now,
    })

    limit.admit(ORIGIN_A)
    expect(limit.trackedOrigins()).toBe(1)

    clock.advance(61_000)
    limit.admit(ORIGIN_B)
    // A's bucket is gone, not merely empty — otherwise a long-running instance
    // accumulates one entry per origin it has ever seen.
    expect(limit.trackedOrigins()).toBe(1)
  })
})
