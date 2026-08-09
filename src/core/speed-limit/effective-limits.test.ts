import type { SpeedLimitSettings } from '@shared/types/settings'
import { describe, expect, it } from 'vitest'
import {
  computeEffectiveLimits,
  minCap,
  withinWindow,
} from './effective-limits'

const make = (over: Partial<SpeedLimitSettings>): SpeedLimitSettings => ({
  base: { download: 0, upload: 0 },
  alt: { download: 500_000, upload: 50_000 },
  turtle: 'off',
  auto: {
    schedule: { enabled: false, from: '23:00', to: '07:00', days: [] },
    videoApp: { enabled: false, processNames: [] },
    adaptive: {
      enabled: false,
      linkDown: 0,
      linkUp: 0,
      headroomPercent: 80,
      speedTest: {
        providers: [],
        selectedProviderId: 'cloudflare',
        concurrency: 4,
        maxDurationSec: 10,
        maxDataMB: 1024,
      },
    },
  },
  ...over,
})

describe('minCap (0 = unlimited)', () => {
  it('returns 0 when all values are 0', () => {
    expect(minCap([0, 0])).toBe(0)
  })
  it('ignores 0 and picks the smallest non-zero', () => {
    expect(minCap([0, 500_000, 300_000])).toBe(300_000)
  })
  it('returns 0 for an empty list', () => {
    expect(minCap([])).toBe(0)
  })
})

describe('withinWindow', () => {
  it('same-day window', () => {
    const now = new Date(2026, 5, 10, 10, 0)
    expect(
      withinWindow(now, { enabled: true, from: '09:00', to: '17:00', days: [] })
    ).toBe(true)
  })
  it('midnight-wrap window includes early morning', () => {
    const now = new Date(2026, 5, 10, 2, 0)
    expect(
      withinWindow(now, { enabled: true, from: '23:00', to: '07:00', days: [] })
    ).toBe(true)
  })
  it('respects day-of-week mask', () => {
    const now = new Date(2026, 5, 10, 10, 0) // Wed = 3
    expect(
      withinWindow(now, {
        enabled: true,
        from: '09:00',
        to: '17:00',
        days: [1, 2],
      })
    ).toBe(false)
  })
  it('degenerate window (from === to) is always false', () => {
    expect(
      withinWindow(new Date(2026, 5, 10, 10, 0), {
        enabled: true,
        from: '10:00',
        to: '10:00',
        days: [],
      })
    ).toBe(false)
  })
})

const noon = { now: new Date(2026, 5, 10, 12, 0), videoAppRunning: false }

describe('computeEffectiveLimits', () => {
  it('off + base 0 → unlimited', () => {
    expect(computeEffectiveLimits(make({ turtle: 'off' }), noon)).toEqual({
      download: 0,
      upload: 0,
    })
  })
  it('off + base set → base (triggers ignored)', () => {
    const s = make({
      turtle: 'off',
      base: { download: 800_000, upload: 80_000 },
    })
    s.auto.schedule = { enabled: true, from: '00:00', to: '23:59', days: [] }
    expect(computeEffectiveLimits(s, noon)).toEqual({
      download: 800_000,
      upload: 80_000,
    })
  })
  it('on → min(base, alt); base 0 → alt', () => {
    expect(computeEffectiveLimits(make({ turtle: 'on' }), noon)).toEqual({
      download: 500_000,
      upload: 50_000,
    })
  })
  it('on → base wins when smaller than alt', () => {
    const s = make({
      turtle: 'on',
      base: { download: 100_000, upload: 10_000 },
    })
    expect(computeEffectiveLimits(s, noon)).toEqual({
      download: 100_000,
      upload: 10_000,
    })
  })
  it('on → axes computed independently (base wins one, alt the other)', () => {
    const s = make({
      turtle: 'on',
      base: { download: 100_000, upload: 200_000 },
      alt: { download: 500_000, upload: 50_000 },
    })
    expect(computeEffectiveLimits(s, noon)).toEqual({
      download: 100_000, // base < alt
      upload: 50_000, // alt < base
    })
  })
  it('auto idle (no trigger) → base', () => {
    const s = make({
      turtle: 'auto',
      base: { download: 900_000, upload: 90_000 },
    })
    expect(computeEffectiveLimits(s, noon)).toEqual({
      download: 900_000,
      upload: 90_000,
    })
  })
  it('auto + active schedule → alt (base 0)', () => {
    const s = make({ turtle: 'auto' })
    s.auto.schedule = { enabled: true, from: '00:00', to: '23:59', days: [] }
    expect(computeEffectiveLimits(s, noon)).toEqual({
      download: 500_000,
      upload: 50_000,
    })
  })
  it('auto + base + active schedule → base & alt coexist (min)', () => {
    // The core gap this refactor closes: 10 MB/s base, throttle to alt at night.
    const s = make({
      turtle: 'auto',
      base: { download: 10_000_000, upload: 1_000_000 },
    })
    s.auto.schedule = { enabled: true, from: '00:00', to: '23:59', days: [] }
    expect(computeEffectiveLimits(s, noon)).toEqual({
      download: 500_000, // alt < base
      upload: 50_000,
    })
  })
  it('auto + videoApp running → alt', () => {
    const s = make({ turtle: 'auto' })
    s.auto.videoApp.enabled = true
    expect(
      computeEffectiveLimits(s, { now: noon.now, videoAppRunning: true })
    ).toEqual({ download: 500_000, upload: 50_000 })
  })
  it('auto + adaptive → capacity * headroom', () => {
    const s = make({ turtle: 'auto' })
    s.auto.adaptive.enabled = true
    s.auto.adaptive.linkDown = 1_000_000
    s.auto.adaptive.linkUp = 100_000
    s.auto.adaptive.headroomPercent = 80
    expect(computeEffectiveLimits(s, noon)).toEqual({
      download: 800_000,
      upload: 80_000,
    })
  })
  it('auto + schedule + adaptive → min of the two', () => {
    const s = make({ turtle: 'auto' })
    s.auto.schedule = { enabled: true, from: '00:00', to: '23:59', days: [] }
    s.auto.adaptive.enabled = true
    s.auto.adaptive.linkDown = 1_000_000 // 80% = 800_000
    s.auto.adaptive.linkUp = 100_000 // 80% = 80_000
    // alt is 500_000 / 50_000 → smaller wins
    expect(computeEffectiveLimits(s, noon)).toEqual({
      download: 500_000,
      upload: 50_000,
    })
  })
})
