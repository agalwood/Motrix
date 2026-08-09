import type { SpeedPoint } from '@shared/types/stats'
import { TaskStatus } from '@shared/types/task'
import {
  TaskHistoryAccuracy,
  type TaskHistoryEvent,
  TaskHistoryEventKind,
  type TaskTransferSample,
  TaskTransferSampleFlag,
} from '@shared/types/task-inspector-activity'
import { describe, expect, it } from 'vitest'
import { buildActivityChartModel } from './activity-chart-model'
import type { ActivityTimelineMarkerGroup } from './activity-timeline-model'

function speed(t: number, down: number, up = 0): SpeedPoint {
  return { t, down, up }
}

function sample(
  t: number,
  down: number,
  up = 0,
  flags = 0
): TaskTransferSample {
  return { t, down, up, flags }
}

function event(
  ordinal: number,
  kind: TaskHistoryEventKind,
  occurredAt: number
): TaskHistoryEvent {
  return {
    eventOrdinal: ordinal,
    eventKey: `event-${ordinal}`,
    kind,
    fromStatus: null,
    toStatus:
      kind === TaskHistoryEventKind.Paused
        ? TaskStatus.Paused
        : TaskStatus.Downloading,
    occurredAt,
    accuracy: TaskHistoryAccuracy.Exact,
    errorCode: null,
    errorMessage: null,
    errorDetailKey: null,
    errorDetailParams: null,
  }
}

function marker(
  id: string,
  events: readonly TaskHistoryEvent[]
): ActivityTimelineMarkerGroup {
  const first = events[0] as TaskHistoryEvent
  const last = events.at(-1) as TaskHistoryEvent
  return {
    id,
    events,
    kind: events.every((item) => item.kind === first.kind) ? first.kind : null,
    occurredAt: last.occurredAt,
    rangeStartAt: first.occurredAt,
    rangeEndAt: last.occurredAt,
    count: events.length,
  }
}

describe('buildActivityChartModel', () => {
  it('uses only the latest 60 real Session points', () => {
    const session = Array.from({ length: 65 }, (_, index) =>
      speed(index * 1_000, index)
    )
    const model = buildActivityChartModel({
      range: 'session',
      sessionPoints: session,
      lifetimePoints: [],
      markerGroups: [],
      selectedMarkerId: null,
    })

    expect(model.points).toHaveLength(60)
    expect(model.points[0]?.t).toBe(5_000)
    expect(model.points.at(-1)?.t).toBe(64_000)
    expect(model.points.every((point) => point.flags === 0)).toBe(true)
  })

  it('uses at most 96 durable Lifetime observations before projection padding', () => {
    const lifetime = Array.from({ length: 100 }, (_, index) =>
      sample(index * 1_000, index, 0, TaskTransferSampleFlag.StatusBoundary)
    )
    const model = buildActivityChartModel({
      range: 'lifetime',
      sessionPoints: [],
      lifetimePoints: lifetime,
      markerGroups: [],
      selectedMarkerId: null,
    })

    expect(model.points).toHaveLength(96)
    expect(model.points[0]).toEqual(lifetime[0])
    expect(model.points.at(-1)).toEqual(lifetime[95])
  })

  it('uses the current Session tail while a new task has no durable Lifetime points', () => {
    const model = buildActivityChartModel({
      range: 'lifetime',
      sessionPoints: [speed(1_100, 8), speed(2_100, 16, 2)],
      lifetimePoints: [],
      markerGroups: [],
      selectedMarkerId: null,
    })

    expect(model.points).toEqual([sample(1_000, 8), sample(2_000, 16, 2)])
    expect(model.emptyState).toBeNull()
    expect(model.domain).toEqual([1_000, 2_000])
  })

  it('keeps the rendered Lifetime series stable when a Session point is checkpointed', () => {
    const input = {
      range: 'lifetime' as const,
      sessionPoints: [speed(1_100, 8), speed(2_100, 16, 2)],
      markerGroups: [],
      selectedMarkerId: null,
    }
    const beforeCheckpoint = buildActivityChartModel({
      ...input,
      lifetimePoints: [],
    })
    const afterCheckpoint = buildActivityChartModel({
      ...input,
      lifetimePoints: [sample(1_100, 8)],
    })

    expect(afterCheckpoint).toEqual(beforeCheckpoint)
  })

  it('deduplicates overlapping durable and Session seconds while retaining flags and peaks', () => {
    const model = buildActivityChartModel({
      range: 'lifetime',
      sessionPoints: [speed(1_800, 12, 1), speed(3_100, 20)],
      lifetimePoints: [
        sample(1_100, 8, 2, TaskTransferSampleFlag.StatusBoundary),
        sample(2_100, 4, 0, TaskTransferSampleFlag.Terminal),
      ],
      markerGroups: [],
      selectedMarkerId: null,
    })

    expect(model.points).toEqual([
      sample(1_000, 12, 1, TaskTransferSampleFlag.StatusBoundary),
      sample(2_000, 4, 0, TaskTransferSampleFlag.Terminal),
      sample(3_000, 20),
    ])
  })

  it('keeps zero/one/two-point domain semantics aligned to displayed seconds', () => {
    const empty = buildActivityChartModel({
      range: 'lifetime',
      sessionPoints: [],
      lifetimePoints: [],
      markerGroups: [],
      selectedMarkerId: null,
    })
    const one = buildActivityChartModel({
      range: 'lifetime',
      sessionPoints: [],
      lifetimePoints: [sample(1_000, 8)],
      markerGroups: [],
      selectedMarkerId: null,
    })
    const two = buildActivityChartModel({
      range: 'lifetime',
      sessionPoints: [],
      lifetimePoints: [sample(1_000, 8), sample(2_500, 16)],
      markerGroups: [],
      selectedMarkerId: null,
    })

    expect(empty.domain).toBeNull()
    expect(empty.emptyState).toBe('empty')
    expect(one.domain).toEqual([500, 1_500])
    expect(one.points).toEqual([sample(1_000, 8)])
    expect(two.domain).toEqual([1_000, 2_000])
    expect(two.points).toEqual([sample(1_000, 8), sample(2_000, 16)])
  })

  it('keeps an all-zero baseline distinct from an empty series', () => {
    const model = buildActivityChartModel({
      range: 'lifetime',
      sessionPoints: [],
      lifetimePoints: [sample(1_000, 0), sample(2_000, 0)],
      markerGroups: [],
      selectedMarkerId: null,
    })

    expect(model.emptyState).toBe('all-zero')
    expect(model.axisCeiling).toBe(1)
    expect(model.domain).toEqual([1_000, 2_000])
  })

  it('fills missing one-second buckets between real observations with zeros', () => {
    const model = buildActivityChartModel({
      range: 'lifetime',
      sessionPoints: [],
      lifetimePoints: [sample(1_000, 8), sample(4_000, 16)],
      markerGroups: [],
      selectedMarkerId: null,
    })

    expect(model.points).toEqual([
      sample(1_000, 8),
      sample(2_000, 0),
      sample(3_000, 0),
      sample(4_000, 16),
    ])
    expect(model.domain).toEqual([1_000, 4_000])
  })

  it('merges sub-second observations into one bucket and preserves its peak', () => {
    const model = buildActivityChartModel({
      range: 'lifetime',
      sessionPoints: [],
      lifetimePoints: [
        sample(1_100, 0, 0, TaskTransferSampleFlag.StatusBoundary),
        sample(1_800, 8, 1),
        sample(2_100, 16),
        sample(2_900, 0, 0, TaskTransferSampleFlag.Terminal),
        sample(4_100, 0),
      ],
      markerGroups: [],
      selectedMarkerId: null,
    })

    expect(model.points).toEqual([
      sample(1_000, 8, 1, TaskTransferSampleFlag.StatusBoundary),
      sample(2_000, 16, 0, TaskTransferSampleFlag.Terminal),
      sample(3_000, 0),
      sample(4_000, 0),
    ])
  })

  it('bounds render-only zero padding for long-lived tasks', () => {
    const model = buildActivityChartModel({
      range: 'lifetime',
      sessionPoints: [],
      lifetimePoints: [sample(1_000, 8), sample(3_601_000, 16)],
      markerGroups: [],
      selectedMarkerId: null,
    })

    expect(model.points.length).toBeLessThanOrEqual(600)
    expect(model.points[0]).toEqual(sample(1_000, 8))
    expect(model.points.at(-1)).toEqual(sample(3_601_000, 16))
    expect(model.domain).toEqual([1_000, 3_601_000])
  })

  it('sizes the Y-axis for stacked download and upload values', () => {
    const model = buildActivityChartModel({
      range: 'lifetime',
      sessionPoints: [],
      lifetimePoints: [sample(1_000, 8, 7), sample(2_000, 6, 1)],
      markerGroups: [],
      selectedMarkerId: null,
    })

    expect(model.axisCeiling).toBe(15)
  })

  it('projects pause bands and marker selection independently from points', () => {
    const paused = event(1, TaskHistoryEventKind.Paused, 1_500)
    const resumed = event(2, TaskHistoryEventKind.Resumed, 2_500)
    const markerGroups = [
      marker('pause', [paused]),
      marker('resume', [resumed]),
    ]
    const model = buildActivityChartModel({
      range: 'lifetime',
      sessionPoints: [],
      lifetimePoints: [
        sample(1_000, 10),
        sample(3_000, 20, 1, TaskTransferSampleFlag.StatusBoundary),
      ],
      markerGroups,
      selectedMarkerId: 'resume',
    })

    expect(model.pauseBands).toEqual([{ startAt: 1_500, endAt: 2_500 }])
    expect(model.markers).toEqual([
      expect.objectContaining({ id: 'pause', selected: false }),
      expect.objectContaining({ id: 'resume', selected: true }),
    ])
    expect(model.points).toEqual([
      sample(1_000, 10),
      sample(2_000, 0),
      sample(3_000, 20, 1, TaskTransferSampleFlag.StatusBoundary),
    ])
  })
})
