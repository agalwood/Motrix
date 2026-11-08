import {
  activityTimeDomain,
  normalizeObservedSpeedHistory,
} from '@renderer/lib/speed-chart'
import type { SpeedPoint } from '@shared/types/stats'
import { TaskStatus } from '@shared/types/task'
import {
  type TaskHistoryEvent,
  type TaskHistoryEventKind,
  type TaskTransferSample,
  TaskTransferSampleFlag,
} from '@shared/types/task-inspector-activity'
import type { ActivityTimelineMarkerGroup } from './activity-timeline-model'

export type ActivityChartRange = 'session' | 'lifetime'
export type ActivityChartEmptyState = 'empty' | 'all-zero' | null
export type ActivityChartDomain = readonly [number, number]
export interface ActivityChartPoint {
  t: number
  down: number | null
  up: number | null
  flags: number
  state: 'observed' | 'paused' | 'missing'
}
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
  points: readonly ActivityChartPoint[]
  domain: ActivityChartDomain | null
  axisCeiling: number
  observationCount: number
  emptyState: ActivityChartEmptyState
  pauseBands: readonly ActivityPauseBand[]
  gapBands: readonly ActivityPauseBand[]
  markers: readonly ActivityChartMarker[]
}
export interface ActivityChartInput {
  range: ActivityChartRange
  sessionPoints: readonly SpeedPoint[]
  lifetimePoints: readonly TaskTransferSample[]
  markerGroups: readonly ActivityTimelineMarkerGroup[]
  selectedMarkerId: string | null
  events?: readonly TaskHistoryEvent[]
  coverageGapAt?: number | null
}

function mergeSamples(
  durable: readonly TaskTransferSample[],
  session: readonly SpeedPoint[]
): TaskTransferSample[] {
  const samples = new Map<number, TaskTransferSample>()
  // Preserve sub-second peaks and terminal boundaries. Durable observations
  // replace provisional values only at the exact same timestamp.
  for (const point of [
    ...session.map((point) => ({ ...point, flags: 0 })),
    ...durable,
  ]) {
    const previous = samples.get(point.t)
    samples.set(point.t, {
      ...point,
      flags: point.flags | (previous?.flags ?? 0),
    })
  }
  return [...samples.values()].sort((a, b) => a.t - b.t)
}

function collectPauses(
  events: readonly TaskHistoryEvent[],
  domain: ActivityChartDomain
): ActivityPauseBand[] {
  const bands: ActivityPauseBand[] = []
  let start: number | null = null
  for (const event of [...events].sort(
    (a, b) => a.eventOrdinal - b.eventOrdinal
  )) {
    if (event.toStatus === TaskStatus.Paused) {
      start ??= event.occurredAt
    } else if (start !== null) {
      if (event.occurredAt > start)
        bands.push({ startAt: start, endAt: event.occurredAt })
      start = null
    }
  }
  if (start !== null && domain[1] > start)
    bands.push({ startAt: start, endAt: domain[1] })
  return bands
    .map((band) => ({
      startAt: Math.max(domain[0], band.startAt),
      endAt: Math.min(domain[1], band.endAt),
    }))
    .filter((band) => band.endAt > band.startAt)
}

function mergeBands(bands: ActivityPauseBand[]): ActivityPauseBand[] {
  const merged: ActivityPauseBand[] = []
  for (const band of bands.sort((a, b) => a.startAt - b.startAt)) {
    const previous = merged.at(-1)
    if (previous && band.startAt <= previous.endAt)
      previous.endAt = Math.max(previous.endAt, band.endAt)
    else if (band.endAt > band.startAt) merged.push({ ...band })
  }
  return merged
}

function subtractPauses(
  band: ActivityPauseBand,
  pauses: readonly ActivityPauseBand[]
): ActivityPauseBand[] {
  let remaining = [band]
  for (const pause of pauses) {
    remaining = remaining.flatMap((part) => {
      if (pause.endAt <= part.startAt || pause.startAt >= part.endAt)
        return [part]
      return [
        { startAt: part.startAt, endAt: Math.min(part.endAt, pause.startAt) },
        { startAt: Math.max(part.startAt, pause.endAt), endAt: part.endAt },
      ].filter((part) => part.endAt > part.startAt)
    })
  }
  return remaining
}

export function buildActivityChartModel(
  input: ActivityChartInput
): ActivityChartModel {
  const session = normalizeObservedSpeedHistory(input.sessionPoints, 60)
  const observed = mergeSamples(input.lifetimePoints, session)
  const events =
    input.events ?? input.markerGroups.flatMap((group) => group.events)
  const observedDomain = activityTimeDomain(observed)
  const lastEventAt = Math.max(0, ...events.map((event) => event.occurredAt))
  const domain: ActivityChartDomain | null = observedDomain
    ? [observedDomain[0], Math.max(observedDomain[1], lastEventAt)]
    : null
  const pauses = domain ? collectPauses(events, domain) : []
  const gaps: ActivityPauseBand[] = []
  for (let index = 1; index < observed.length; index++) {
    const previous = observed[index - 1]
    const point = observed[index]
    if ((point.flags & TaskTransferSampleFlag.CoverageGap) !== 0) {
      gaps.push({ startAt: previous.t, endAt: point.t })
    }
  }
  // Live updates are event-driven, and durable history is compacted. Neither
  // stream's spacing proves an interruption; use recorded coverage evidence.
  if (input.coverageGapAt != null && domain) {
    const coverageGapAt = input.coverageGapAt
    const next = observed.find((point) => point.t > coverageGapAt)
    if (next)
      gaps.push({
        startAt: Math.max(domain[0], input.coverageGapAt),
        endAt: next.t,
      })
  }
  const gapBands = mergeBands(
    gaps.flatMap((gap) => subtractPauses(gap, pauses))
  )
  const points: ActivityChartPoint[] = observed.map((point) => ({
    ...point,
    state: 'observed',
  }))
  for (const pause of pauses) {
    for (const point of points) {
      if (point.t >= pause.startAt && point.t < pause.endAt) {
        point.down = 0
        point.up = 0
        point.state = 'paused'
      }
    }
    points.push({ t: pause.startAt, down: 0, up: 0, flags: 0, state: 'paused' })
    points.push({
      t: pause.endAt - Math.min(1, (pause.endAt - pause.startAt) / 2),
      down: 0,
      up: 0,
      flags: 0,
      state: 'paused',
    })
  }
  for (const gap of gapBands) {
    // Keep measured endpoints, but break both paths throughout the unknown interval.
    for (const point of points) {
      if (point.t > gap.startAt && point.t < gap.endAt) {
        point.down = null
        point.up = null
        point.state = 'missing'
      }
    }
    const inset = Math.min(1, (gap.endAt - gap.startAt) / 3)
    for (const t of [gap.startAt + inset, gap.endAt - inset])
      points.push({ t, down: null, up: null, flags: 0, state: 'missing' })
  }
  const byTime = new Map(points.map((point) => [point.t, point]))
  const ordered = [...byTime.values()].sort((a, b) => a.t - b.t)
  const maximum = Math.max(
    1,
    ...ordered.map((point) => Math.max(point.down ?? 0, point.up ?? 0))
  )
  return {
    range: input.range,
    points: ordered,
    domain,
    axisCeiling: maximum,
    observationCount: observed.length,
    emptyState:
      observed.length === 0
        ? 'empty'
        : gapBands.length === 0 &&
            ordered.every((point) => point.down === 0 && point.up === 0)
          ? 'all-zero'
          : null,
    pauseBands: pauses,
    gapBands,
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
