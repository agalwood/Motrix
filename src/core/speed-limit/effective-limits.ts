import type {
  SpeedLimitProfile,
  SpeedLimitSchedule,
  SpeedLimitSettings,
} from '@shared/types/settings'

export interface EffectiveLimitContext {
  now: Date
  /** Phase 2: cached result of the video-app probe. Always false in Phase 1. */
  videoAppRunning: boolean
}

/**
 * Minimum cap where 0 means "unlimited" (the largest possible cap).
 * Returns the smallest non-zero value; 0 only when every value is 0 / empty.
 */
export function minCap(values: number[]): number {
  let min = 0
  for (const v of values) {
    if (v <= 0) continue
    if (min === 0 || v < min) min = v
  }
  return min
}

function toMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(':')
  return Number(h) * 60 + Number(m)
}

export function withinWindow(now: Date, schedule: SpeedLimitSchedule): boolean {
  if (schedule.days.length > 0 && !schedule.days.includes(now.getDay())) {
    return false
  }
  const cur = now.getHours() * 60 + now.getMinutes()
  const from = toMinutes(schedule.from)
  const to = toMinutes(schedule.to)
  if (from === to) return false // empty/degenerate window
  if (from < to) return cur >= from && cur < to // same-day
  return cur >= from || cur < to // midnight wrap
}

export function computeEffectiveLimits(
  s: SpeedLimitSettings,
  ctx: EffectiveLimitContext
): SpeedLimitProfile {
  if (s.turtle === 'off') return { ...s.base }
  if (s.turtle === 'on') {
    return {
      download: minCap([s.base.download, s.alt.download]),
      upload: minCap([s.base.upload, s.alt.upload]),
    }
  }
  // turtle === 'auto'
  const downs: number[] = [s.base.download]
  const ups: number[] = [s.base.upload]
  const { schedule, videoApp, adaptive } = s.auto
  const altActive =
    (schedule.enabled && withinWindow(ctx.now, schedule)) ||
    (videoApp.enabled && ctx.videoAppRunning)
  if (altActive) {
    downs.push(s.alt.download)
    ups.push(s.alt.upload)
  }
  if (adaptive.enabled) {
    downs.push(Math.floor((adaptive.linkDown * adaptive.headroomPercent) / 100))
    ups.push(Math.floor((adaptive.linkUp * adaptive.headroomPercent) / 100))
  }
  return { download: minCap(downs), upload: minCap(ups) }
}
