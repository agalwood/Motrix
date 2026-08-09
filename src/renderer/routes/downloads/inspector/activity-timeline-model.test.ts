import { TaskStatus } from '@shared/types/task'
import {
  TaskHistoryAccuracy,
  type TaskHistoryEvent,
  TaskHistoryEventKind,
} from '@shared/types/task-inspector-activity'
import { makeDownloadTask } from '@test-utils/task'
import { describe, expect, it } from 'vitest'
import { buildActivityTimelineModel } from './activity-timeline-model'

function event(
  ordinal: number,
  kind: TaskHistoryEventKind,
  toStatus: TaskStatus,
  occurredAt = ordinal * 1_000
): TaskHistoryEvent {
  return {
    eventOrdinal: ordinal,
    eventKey: `event-${ordinal}`,
    kind,
    fromStatus: null,
    toStatus,
    occurredAt,
    accuracy: TaskHistoryAccuracy.Exact,
    errorCode: kind === TaskHistoryEventKind.Failed ? 'NETWORK' : null,
    errorMessage:
      kind === TaskHistoryEventKind.Failed ? 'connection refused' : null,
    errorDetailKey: null,
    errorDetailParams: null,
  }
}

describe('buildActivityTimelineModel', () => {
  it('renders a current-only endpoint for empty durable history', () => {
    const model = buildActivityTimelineModel({
      events: [],
      task: makeDownloadTask({
        id: 'task-1',
        status: TaskStatus.Downloading,
        updatedAt: 9_000,
      }),
      availableWidth: 700,
    })

    expect(model.nodes).toHaveLength(1)
    expect(model.nodes[0]).toMatchObject({
      presentation: 'current',
      status: TaskStatus.Downloading,
      occurredAt: 9_000,
      isCurrent: true,
    })
  })

  it('shows every event in a normal five-node history', () => {
    const events = [
      event(1, TaskHistoryEventKind.Added, TaskStatus.Queued),
      event(2, TaskHistoryEventKind.Started, TaskStatus.Downloading),
      event(3, TaskHistoryEventKind.Paused, TaskStatus.Paused),
      event(4, TaskHistoryEventKind.Resumed, TaskStatus.Downloading),
    ]
    const model = buildActivityTimelineModel({
      events,
      task: makeDownloadTask({
        status: TaskStatus.Downloading,
        updatedAt: 5_000,
      }),
      availableWidth: 700,
    })

    expect(model.nodes.map((node) => node.presentation)).toEqual([
      'event',
      'event',
      'event',
      'event',
      'current',
    ])
    expect(model.nodes.flatMap((node) => node.events)).toEqual(events)
  })

  it('combines repeated pauses without losing their chronological detail', () => {
    const events = [
      event(1, TaskHistoryEventKind.Added, TaskStatus.Queued),
      event(2, TaskHistoryEventKind.Started, TaskStatus.Downloading),
      event(3, TaskHistoryEventKind.Paused, TaskStatus.Paused),
      event(4, TaskHistoryEventKind.Resumed, TaskStatus.Downloading),
      event(5, TaskHistoryEventKind.Paused, TaskStatus.Paused),
      event(6, TaskHistoryEventKind.Resumed, TaskStatus.Downloading),
      event(7, TaskHistoryEventKind.Paused, TaskStatus.Paused),
      event(8, TaskHistoryEventKind.Resumed, TaskStatus.Downloading),
    ]
    const model = buildActivityTimelineModel({
      events,
      task: makeDownloadTask({
        status: TaskStatus.Downloading,
        updatedAt: 9_000,
      }),
      availableWidth: 700,
    })

    const pauses = model.nodes.find(
      (node) =>
        node.presentation === 'repeated' &&
        node.kind === TaskHistoryEventKind.Paused
    )
    expect(pauses?.events).toHaveLength(3)
    expect(pauses?.rangeStartAt).toBe(3_000)
    expect(pauses?.rangeEndAt).toBe(7_000)
  })

  it('clusters dense alternating history while preserving milestones', () => {
    const events = [
      event(1, TaskHistoryEventKind.Added, TaskStatus.Queued),
      event(2, TaskHistoryEventKind.Started, TaskStatus.Downloading),
      ...Array.from({ length: 14 }, (_, index) =>
        index % 2 === 0
          ? event(index + 3, TaskHistoryEventKind.Paused, TaskStatus.Paused)
          : event(
              index + 3,
              TaskHistoryEventKind.Resumed,
              TaskStatus.Downloading
            )
      ),
      event(17, TaskHistoryEventKind.Failed, TaskStatus.Error),
    ]
    const model = buildActivityTimelineModel({
      events,
      task: makeDownloadTask({
        status: TaskStatus.Error,
        updatedAt: 17_000,
      }),
      availableWidth: 700,
    })

    expect(model.nodes.length).toBeLessThanOrEqual(7)
    expect(
      model.nodes.some((node) => node.kind === TaskHistoryEventKind.Added)
    ).toBe(true)
    expect(
      model.nodes.some((node) => node.kind === TaskHistoryEventKind.Started)
    ).toBe(true)
    expect(
      model.nodes.some(
        (node) =>
          node.kind === TaskHistoryEventKind.Failed && node.isCurrent === true
      )
    ).toBe(true)
    expect(model.nodes.some((node) => node.presentation === 'cluster')).toBe(
      true
    )
    expect(model.markerGroups.length).toBeLessThanOrEqual(8)
  })

  it.each([672, 700, 914])(
    'keeps truncation inside the seven-node budget at %ipx',
    (availableWidth) => {
      const events = [
        event(1, TaskHistoryEventKind.Added, TaskStatus.Queued),
        event(2, TaskHistoryEventKind.Started, TaskStatus.Downloading),
        ...Array.from({ length: 22 }, (_, index) =>
          event(
            index + 3,
            index % 2 === 0
              ? TaskHistoryEventKind.Paused
              : TaskHistoryEventKind.Resumed,
            index % 2 === 0 ? TaskStatus.Paused : TaskStatus.Downloading
          )
        ),
      ]

      const model = buildActivityTimelineModel({
        events,
        task: makeDownloadTask({
          id: 'task-1',
          status: TaskStatus.Downloading,
          updatedAt: 25_000,
        }),
        availableWidth,
        historyDroppedCount: 9,
        historyTruncatedAt: 500,
      })

      expect(model.nodes).toHaveLength(7)
      expect(model.nodes[0]).toMatchObject({
        presentation: 'truncated',
        count: 9,
      })
      expect(model.markerGroups.length).toBeLessThanOrEqual(8)
    }
  )

  it('groups recovered and stage events by destination status', () => {
    const model = buildActivityTimelineModel({
      events: [
        event(1, TaskHistoryEventKind.Added, TaskStatus.Queued),
        event(2, TaskHistoryEventKind.Started, TaskStatus.Downloading),
        event(3, TaskHistoryEventKind.StageChanged, TaskStatus.MetadataReady),
        event(4, TaskHistoryEventKind.StageChanged, TaskStatus.MetadataReady),
        event(5, TaskHistoryEventKind.StageChanged, TaskStatus.Seeding),
        event(6, TaskHistoryEventKind.StageChanged, TaskStatus.Seeding),
        event(7, TaskHistoryEventKind.ObservedState, TaskStatus.Paused),
        event(8, TaskHistoryEventKind.ObservedState, TaskStatus.Downloading),
      ],
      task: makeDownloadTask({
        id: 'task-1',
        status: TaskStatus.Downloading,
        updatedAt: 9_000,
      }),
      availableWidth: 914,
    })

    expect(
      model.nodes
        .filter((node) => node.kind === TaskHistoryEventKind.StageChanged)
        .map((node) => ({
          presentation: node.presentation,
          status: node.status,
          count: node.count,
        }))
    ).toEqual([
      {
        presentation: 'repeated',
        status: TaskStatus.MetadataReady,
        count: 2,
      },
      {
        presentation: 'repeated',
        status: TaskStatus.Seeding,
        count: 2,
      },
    ])
    expect(
      model.nodes
        .filter((node) => node.kind === TaskHistoryEventKind.ObservedState)
        .map((node) => ({ status: node.status, count: node.count }))
    ).toEqual([
      { status: TaskStatus.Paused, count: 1 },
      { status: TaskStatus.Downloading, count: 1 },
    ])
  })

  it('orders equal-timestamp events by ordinal and keeps terminal endpoints', () => {
    const sameTime = [
      event(2, TaskHistoryEventKind.Started, TaskStatus.Downloading, 1_000),
      event(1, TaskHistoryEventKind.Added, TaskStatus.Queued, 1_000),
      event(3, TaskHistoryEventKind.Completed, TaskStatus.Completed, 1_000),
    ]
    const model = buildActivityTimelineModel({
      events: sameTime,
      task: makeDownloadTask({
        status: TaskStatus.Completed,
        finishedAt: 1_000,
        updatedAt: 1_000,
      }),
      availableWidth: 700,
    })

    expect(model.nodes.flatMap((node) => node.events)).toEqual([
      sameTime[1],
      sameTime[0],
      sameTime[2],
    ])
    expect(model.nodes.at(-1)).toMatchObject({
      kind: TaskHistoryEventKind.Completed,
      status: TaskStatus.Completed,
      isCurrent: true,
    })
  })

  it('keeps clusters stable across a one-pixel resize', () => {
    const events = Array.from({ length: 20 }, (_, index) =>
      index === 0
        ? event(1, TaskHistoryEventKind.Added, TaskStatus.Queued)
        : event(
            index + 1,
            index % 2 === 0
              ? TaskHistoryEventKind.Paused
              : TaskHistoryEventKind.Resumed,
            index % 2 === 0 ? TaskStatus.Paused : TaskStatus.Downloading
          )
    )
    const input = {
      events,
      task: makeDownloadTask({
        status: TaskStatus.Downloading,
        updatedAt: 21_000,
      }),
    }

    const at640 = buildActivityTimelineModel({
      ...input,
      availableWidth: 640,
    })
    const at641 = buildActivityTimelineModel({
      ...input,
      availableWidth: 641,
    })

    expect(at640.nodes.map((node) => node.id)).toEqual(
      at641.nodes.map((node) => node.id)
    )
  })

  it('projects truncation and selected pause boundaries as protected nodes', () => {
    const paused = event(3, TaskHistoryEventKind.Paused, TaskStatus.Paused)
    const resumed = event(
      4,
      TaskHistoryEventKind.Resumed,
      TaskStatus.Downloading
    )
    const model = buildActivityTimelineModel({
      events: [
        event(1, TaskHistoryEventKind.Added, TaskStatus.Queued),
        event(2, TaskHistoryEventKind.Started, TaskStatus.Downloading),
        paused,
        resumed,
      ],
      task: makeDownloadTask({
        status: TaskStatus.Downloading,
        updatedAt: 5_000,
      }),
      availableWidth: 320,
      historyDroppedCount: 12,
      historyTruncatedAt: 500,
      selectedPauseInterval: { startAt: 3_000, endAt: 4_000 },
    })

    expect(model.nodes[0]).toMatchObject({
      presentation: 'truncated',
      count: 12,
      occurredAt: 500,
    })
    expect(model.nodes.flatMap((node) => node.events)).toEqual(
      expect.arrayContaining([paused, resumed])
    )
  })
})
