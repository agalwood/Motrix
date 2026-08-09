import { Events } from '@shared/protocol/events'
import { Queries } from '@shared/protocol/queries'
import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const transportMock = vi.hoisted(() => {
  const listeners = new Map<string, Set<(...args: unknown[]) => void>>()
  const connectionListeners = new Set<
    (event: { state: 'connecting' | 'connected' | 'disconnected' }) => void
  >()
  const invoke = vi.fn()
  const calls: string[] = []

  return {
    calls,
    connectionListeners,
    invoke,
    listeners,
    emit(channel: string, payload: unknown) {
      for (const listener of listeners.get(channel) ?? []) {
        listener(payload)
      }
    },
    connect(state: 'connecting' | 'connected' | 'disconnected') {
      for (const listener of connectionListeners) {
        listener({ state })
      }
    },
  }
})

vi.mock('@renderer/lib/transport', () => ({
  transport: {
    invoke: (...args: unknown[]) => {
      transportMock.calls.push('invoke')
      return transportMock.invoke(...args)
    },
    on: (channel: string, callback: (...args: unknown[]) => void) => {
      transportMock.calls.push('subscribe')
      const listeners =
        transportMock.listeners.get(channel) ??
        new Set<(...args: unknown[]) => void>()
      listeners.add(callback)
      transportMock.listeners.set(channel, listeners)
    },
    off: (channel: string, callback: (...args: unknown[]) => void) => {
      transportMock.listeners.get(channel)?.delete(callback)
    },
    onConnectionChange: (
      callback: (event: {
        state: 'connecting' | 'connected' | 'disconnected'
      }) => void
    ) => {
      transportMock.connectionListeners.add(callback)
      return () => transportMock.connectionListeners.delete(callback)
    },
    platform: 'web',
  },
}))

import {
  createTaskInspectorActivitySnapshotCache,
  useTaskInspectorActivity,
} from './use-task-inspector-activity'

function snapshot(taskId: string, revision: number) {
  return {
    taskId,
    revision,
    summary: {
      trackingStartedAt: 1,
      coverageGapAt: null,
      revision,
      lastEventOrdinal: 0,
      activeMs: 0,
      downloadActiveMs: 0,
      estimatedDownloadBytes: '0',
      estimatedUploadBytes: '0',
      peakDownloadBps: 0,
      peakUploadBps: 0,
      rawSampleCount: 0,
      historyDroppedCount: 0,
      historyTruncatedAt: null,
      updatedAt: revision,
    },
    timeline: {
      events: [],
      trackingStartedAt: 1,
      coverageGapAt: null,
      historyDroppedCount: 0,
      historyTruncatedAt: null,
    },
    lifetime: {
      points: [],
      averageDownloadSpeed: 0,
      peakDownloadSpeed: 0,
      peakUploadSpeed: 0,
      activeMs: 0,
      updatedAt: revision,
      accuracy: 'estimated',
    },
  }
}

describe('useTaskInspectorActivity', () => {
  beforeEach(() => {
    transportMock.calls.length = 0
    transportMock.connectionListeners.clear()
    transportMock.invoke.mockReset()
    transportMock.listeners.clear()
  })

  it('subscribes before hydration and exposes the ready snapshot', async () => {
    const ready = snapshot('task-1', 3)
    transportMock.invoke.mockResolvedValue(ready)

    const { result } = renderHook(() => useTaskInspectorActivity('task-1'))

    expect(transportMock.calls.slice(0, 2)).toEqual(['subscribe', 'invoke'])
    expect(transportMock.invoke).toHaveBeenCalledWith(
      Queries.GetTaskInspectorActivity,
      { taskId: 'task-1' }
    )
    await waitFor(() => expect(result.current.status).toBe('ready'))
    expect(result.current.snapshot).toEqual(ready)
  })

  it('coalesces revisions received during hydration into one trailing query', async () => {
    let resolveFirst: (value: unknown) => void = () => {}
    transportMock.invoke
      .mockReturnValueOnce(
        new Promise((resolve) => {
          resolveFirst = resolve
        })
      )
      .mockResolvedValueOnce(snapshot('task-1', 5))

    const { result } = renderHook(() => useTaskInspectorActivity('task-1'))

    act(() => {
      transportMock.emit(Events.TaskInspectorActivityUpdated, {
        taskId: 'task-1',
        revision: 4,
        reason: 'checkpoint',
      })
      transportMock.emit(Events.TaskInspectorActivityUpdated, {
        taskId: 'task-1',
        revision: 5,
        reason: 'checkpoint',
      })
      resolveFirst(snapshot('task-1', 3))
    })

    await waitFor(() => expect(result.current.snapshot?.revision).toBe(5))
    expect(transportMock.invoke).toHaveBeenCalledTimes(2)
  })

  it('refreshes for lifecycle hints and every connected transition', async () => {
    transportMock.invoke
      .mockResolvedValueOnce(snapshot('task-1', 1))
      .mockResolvedValueOnce(snapshot('task-1', 2))
      .mockResolvedValueOnce(snapshot('task-1', 2))

    const { result } = renderHook(() => useTaskInspectorActivity('task-1'))
    await waitFor(() => expect(result.current.snapshot?.revision).toBe(1))

    act(() => {
      transportMock.emit(Events.TaskInspectorActivityUpdated, {
        taskId: 'task-1',
        revision: 2,
        reason: 'transition',
      })
    })
    await waitFor(() => expect(result.current.snapshot?.revision).toBe(2))

    act(() => transportMock.connect('connected'))
    await waitFor(() => expect(transportMock.invoke).toHaveBeenCalledTimes(3))
  })

  it('preserves same-task data as stale and exposes a working retry', async () => {
    const ready = snapshot('task-1', 1)
    transportMock.invoke
      .mockResolvedValueOnce(ready)
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce(snapshot('task-1', 2))

    const { result } = renderHook(() => useTaskInspectorActivity('task-1'))
    await waitFor(() => expect(result.current.status).toBe('ready'))

    act(() => transportMock.connect('connected'))
    await waitFor(() => expect(result.current.status).toBe('stale'))
    expect(result.current.snapshot).toEqual(ready)

    act(() => {
      if (result.current.status === 'stale') result.current.retry()
    })
    await waitFor(() => expect(result.current.snapshot?.revision).toBe(2))
    expect(result.current.status).toBe('ready')
  })

  it('reports unavailable without prior data and retries', async () => {
    transportMock.invoke
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce(snapshot('task-1', 1))

    const { result } = renderHook(() => useTaskInspectorActivity('task-1'))
    await waitFor(() => expect(result.current.status).toBe('unavailable'))

    act(() => {
      if (result.current.status === 'unavailable') result.current.retry()
    })
    await waitFor(() => expect(result.current.status).toBe('ready'))
  })

  it.each([
    ['null', () => null],
    [
      'a missing nested summary',
      () => {
        const value = snapshot('poison-task', 1) as Record<string, unknown>
        delete value.summary
        return value
      },
    ],
    [
      'a null timeline element',
      () => ({
        ...snapshot('poison-task', 1),
        timeline: {
          ...snapshot('poison-task', 1).timeline,
          events: [null],
        },
      }),
    ],
    [
      'a NaN lifetime speed',
      () => ({
        ...snapshot('poison-task', 1),
        lifetime: {
          ...snapshot('poison-task', 1).lifetime,
          points: [{ t: 1, down: Number.NaN, up: 0, flags: 0 }],
        },
      }),
    ],
    [
      'more than 96 lifetime points',
      () => ({
        ...snapshot('poison-task', 1),
        lifetime: {
          ...snapshot('poison-task', 1).lifetime,
          points: Array.from({ length: 97 }, (_, index) => ({
            t: index + 1,
            down: 0,
            up: 0,
            flags: 0,
          })),
        },
      }),
    ],
  ])('rejects %s as unavailable', async (_label, makePoison) => {
    transportMock.invoke.mockResolvedValue(makePoison())

    const { result } = renderHook(() => useTaskInspectorActivity('poison-task'))

    await waitFor(() => expect(result.current.status).toBe('unavailable'))
    expect(result.current.snapshot).toBeNull()
  })

  it('does not invoke accessors while rejecting a poisoned snapshot', async () => {
    const getter = vi.fn(() => snapshot('poison-getter', 1).timeline)
    const value = snapshot('poison-getter', 1)
    Object.defineProperty(value, 'timeline', {
      configurable: true,
      enumerable: true,
      get: getter,
    })
    transportMock.invoke.mockResolvedValue(value)

    const { result } = renderHook(() =>
      useTaskInspectorActivity('poison-getter')
    )

    await waitFor(() => expect(result.current.status).toBe('unavailable'))
    expect(getter).not.toHaveBeenCalled()
  })

  it('preserves same-task last-good data across Activity remounts', async () => {
    const cache = createTaskInspectorActivitySnapshotCache()
    const ready = snapshot('remount-task', 1)
    transportMock.invoke.mockResolvedValueOnce(ready)

    const first = renderHook(() =>
      useTaskInspectorActivity('remount-task', cache)
    )
    await waitFor(() => expect(first.result.current.status).toBe('ready'))
    first.unmount()

    transportMock.invoke.mockRejectedValueOnce(new Error('offline'))
    const second = renderHook(() =>
      useTaskInspectorActivity('remount-task', cache)
    )
    await waitFor(() => expect(second.result.current.status).toBe('stale'))
    expect(second.result.current.snapshot).toEqual(ready)
  })

  it('never reuses task A last-good data for task B', async () => {
    const cache = createTaskInspectorActivitySnapshotCache()
    transportMock.invoke.mockResolvedValueOnce(snapshot('cache-task-a', 1))

    const first = renderHook(() =>
      useTaskInspectorActivity('cache-task-a', cache)
    )
    await waitFor(() => expect(first.result.current.status).toBe('ready'))
    first.unmount()

    transportMock.invoke.mockRejectedValueOnce(new Error('offline'))
    const second = renderHook(() =>
      useTaskInspectorActivity('cache-task-b', cache)
    )
    await waitFor(() =>
      expect(second.result.current.status).toBe('unavailable')
    )
    expect(second.result.current.snapshot).toBeNull()
  })

  it('ignores an old task promise and detaches listeners on task change', async () => {
    let resolveOld: (value: unknown) => void = () => {}
    transportMock.invoke
      .mockReturnValueOnce(
        new Promise((resolve) => {
          resolveOld = resolve
        })
      )
      .mockResolvedValueOnce(snapshot('task-2', 2))

    const { result, rerender, unmount } = renderHook(
      ({ taskId }) => useTaskInspectorActivity(taskId),
      { initialProps: { taskId: 'task-1' } }
    )

    rerender({ taskId: 'task-2' })
    act(() => resolveOld(snapshot('task-1', 99)))

    await waitFor(() => expect(result.current.snapshot?.taskId).toBe('task-2'))
    expect(result.current.snapshot?.revision).toBe(2)
    expect(
      transportMock.listeners.get(Events.TaskInspectorActivityUpdated)
    )?.toHaveProperty('size', 1)

    unmount()
    expect(
      transportMock.listeners.get(Events.TaskInspectorActivityUpdated)
    )?.toHaveProperty('size', 0)
    expect(transportMock.connectionListeners).toHaveProperty('size', 0)
  })
})
