import {
  activityTimeDomain,
  normalizeObservedSpeedHistory,
} from '@renderer/lib/speed-chart'
import type { SpeedPoint } from '@shared/types/stats'
import {
  TaskHistoryEventKind,
  type TaskTransferSample,
} from '@shared/types/task-inspector-activity'
import type { ActivityTimelineMarkerGroup } from './activity-timeline-model'

const MAX_SESSION_POINTS = 60
const MAX_LIFETIME_POINTS = 96
const MAX_PROJECTED_POINTS = 600
const SECOND_MS = 1_000

export type ActivityChartRange = 'session' | 'lifetime'
export type ActivityChartEmptyState = 'empty' | 'all-zero' | null

export interface ActivityChartMarker {
  id: string
  kind: TaskHistoryEventKind | null
  occurredAt: number
  rangeStartAt: number
  rangeEndAt: number
  count: number
  selected: boolean
}

export interface ActivityPauseBand {
  startAt: number
  endAt: number
}

export interface ActivityChartModel {
  range: ActivityChartRange
  points: readonly TaskTransferSample[]
  domain: readonly [number, number] | null
  axisCeiling: number
  emptyState: ActivityChartEmptyState
  pauseBands: readonly ActivityPauseBand[]
  markers: readonly ActivityChartMarker[]
}

export interface ActivityChartInput {
  range: ActivityChartRange
  sessionPoints: readonly SpeedPoint[]
  lifetimePoints: readonly TaskTransferSample[]
  markerGroups: readonly ActivityTimelineMarkerGroup[]
  selectedMarkerId: string | null
}

function sessionPoints(
  points: readonly SpeedPoint[]
): readonly TaskTransferSample[] {
  return normalizeObservedSpeedHistory(points, MAX_SESSION_POINTS).map(
    (point) => ({ ...point, flags: 0 })
  )
}

function lifetimePoints(
  points: readonly TaskTransferSample[],
  currentSession: readonly SpeedPoint[]
): readonly TaskTransferSample[] {
  const durable = [...points]
    .sort((left, right) => left.t - right.t)
    .slice(0, MAX_LIFETIME_POINTS)

  // The durable series checkpoints every 30 seconds. Merge its current
  // process-local tail before projection so a new task renders immediately
  // and checkpointed seconds replace provisional seconds in place.
  return projectObservedSeconds([...durable, ...sessionPoints(currentSession)])
}

function projectObservedSeconds(
  points: readonly TaskTransferSample[]
): readonly TaskTransferSample[] {
  const buckets = new Map<number, TaskTransferSample>()

  for (const point of points) {
    const timestamp = Math.floor(point.t / SECOND_MS) * SECOND_MS
    const existing = buckets.get(timestamp)
    if (!existing) {
      buckets.set(timestamp, { ...point, t: timestamp })
      continue
    }

    const peak =
      point.down + point.up >= existing.down + existing.up ? point : existing
    buckets.set(timestamp, {
      t: timestamp,
      down: peak.down,
      up: peak.up,
      flags: existing.flags | point.flags,
    })
  }

  return [...buckets.values()].sort((left, right) => left.t - right.t)
}

function fillMissingTimeBuckets(
  points: readonly TaskTransferSample[]
): readonly TaskTransferSample[] {
  const observed = projectObservedSeconds(points)
  if (observed.length < 2 || observed.length >= MAX_PROJECTED_POINTS) {
    return observed
  }

  const firstAt = observed[0]?.t
  const lastAt = observed.at(-1)?.t
  if (firstAt === undefined || lastAt === undefined || lastAt <= firstAt) {
    return observed
  }

  const availableSlots = MAX_PROJECTED_POINTS - observed.length
  const step =
    Math.max(1, Math.ceil((lastAt - firstAt) / SECOND_MS / availableSlots)) *
    SECOND_MS
  const occupiedBuckets = new Set(
    observed.map((point) => Math.floor(point.t / step))
  )
  const padding: TaskTransferSample[] = []

  for (
    let timestamp = Math.ceil(firstAt / step) * step;
    timestamp < lastAt && padding.length < availableSlots;
    timestamp += step
  ) {
    if (occupiedBuckets.has(Math.floor(timestamp / step))) continue
    padding.push({ t: timestamp, down: 0, up: 0, flags: 0 })
  }

  return [...observed, ...padding].sort((left, right) => left.t - right.t)
}

function pauseBands(
  markerGroups: readonly ActivityTimelineMarkerGroup[],
  domain: readonly [number, number] | null
): ActivityPauseBand[] {
  if (!domain) return []
  const events = markerGroups
    .flatMap((group) => group.events)
    .sort((left, right) => left.eventOrdinal - right.eventOrdinal)
  const bands: ActivityPauseBand[] = []
  let pausedAt: number | null = null

  for (const item of events) {
    if (item.kind === TaskHistoryEventKind.Paused) {
      pausedAt = item.occurredAt
      continue
    }
    if (
      item.kind === TaskHistoryEventKind.Resumed &&
      pausedAt !== null &&
      item.occurredAt >= pausedAt
    ) {
      bands.push({ startAt: pausedAt, endAt: item.occurredAt })
      pausedAt = null
    }
  }

  if (pausedAt !== null && pausedAt < domain[1]) {
    bands.push({ startAt: pausedAt, endAt: domain[1] })
  }

  return bands.filter(
    (band) => band.endAt >= domain[0] && band.startAt <= domain[1]
  )
}

export function buildActivityChartModel(
  input: ActivityChartInput
): ActivityChartModel {
  const observedPoints =
    input.range === 'session'
      ? sessionPoints(input.sessionPoints)
      : lifetimePoints(input.lifetimePoints, input.sessionPoints)
  const points = fillMissingTimeBuckets(observedPoints)
  const domain = activityTimeDomain(points)
  const allZero =
    points.length > 0 &&
    points.every((point) => point.down === 0 && point.up === 0)
  const maxValue = points.reduce(
    (maximum, point) => Math.max(maximum, point.down + point.up),
    0
  )

  return {
    range: input.range,
    points,
    domain,
    axisCeiling: Math.max(1, maxValue),
    emptyState: points.length === 0 ? 'empty' : allZero ? 'all-zero' : null,
    pauseBands: pauseBands(input.markerGroups, domain),
    markers: input.markerGroups.slice(0, 8).map((group) => ({
      id: group.id,
      kind: group.kind,
      occurredAt: group.occurredAt,
      rangeStartAt: group.rangeStartAt,
      rangeEndAt: group.rangeEndAt,
      count: group.count,
      selected: group.id === input.selectedMarkerId,
    })),
  }
}
