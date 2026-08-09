import type { SpeedPoint } from '@shared/types/stats'
import { formatBytes } from './format'

export const SPEED_CHART_MIN_POINTS = 24
const DEFAULT_STEP_MS = 1_000

export function normalizeSpeedHistory(
  history: readonly SpeedPoint[],
  minPoints = SPEED_CHART_MIN_POINTS
): readonly SpeedPoint[] {
  if (history.length >= minPoints) return history

  const firstPoint = history[0]
  const secondPoint = history[1]
  const step =
    firstPoint && secondPoint
      ? Math.max(1, secondPoint.t - firstPoint.t)
      : DEFAULT_STEP_MS
  const paddingCount = minPoints - history.length
  const firstTimestamp = firstPoint?.t ?? Date.now()
  const padding = Array.from({ length: paddingCount }, (_, index) => ({
    t: firstTimestamp - (paddingCount - index) * step,
    down: 0,
    up: 0,
  }))

  return [...padding, ...history]
}

export function normalizeObservedSpeedHistory<T extends SpeedPoint>(
  history: readonly T[],
  maxPoints: number
): readonly T[] {
  const ordered = [...history].sort((left, right) => left.t - right.t)
  const cap = Math.max(0, Math.floor(maxPoints))
  if (cap === 0) return []
  return ordered.length > cap ? ordered.slice(-cap) : ordered
}

export function activityTimeDomain(
  history: readonly SpeedPoint[]
): readonly [number, number] | null {
  if (history.length === 0) return null
  const timestamps = history
    .map((point) => point.t)
    .filter(Number.isFinite)
    .sort((left, right) => left - right)
  const first = timestamps[0]
  const last = timestamps.at(-1)
  if (first === undefined || last === undefined) return null
  if (first === last) return [first - 500, first + 500]
  return [first, last]
}

export function chartCeiling(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 1
  const power = 10 ** Math.floor(Math.log10(value))
  const normalized = value / power
  const step = normalized <= 2 ? 2 : normalized <= 5 ? 5 : 10
  return step * power
}

export function formatSpeed(bytesPerSecond: number): string {
  if (!Number.isFinite(bytesPerSecond) || bytesPerSecond < 1) return '0 B/s'
  return `${formatBytes(bytesPerSecond)}/s`
}
