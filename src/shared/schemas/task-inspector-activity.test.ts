import { TaskStatus } from '@shared/types/task'
import {
  TaskHistoryAccuracy,
  TaskHistoryEventKind,
  type TaskInspectorActivitySnapshot,
} from '@shared/types/task-inspector-activity'
import { describe, expect, it, vi } from 'vitest'
import {
  findTaskSpeedUpdate,
  parseTaskInspectorActivitySnapshot,
  parseTaskSpeedHistory,
  TASK_INSPECTOR_ACTIVITY_MAX_EVENTS,
  TASK_INSPECTOR_ACTIVITY_MAX_LIFETIME_POINTS,
} from './task-inspector-activity'

function snapshot(): TaskInspectorActivitySnapshot {
  return {
    taskId: 'task-1',
    revision: 1,
    summary: {
      trackingStartedAt: 1,
      coverageGapAt: null,
      revision: 1,
      lastEventOrdinal: 1,
      activeMs: 1,
      downloadActiveMs: 1,
      estimatedDownloadBytes: '1',
      estimatedUploadBytes: '0',
      peakDownloadBps: 1,
      peakUploadBps: 0,
      rawSampleCount: 1,
      historyDroppedCount: 0,
      historyTruncatedAt: null,
      updatedAt: 2,
    },
    timeline: {
      events: [
        {
          eventOrdinal: 1,
          eventKey: 'event-1',
          kind: TaskHistoryEventKind.Started,
          fromStatus: TaskStatus.Queued,
          toStatus: TaskStatus.Downloading,
          occurredAt: 1,
          accuracy: TaskHistoryAccuracy.Exact,
          errorCode: null,
          errorMessage: null,
          errorDetailKey: null,
          errorDetailParams: null,
        },
      ],
      trackingStartedAt: 1,
      coverageGapAt: null,
      historyDroppedCount: 0,
      historyTruncatedAt: null,
    },
    lifetime: {
      points: [{ t: 1, down: 1, up: 0, flags: 0 }],
      averageDownloadSpeed: 1,
      peakDownloadSpeed: 1,
      peakUploadSpeed: 0,
      activeMs: 1,
      updatedAt: 2,
      accuracy: 'estimated',
    },
  }
}

describe('task inspector activity wire validation', () => {
  it('returns a detached full snapshot only for the expected task', () => {
    const value = snapshot()
    const parsed = parseTaskInspectorActivitySnapshot(value, 'task-1')

    expect(parsed).toEqual(value)
    expect(parsed).not.toBe(value)
    expect(parseTaskInspectorActivitySnapshot(value, 'other')).toBeNull()
  })

  it('rejects circular and non-JSON nested values without throwing', () => {
    const circular = snapshot() as TaskInspectorActivitySnapshot & {
      cycle?: unknown
    }
    circular.cycle = circular

    for (const value of [
      circular,
      {
        ...snapshot(),
        summary: {
          ...snapshot().summary,
          estimatedDownloadBytes: 1n,
        },
      },
      {
        ...snapshot(),
        lifetime: {
          ...snapshot().lifetime,
          accuracy: undefined,
        },
      },
      {
        ...snapshot(),
        lifetime: {
          ...snapshot().lifetime,
          accuracy: () => 'estimated',
        },
      },
      {
        ...snapshot(),
        lifetime: {
          ...snapshot().lifetime,
          accuracy: Symbol('estimated'),
        },
      },
    ]) {
      expect(() => parseTaskInspectorActivitySnapshot(value)).not.toThrow()
      expect(parseTaskInspectorActivitySnapshot(value)).toBeNull()
    }
  })

  it('accepts a history event with no error-detail fields and normalizes them to null', () => {
    // Old↔new wire tolerance: a snapshot from a build that predates the
    // error-detail fields must still parse, degrading the two keys to null
    // instead of failing the whole timeline.
    const value = snapshot()
    const [event] = value.timeline.events
    const legacyEvent: Record<string, unknown> = { ...event }
    delete legacyEvent.errorDetailKey
    delete legacyEvent.errorDetailParams
    const legacy = {
      ...value,
      timeline: { ...value.timeline, events: [legacyEvent] },
    }

    const parsed = parseTaskInspectorActivitySnapshot(legacy, 'task-1')

    expect(parsed?.timeline.events[0]).toMatchObject({
      eventKey: 'event-1',
      errorDetailKey: null,
      errorDetailParams: null,
    })
  })

  it('enforces the durable event and point caps', () => {
    const baseEvent = snapshot().timeline.events[0]
    expect(baseEvent).toBeDefined()
    if (!baseEvent) return

    expect(
      parseTaskInspectorActivitySnapshot({
        ...snapshot(),
        timeline: {
          ...snapshot().timeline,
          events: Array.from(
            { length: TASK_INSPECTOR_ACTIVITY_MAX_EVENTS + 1 },
            (_, index) => ({
              ...baseEvent,
              eventOrdinal: index + 1,
              eventKey: `event-${index + 1}`,
            })
          ),
        },
      })
    ).toBeNull()
    expect(
      parseTaskInspectorActivitySnapshot({
        ...snapshot(),
        lifetime: {
          ...snapshot().lifetime,
          points: Array.from(
            { length: TASK_INSPECTOR_ACTIVITY_MAX_LIFETIME_POINTS + 1 },
            (_, index) => ({
              t: index + 1,
              down: 0,
              up: 0,
              flags: 0,
            })
          ),
        },
      })
    ).toBeNull()
  })

  it('validates complete speed rows and reads TaskUpdated own data only', () => {
    expect(parseTaskSpeedHistory([{ t: 0, down: 1, up: 0 }])).toEqual([
      { t: 0, down: 1, up: 0 },
    ])
    expect(
      parseTaskSpeedHistory([{ t: 0, down: Number.NaN, up: 0 }])
    ).toBeNull()

    const getter = vi.fn(() => 'task-1')
    const poison = {
      status: TaskStatus.Downloading,
      downloadSpeed: 1,
      uploadSpeed: 0,
    }
    Object.defineProperty(poison, 'id', { enumerable: true, get: getter })
    const update = {
      id: 'task-1',
      status: TaskStatus.Downloading,
      downloadSpeed: 2,
      uploadSpeed: 1,
    }

    expect(findTaskSpeedUpdate([null, poison, update], 'task-1')).toEqual(
      update
    )
    expect(getter).not.toHaveBeenCalled()
  })

  it('walks actual sparse TaskUpdated indexes and fails closed for proxies', () => {
    const other = {
      id: 'other',
      status: TaskStatus.Downloading,
      downloadSpeed: 1,
      uploadSpeed: 0,
    }
    const target = {
      ...other,
      id: 'task-1',
      downloadSpeed: 2,
    }
    const sparse: unknown[] = []
    sparse.length = 0xffff_ffff
    sparse[0] = other
    sparse[0xffff_fffe] = target

    expect(findTaskSpeedUpdate(sparse, 'task-1')).toEqual(target)
    delete sparse[0xffff_fffe]
    expect(findTaskSpeedUpdate(sparse, 'task-1')).toBeNull()

    const topLevel = Proxy.revocable([], {})
    const element = Proxy.revocable({}, {})
    topLevel.revoke()
    element.revoke()
    expect(() => findTaskSpeedUpdate(topLevel.proxy, 'task-1')).not.toThrow()
    expect(findTaskSpeedUpdate(topLevel.proxy, 'task-1')).toBeNull()
    expect(() => findTaskSpeedUpdate([element.proxy], 'task-1')).not.toThrow()
    expect(findTaskSpeedUpdate([element.proxy], 'task-1')).toBeNull()
  })

  it('rejects lifetime metadata that disagrees with the summary', () => {
    expect(
      parseTaskInspectorActivitySnapshot({
        ...snapshot(),
        lifetime: {
          ...snapshot().lifetime,
          peakDownloadSpeed: 2,
        },
      })
    ).toBeNull()
  })
})
