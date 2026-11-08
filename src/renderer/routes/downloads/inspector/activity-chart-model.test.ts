import { TaskStatus } from '@shared/types/task'
import {
  TaskHistoryAccuracy,
  type TaskHistoryEvent,
  TaskHistoryEventKind,
  type TaskTransferSample,
  TaskTransferSampleFlag,
} from '@shared/types/task-inspector-activity'
import { describe, expect, it } from 'vitest'
import {
  type ActivityChartInput,
  buildActivityChartModel,
} from './activity-chart-model'

const sample = (
  t: number,
  down: number,
  up = 0,
  flags = 0
): TaskTransferSample => ({ t, down, up, flags })
const input = (
  patch: Partial<ActivityChartInput> = {}
): ActivityChartInput => ({
  range: 'lifetime',
  sessionPoints: [],
  lifetimePoints: [],
  markerGroups: [],
  selectedMarkerId: null,
  ...patch,
})
function event(
  eventOrdinal: number,
  occurredAt: number,
  toStatus: TaskStatus
): TaskHistoryEvent {
  return {
    eventOrdinal,
    eventKey: `e${eventOrdinal}`,
    occurredAt,
    toStatus,
    fromStatus: null,
    kind:
      toStatus === TaskStatus.Paused
        ? TaskHistoryEventKind.Paused
        : TaskHistoryEventKind.Resumed,
    accuracy: TaskHistoryAccuracy.Exact,
    errorCode: null,
    errorMessage: null,
    errorDetailKey: null,
    errorDetailParams: null,
  }
}

describe('buildActivityChartModel', () => {
  it('keeps observed timestamps and does not fill compacted history with zeros', () => {
    const model = buildActivityChartModel(
      input({ lifetimePoints: [sample(1100, 8), sample(3601500, 16)] })
    )
    expect(model.points).toEqual([
      expect.objectContaining({ t: 1100, down: 8, state: 'observed' }),
      expect.objectContaining({ t: 3601500, down: 16, state: 'observed' }),
    ])
    expect(model.gapBands).toEqual([])
    expect(model.domain).toEqual([1100, 3601500])
  })
  it('merges the live tail into durable history for both time ranges', () => {
    for (const range of ['session', 'lifetime'] as const) {
      const model = buildActivityChartModel(
        input({
          range,
          sessionPoints: [sample(2000, 12), sample(3000, 18)],
          lifetimePoints: [sample(1000, 8), sample(2000, 12)],
        })
      )
      expect(model.observationCount).toBe(3)
      expect(model.points.map((p) => p.down)).toEqual([8, 12, 18])
    }
  })
  it('keeps sub-second transfers visible alongside their terminal boundary', () => {
    const model = buildActivityChartModel(
      input({
        sessionPoints: [sample(1100, 50)],
        lifetimePoints: [sample(1500, 0, 0, TaskTransferSampleFlag.Terminal)],
      })
    )
    expect(model.points).toEqual([
      expect.objectContaining({ t: 1100, down: 50 }),
      expect.objectContaining({
        t: 1500,
        down: 0,
        flags: TaskTransferSampleFlag.Terminal,
      }),
    ])
  })
  it('retains durable peaks within a second and deduplicates exact timestamps', () => {
    const model = buildActivityChartModel(
      input({
        sessionPoints: [sample(1500, 999)],
        lifetimePoints: [
          sample(1100, 80),
          sample(1300, 10, 100),
          sample(1500, 0, 0, TaskTransferSampleFlag.Terminal),
        ],
      })
    )
    expect(
      model.points.map((point) => [point.t, point.down, point.up])
    ).toEqual([
      [1100, 80, 0],
      [1300, 10, 100],
      [1500, 0, 0],
    ])
    expect(model.axisCeiling).toBe(100)
    expect(model.emptyState).toBeNull()
  })
  it('bounds the retained live stream without inventing samples', () => {
    const model = buildActivityChartModel(
      input({
        sessionPoints: Array.from({ length: 80 }, (_, i) =>
          sample(1000 + i * 1000, i)
        ),
      })
    )
    expect(model.points).toHaveLength(60)
    expect(model.points[0].t).toBe(21000)
    expect(model.observationCount).toBe(60)
  })
  it('does not infer missing samples from quiet event-driven updates', () => {
    const model = buildActivityChartModel(
      input({
        sessionPoints: [sample(1000, 8), sample(2000, 0), sample(12000, 16)],
      })
    )
    expect(model.gapBands).toEqual([])
    expect(model.points.find((p) => p.t === 2000)).toMatchObject({
      down: 0,
      state: 'observed',
    })
    expect(model.points).toHaveLength(3)
    expect(model.emptyState).toBeNull()
  })
  it('breaks both paths at explicit coverage gaps in compacted history', () => {
    const model = buildActivityChartModel(
      input({
        lifetimePoints: [
          sample(1000, 8),
          sample(15000, 16, 2, TaskTransferSampleFlag.CoverageGap),
          sample(30000, 20),
        ],
      })
    )
    expect(model.gapBands).toEqual([{ startAt: 1000, endAt: 15000 }])
    expect(model.points.filter((p) => p.state === 'missing')).toHaveLength(2)
    expect(model.points.at(-1)).toMatchObject({ t: 30000, down: 20 })
  })
  it('uses the coverage timestamp when a snapshot has no retained gap flag', () => {
    const model = buildActivityChartModel(
      input({
        lifetimePoints: [sample(1000, 8), sample(10000, 16)],
        coverageGapAt: 3000,
      })
    )
    expect(model.gapBands).toEqual([{ startAt: 3000, endAt: 10000 }])
    expect(model.points[0].down).toBe(8)
  })

  it('does not erase durable observations when the renderer missed live updates', () => {
    const model = buildActivityChartModel(
      input({
        sessionPoints: [sample(1000, 8), sample(20000, 20)],
        lifetimePoints: [sample(1000, 8), sample(10000, 12), sample(20000, 20)],
      })
    )
    expect(model.gapBands).toEqual([])
    expect(model.points.find((point) => point.t === 10000)).toMatchObject({
      down: 12,
      state: 'observed',
    })
  })
  it('uses explicit paused intervals as zero, not missing samples', () => {
    const events = [
      event(1, 2000, TaskStatus.Paused),
      event(2, 12000, TaskStatus.Downloading),
    ]
    const model = buildActivityChartModel(
      input({
        sessionPoints: [sample(1000, 8), sample(2000, 0), sample(12000, 16)],
        events,
      })
    )
    expect(model.pauseBands).toEqual([{ startAt: 2000, endAt: 12000 }])
    expect(model.gapBands).toEqual([])
    expect(
      model.points
        .filter((p) => p.t >= 2000 && p.t < 12000)
        .every((p) => p.down === 0 && p.state === 'paused')
    ).toBe(true)
  })
  it('keeps missing portions on either side of a known pause separate', () => {
    const model = buildActivityChartModel(
      input({
        sessionPoints: [sample(1000, 8), sample(15000, 16)],
        lifetimePoints: [
          sample(15000, 16, 0, TaskTransferSampleFlag.CoverageGap),
        ],
        events: [
          event(1, 3000, TaskStatus.Paused),
          event(2, 10000, TaskStatus.Downloading),
        ],
      })
    )
    expect(model.gapBands).toEqual([
      { startAt: 1000, endAt: 3000 },
      { startAt: 10000, endAt: 15000 },
    ])
    expect(model.points.find((p) => p.t === 3000)).toMatchObject({
      down: 0,
      state: 'paused',
    })
  })
  it('closes a pause on any subsequent state transition and preserves marker selection', () => {
    const events = [
      event(1, 2000, TaskStatus.Paused),
      event(2, 5000, TaskStatus.Error),
    ]
    const model = buildActivityChartModel(
      input({
        lifetimePoints: [sample(1000, 8), sample(10000, 0)],
        events,
        markerGroups: [
          {
            id: 'pause',
            kind: TaskHistoryEventKind.Paused,
            events: [events[0]],
            occurredAt: 2000,
            rangeStartAt: 2000,
            rangeEndAt: 2000,
            count: 1,
          },
        ],
        selectedMarkerId: 'pause',
      })
    )
    expect(model.pauseBands).toEqual([{ startAt: 2000, endAt: 5000 }])
    expect(model.markers[0].selected).toBe(true)
  })
  it('keeps empty and zero-traffic states distinct and scales each direction independently', () => {
    const empty = buildActivityChartModel(input())
    const zero = buildActivityChartModel(
      input({ lifetimePoints: [sample(1000, 0)] })
    )
    const moving = buildActivityChartModel(
      input({ lifetimePoints: [sample(1000, 8, 7), sample(2000, 6, 12)] })
    )
    expect(empty.emptyState).toBe('empty')
    expect(empty.domain).toBeNull()
    expect(zero.emptyState).toBe('all-zero')
    expect(zero.axisCeiling).toBe(1)
    expect(moving.axisCeiling).toBe(12)
  })
})
