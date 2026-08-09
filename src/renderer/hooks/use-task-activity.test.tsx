import { Events } from '@shared/protocol/events'
import { Queries } from '@shared/protocol/queries'
import type {
  GetTaskActivityParams,
  TaskActivitySnapshot,
  TaskActivityUpdatedPayload,
} from '@shared/types/task-activity'
import { act, renderHook, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { createElement, StrictMode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  __resetTaskActivityStoreForTests,
  buildTaskActivityRange,
  taskActivityRangeSignature,
  useTaskActivity,
} from './use-task-activity'

type EventListener = (...args: unknown[]) => void
type ConnectionListener = (event: {
  state: 'connecting' | 'connected' | 'disconnected'
  reconnected: boolean
}) => void

const eventListeners = new Map<string, Set<EventListener>>()
const connectionListeners = new Set<ConnectionListener>()
const ORIGINAL_TIME_ZONE = process.env.TZ

const transportMock = vi.hoisted(() => ({
  invoke: vi.fn(),
  on: vi.fn((channel: string, listener: EventListener) => {
    const set = eventListeners.get(channel) ?? new Set()
    set.add(listener)
    eventListeners.set(channel, set)
  }),
  off: vi.fn((channel: string, listener: EventListener) => {
    eventListeners.get(channel)?.delete(listener)
  }),
  onConnectionChange: vi.fn((listener: ConnectionListener) => {
    connectionListeners.add(listener)
    return () => connectionListeners.delete(listener)
  }),
  platform: 'web' as const,
}))

vi.mock('@renderer/lib/transport', () => ({
  transport: transportMock,
}))

interface Deferred<T> {
  promise: Promise<T>
  resolve(value: T): void
  reject(reason?: unknown): void
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

function paramsForCall(index: number): GetTaskActivityParams {
  return transportMock.invoke.mock.calls[index]?.[1] as GetTaskActivityParams
}

function makeSnapshot(
  generation: string,
  revision: number,
  params: GetTaskActivityParams,
  overrides: {
    submitted?: number
    completed?: number
    recovered?: number
  } = {}
): TaskActivitySnapshot {
  return {
    generation,
    revision,
    coverage: {
      trackingStartedAt: params.days[0]?.fromMs ?? Date.now(),
      coverageGapAt: null,
    },
    days: params.days.map((day) => ({
      dateKey: day.dateKey,
      submitted: overrides.submitted ?? 0,
      downloadCompleted: overrides.completed ?? 0,
      recoveredDownloadCompleted: overrides.recovered ?? 0,
    })),
  }
}

function inserted(
  generation: string,
  revision: number,
  occurredAt: number,
  kind: 'submitted' | 'download_completed' = 'download_completed',
  accuracy: 'exact' | 'recovered' = 'exact'
): TaskActivityUpdatedPayload {
  return {
    type: 'inserted',
    generation,
    revision,
    event: { kind, occurredAt, accuracy },
  } as TaskActivityUpdatedPayload
}

function emitActivity(payload: TaskActivityUpdatedPayload): void {
  for (const listener of eventListeners.get(Events.TaskActivityUpdated) ?? []) {
    listener(payload)
  }
}

function emitConnection(reconnected = true): void {
  for (const listener of connectionListeners) {
    listener({ state: 'connected', reconnected })
  }
}

beforeEach(() => {
  __resetTaskActivityStoreForTests()
  eventListeners.clear()
  connectionListeners.clear()
  transportMock.invoke.mockReset()
  transportMock.on.mockClear()
  transportMock.off.mockClear()
  transportMock.onConnectionChange.mockClear()
})

afterEach(() => {
  if (ORIGINAL_TIME_ZONE === undefined) {
    delete process.env.TZ
  } else {
    process.env.TZ = ORIGINAL_TIME_ZONE
  }
  __resetTaskActivityStoreForTests()
  vi.clearAllMocks()
  vi.restoreAllMocks()
  vi.useRealTimers()
})

describe('buildTaskActivityRange', () => {
  it('builds 53 contiguous Sunday-aligned local weeks', () => {
    const range = buildTaskActivityRange(new Date(2026, 6, 27, 15))
    expect(range.days).toHaveLength(371)
    expect(new Date(range.days[0]?.fromMs ?? 0).getDay()).toBe(0)
    for (let index = 1; index < range.days.length; index += 1) {
      expect(range.days[index]?.fromMs).toBe(range.days[index - 1]?.toMs)
    }
  })

  it('fingerprints every local boundary across equal-offset DST zones', () => {
    process.env.TZ = 'America/Los_Angeles'
    const losAngeles = buildTaskActivityRange(
      new Date('2026-07-27T12:00:00.000Z')
    )
    process.env.TZ = 'America/Phoenix'
    const phoenix = buildTaskActivityRange(new Date('2026-07-27T12:00:00.000Z'))

    expect(losAngeles.days[0]?.fromMs).toBe(phoenix.days[0]?.fromMs)
    expect(losAngeles.days.at(-1)?.toMs).toBe(phoenix.days.at(-1)?.toMs)
    expect(
      losAngeles.days.filter(
        (day, index) =>
          day.fromMs !== phoenix.days[index]?.fromMs ||
          day.toMs !== phoenix.days[index]?.toMs
      ).length
    ).toBeGreaterThan(0)
    expect(taskActivityRangeSignature(losAngeles)).not.toBe(
      taskActivityRangeSignature(phoenix)
    )
  })
})

describe('useTaskActivity external store', () => {
  it('subscribes before one shared hydration for multiple consumers', async () => {
    transportMock.invoke.mockImplementation(
      async (_query, params: GetTaskActivityParams) =>
        makeSnapshot('generation-a', 0, params)
    )

    const first = renderHook(() => useTaskActivity())
    const second = renderHook(() => useTaskActivity())

    await waitFor(() => expect(first.result.current.status).toBe('ready'))
    expect(transportMock.on).toHaveBeenCalledBefore(transportMock.invoke)
    expect(transportMock.invoke).toHaveBeenCalledTimes(1)
    expect(transportMock.invoke).toHaveBeenCalledWith(
      Queries.GetTaskActivity,
      expect.objectContaining({ days: expect.any(Array) })
    )
    expect(eventListeners.get(Events.TaskActivityUpdated)).toHaveLength(1)
    expect(first.result.current).toBe(second.result.current)
  })

  it('survives a Strict Mode transient unsubscribe without rehydrating', async () => {
    transportMock.invoke.mockImplementation(
      async (_query, params: GetTaskActivityParams) =>
        makeSnapshot('generation-a', 0, params)
    )
    const wrapper = ({ children }: { children: ReactNode }) =>
      createElement(StrictMode, null, children)

    const hook = renderHook(() => useTaskActivity(), { wrapper })
    await waitFor(() => expect(hook.result.current.status).toBe('ready'))
    expect(transportMock.invoke).toHaveBeenCalledTimes(1)
    expect(transportMock.on).toHaveBeenCalledTimes(1)
    expect(transportMock.off).not.toHaveBeenCalled()
  })

  it('queues hydration events and drains contiguous revisions', async () => {
    const hydration = deferred<TaskActivitySnapshot>()
    transportMock.invoke.mockReturnValue(hydration.promise)
    const hook = renderHook(() => useTaskActivity())
    const params = paramsForCall(0)
    const occurredAt = (params.days[0]?.fromMs ?? 0) + 1

    act(() => emitActivity(inserted('generation-a', 1, occurredAt)))
    await act(async () => {
      hydration.resolve(makeSnapshot('generation-a', 0, params))
      await hydration.promise
    })

    expect(hook.result.current.status).toBe('ready')
    if (hook.result.current.status !== 'ready') return
    expect(hook.result.current.snapshot.revision).toBe(1)
    expect(hook.result.current.snapshot.days[0]?.downloadCompleted).toBe(1)
    expect(transportMock.invoke).toHaveBeenCalledTimes(1)
  })

  it('drains a contiguous queued event when a cached refresh fails', async () => {
    const refresh = deferred<TaskActivitySnapshot>()
    transportMock.invoke
      .mockImplementationOnce(async (_query, params: GetTaskActivityParams) =>
        makeSnapshot('generation-a', 0, params)
      )
      .mockReturnValueOnce(refresh.promise)
    const hook = renderHook(() => useTaskActivity())
    await waitFor(() => expect(hook.result.current.status).toBe('ready'))

    act(() => window.dispatchEvent(new Event('focus')))
    const params = paramsForCall(1)
    act(() =>
      emitActivity(
        inserted('generation-a', 1, (params.days[0]?.fromMs ?? 0) + 1)
      )
    )
    await act(async () => {
      refresh.reject(new Error('offline'))
      await refresh.promise.catch(() => undefined)
    })

    expect(hook.result.current.status).toBe('ready')
    if (hook.result.current.status !== 'ready') return
    expect(hook.result.current.snapshot.revision).toBe(1)
    expect(hook.result.current.snapshot.days[0]?.downloadCompleted).toBe(1)
    expect(transportMock.invoke).toHaveBeenCalledTimes(2)
  })

  it('does not patch a snapshot that belongs to the previous week range', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(2026, 7, 1, 23, 59, 59, 900))
    __resetTaskActivityStoreForTests()
    const reconciliation = deferred<TaskActivitySnapshot>()
    transportMock.invoke
      .mockImplementationOnce(async (_query, params: GetTaskActivityParams) =>
        makeSnapshot('generation-a', 1, params)
      )
      .mockRejectedValueOnce(new Error('midnight refresh failed'))
      .mockReturnValueOnce(reconciliation.promise)
    const hook = renderHook(() => useTaskActivity())
    await act(async () => {
      await Promise.resolve()
    })
    expect(hook.result.current.status).toBe('ready')
    const oldSnapshot =
      hook.result.current.status === 'ready'
        ? hook.result.current.snapshot
        : undefined

    await act(async () => {
      vi.advanceTimersByTime(100)
      await Promise.resolve()
    })
    expect(hook.result.current.status).toBe('stale')
    const sundayRange = paramsForCall(1)
    const currentSunday = sundayRange.days.at(-7)
    expect(currentSunday).toBeDefined()

    act(() =>
      emitActivity(
        inserted('generation-a', 2, (currentSunday?.fromMs ?? 0) + 1)
      )
    )

    expect(transportMock.invoke).toHaveBeenCalledTimes(3)
    expect(hook.result.current.status).toBe('stale')
    if (hook.result.current.status !== 'stale') return
    expect(hook.result.current.snapshot).toBe(oldSnapshot)
    expect(hook.result.current.snapshot.revision).toBe(1)
    expect(
      hook.result.current.snapshot.days.every(
        (day) => day.downloadCompleted === 0
      )
    ).toBe(true)
  })

  it('publishes a fresh stale state when a same-week midnight refresh fails', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(2026, 7, 3, 23, 59, 59, 900))
    __resetTaskActivityStoreForTests()
    transportMock.invoke
      .mockImplementationOnce(async (_query, params: GetTaskActivityParams) =>
        makeSnapshot('generation-a', 0, params)
      )
      .mockRejectedValueOnce(new Error('already stale'))
      .mockRejectedValueOnce(new Error('midnight refresh failed'))
    const hook = renderHook(() => useTaskActivity())
    await act(async () => {
      await Promise.resolve()
    })

    act(() => window.dispatchEvent(new Event('focus')))
    await act(async () => {
      await Promise.resolve()
    })
    expect(hook.result.current.status).toBe('stale')
    const beforeMidnight = hook.result.current

    await act(async () => {
      vi.advanceTimersByTime(100)
      await Promise.resolve()
    })

    expect(transportMock.invoke).toHaveBeenCalledTimes(3)
    expect(hook.result.current.status).toBe('stale')
    expect(hook.result.current).not.toBe(beforeMidnight)
  })

  it('deduplicates repeated retries against the same pending range', async () => {
    const refresh = deferred<TaskActivitySnapshot>()
    transportMock.invoke
      .mockImplementationOnce(async (_query, params: GetTaskActivityParams) =>
        makeSnapshot('generation-a', 0, params)
      )
      .mockReturnValueOnce(refresh.promise)
      .mockImplementationOnce(async (_query, params: GetTaskActivityParams) =>
        makeSnapshot('generation-a', 1, params)
      )
    const hook = renderHook(() => useTaskActivity())
    await waitFor(() => expect(hook.result.current.status).toBe('ready'))

    let firstRetry!: Promise<void>
    let secondRetry!: Promise<void>
    act(() => {
      firstRetry = hook.result.current.retry()
      secondRetry = hook.result.current.retry()
    })
    expect(secondRetry).toBe(firstRetry)
    expect(transportMock.invoke).toHaveBeenCalledTimes(2)

    await act(async () => {
      refresh.resolve(makeSnapshot('generation-a', 0, paramsForCall(1)))
      await refresh.promise
      await Promise.resolve()
    })
    expect(transportMock.invoke).toHaveBeenCalledTimes(2)
  })

  it('distinguishes initial unavailable from cached stale and retries', async () => {
    transportMock.invoke
      .mockRejectedValueOnce(new Error('offline'))
      .mockImplementationOnce(async (_query, params: GetTaskActivityParams) =>
        makeSnapshot('generation-a', 0, params)
      )
      .mockRejectedValueOnce(new Error('offline again'))
    const hook = renderHook(() => useTaskActivity())

    await waitFor(() => expect(hook.result.current.status).toBe('unavailable'))
    const retry = hook.result.current.retry
    await act(async () => {
      await retry()
    })
    expect(hook.result.current.status).toBe('ready')
    expect(hook.result.current.retry).toBe(retry)
    const readySnapshot =
      hook.result.current.status === 'ready'
        ? hook.result.current.snapshot
        : undefined

    act(() => window.dispatchEvent(new Event('focus')))
    await waitFor(() => expect(hook.result.current.status).toBe('stale'))
    if (hook.result.current.status !== 'stale') return
    expect(hook.result.current.snapshot).toBe(readySnapshot)
    expect(hook.result.current.retry).toBe(retry)
  })

  it('keeps stable state references for duplicate revisions', async () => {
    transportMock.invoke.mockImplementation(
      async (_query, params: GetTaskActivityParams) =>
        makeSnapshot('generation-a', 1, params, { completed: 1 })
    )
    const hook = renderHook(() => useTaskActivity())
    await waitFor(() => expect(hook.result.current.status).toBe('ready'))
    const readyState = hook.result.current
    const params = paramsForCall(0)

    act(() =>
      emitActivity(
        inserted('generation-a', 1, (params.days[0]?.fromMs ?? 0) + 1)
      )
    )
    expect(hook.result.current).toBe(readyState)
    expect(transportMock.invoke).toHaveBeenCalledTimes(1)
  })

  it('does not regress on a same-generation lower snapshot', async () => {
    const refresh = deferred<TaskActivitySnapshot>()
    transportMock.invoke
      .mockImplementationOnce(async (_query, params: GetTaskActivityParams) =>
        makeSnapshot('generation-a', 5, params)
      )
      .mockReturnValueOnce(refresh.promise)
      .mockImplementationOnce(async (_query, params: GetTaskActivityParams) =>
        makeSnapshot('generation-a', 6, params, { completed: 1 })
      )
    const hook = renderHook(() => useTaskActivity())
    await waitFor(() => {
      expect(hook.result.current.status).toBe('ready')
    })

    act(() => window.dispatchEvent(new Event('focus')))
    const params = paramsForCall(1)
    act(() =>
      emitActivity(
        inserted('generation-a', 6, (params.days[0]?.fromMs ?? 0) + 1)
      )
    )
    await act(async () => {
      refresh.resolve(makeSnapshot('generation-a', 4, params))
      await refresh.promise
    })

    await waitFor(() => expect(transportMock.invoke).toHaveBeenCalledTimes(3))
    await waitFor(() => {
      expect(hook.result.current.status).toBe('ready')
      if (hook.result.current.status === 'ready') {
        expect(hook.result.current.snapshot.revision).toBe(6)
      }
    })
  })

  it('converges old rev100 to new generation rev1 with an interleaved event', async () => {
    const replacement = deferred<TaskActivitySnapshot>()
    transportMock.invoke
      .mockImplementationOnce(async (_query, params: GetTaskActivityParams) =>
        makeSnapshot('old-generation', 100, params)
      )
      .mockReturnValueOnce(replacement.promise)
    const hook = renderHook(() => useTaskActivity())
    await waitFor(() => expect(hook.result.current.status).toBe('ready'))

    act(() => emitConnection())
    const params = paramsForCall(1)
    act(() =>
      emitActivity(
        inserted('new-generation', 1, (params.days[0]?.fromMs ?? 0) + 1)
      )
    )
    await act(async () => {
      replacement.resolve(makeSnapshot('new-generation', 0, params))
      await replacement.promise
    })

    expect(hook.result.current.status).toBe('ready')
    if (hook.result.current.status !== 'ready') return
    expect(hook.result.current.snapshot.generation).toBe('new-generation')
    expect(hook.result.current.snapshot.revision).toBe(1)
    expect(hook.result.current.snapshot.days[0]?.downloadCompleted).toBe(1)
  })

  it('ignores an old-lifecycle response that resolves after a new generation', async () => {
    const oldHydration = deferred<TaskActivitySnapshot>()
    transportMock.invoke
      .mockReturnValueOnce(oldHydration.promise)
      .mockImplementationOnce(async (_query, params: GetTaskActivityParams) =>
        makeSnapshot('new-generation', 0, params)
      )

    const oldHook = renderHook(() => useTaskActivity())
    const oldParams = paramsForCall(0)
    oldHook.unmount()
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })

    const newHook = renderHook(() => useTaskActivity())
    await waitFor(() => expect(newHook.result.current.status).toBe('ready'))
    await act(async () => {
      oldHydration.resolve(makeSnapshot('old-generation', 100, oldParams))
      await oldHydration.promise
    })

    expect(newHook.result.current.status).toBe('ready')
    if (newHook.result.current.status !== 'ready') return
    expect(newHook.result.current.snapshot.generation).toBe('new-generation')
    expect(newHook.result.current.snapshot.revision).toBe(0)
  })

  it('refetches instead of numerically discarding a direct cross-generation event', async () => {
    transportMock.invoke
      .mockImplementationOnce(async (_query, params: GetTaskActivityParams) =>
        makeSnapshot('old-generation', 100, params)
      )
      .mockImplementationOnce(async (_query, params: GetTaskActivityParams) =>
        makeSnapshot('new-generation', 1, params, { completed: 1 })
      )
    const hook = renderHook(() => useTaskActivity())
    await waitFor(() => expect(hook.result.current.status).toBe('ready'))
    const params = paramsForCall(0)

    act(() =>
      emitActivity(
        inserted('new-generation', 1, (params.days[0]?.fromMs ?? 0) + 1)
      )
    )

    await waitFor(() => {
      expect(transportMock.invoke).toHaveBeenCalledTimes(2)
      expect(hook.result.current.status).toBe('ready')
      if (hook.result.current.status === 'ready') {
        expect(hook.result.current.snapshot.generation).toBe('new-generation')
      }
    })
  })

  it('turns queue overflow into exactly one trailing authoritative snapshot', async () => {
    const refresh = deferred<TaskActivitySnapshot>()
    transportMock.invoke
      .mockImplementationOnce(async (_query, params: GetTaskActivityParams) =>
        makeSnapshot('generation-a', 0, params)
      )
      .mockReturnValueOnce(refresh.promise)
      .mockImplementationOnce(async (_query, params: GetTaskActivityParams) =>
        makeSnapshot('generation-a', 129, params, { completed: 129 })
      )
    const hook = renderHook(() => useTaskActivity())
    await waitFor(() => expect(hook.result.current.status).toBe('ready'))

    act(() => window.dispatchEvent(new Event('focus')))
    const params = paramsForCall(1)
    act(() => {
      for (let revision = 1; revision <= 129; revision += 1) {
        emitActivity(
          inserted('generation-a', revision, (params.days[0]?.fromMs ?? 0) + 1)
        )
      }
    })
    await act(async () => {
      refresh.resolve(makeSnapshot('generation-a', 0, params))
      await refresh.promise
    })

    await waitFor(() => expect(transportMock.invoke).toHaveBeenCalledTimes(3))
    await waitFor(() => {
      expect(hook.result.current.status).toBe('ready')
      if (hook.result.current.status === 'ready') {
        expect(hook.result.current.snapshot.revision).toBe(129)
      }
    })
    expect(transportMock.invoke).toHaveBeenCalledTimes(3)
  })

  it('forces same-range snapshots on foreground, online, and reconnect', async () => {
    transportMock.invoke.mockImplementation(
      async (_query, params: GetTaskActivityParams) =>
        makeSnapshot(
          'generation-a',
          transportMock.invoke.mock.calls.length - 1,
          params
        )
    )
    const hook = renderHook(() => useTaskActivity())
    await waitFor(() => expect(hook.result.current.status).toBe('ready'))

    act(() => window.dispatchEvent(new Event('focus')))
    await waitFor(() => expect(transportMock.invoke).toHaveBeenCalledTimes(2))
    act(() => window.dispatchEvent(new Event('online')))
    await waitFor(() => expect(transportMock.invoke).toHaveBeenCalledTimes(3))
    act(() => emitConnection())
    await waitFor(() => expect(transportMock.invoke).toHaveBeenCalledTimes(4))
  })

  it('refetches changed DST boundaries after an equal-offset timezone switch', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-07-27T12:00:00.000Z'))
    process.env.TZ = 'America/Los_Angeles'
    __resetTaskActivityStoreForTests()
    transportMock.invoke.mockImplementation(
      async (_query, params: GetTaskActivityParams) =>
        makeSnapshot(
          'generation-a',
          transportMock.invoke.mock.calls.length - 1,
          params
        )
    )
    const hook = renderHook(() => useTaskActivity())
    await act(async () => {
      await Promise.resolve()
    })
    expect(hook.result.current.status).toBe('ready')
    const losAngeles = paramsForCall(0)

    process.env.TZ = 'America/Phoenix'
    act(() => window.dispatchEvent(new Event('focus')))
    await act(async () => {
      await Promise.resolve()
    })

    expect(transportMock.invoke).toHaveBeenCalledTimes(2)
    const phoenix = paramsForCall(1)
    expect(losAngeles.days[0]?.fromMs).toBe(phoenix.days[0]?.fromMs)
    expect(losAngeles.days.at(-1)?.toMs).toBe(phoenix.days.at(-1)?.toMs)
    expect(
      losAngeles.days.some(
        (day, index) =>
          day.fromMs !== phoenix.days[index]?.fromMs ||
          day.toMs !== phoenix.days[index]?.toMs
      )
    ).toBe(true)
  })

  it('reconciles events missed before the initial WebSocket connection opens', async () => {
    transportMock.invoke.mockImplementation(
      async (_query, params: GetTaskActivityParams) => {
        const revision = transportMock.invoke.mock.calls.length - 1
        return makeSnapshot('generation-a', revision, params, {
          completed: revision,
        })
      }
    )
    const hook = renderHook(() => useTaskActivity())
    await waitFor(() => expect(hook.result.current.status).toBe('ready'))
    expect(transportMock.invoke).toHaveBeenCalledTimes(1)

    act(() => emitConnection(false))

    await waitFor(() => expect(transportMock.invoke).toHaveBeenCalledTimes(2))
    await waitFor(() => {
      expect(hook.result.current.status).toBe('ready')
      if (hook.result.current.status === 'ready') {
        expect(hook.result.current.snapshot.revision).toBe(1)
        expect(hook.result.current.snapshot.days[0]?.downloadCompleted).toBe(1)
      }
    })
  })

  it('forces a snapshot only when visibility returns to visible', async () => {
    let visibility: DocumentVisibilityState = 'hidden'
    vi.spyOn(document, 'visibilityState', 'get').mockImplementation(
      () => visibility
    )
    transportMock.invoke.mockImplementation(
      async (_query, params: GetTaskActivityParams) =>
        makeSnapshot(
          'generation-a',
          transportMock.invoke.mock.calls.length - 1,
          params
        )
    )
    const hook = renderHook(() => useTaskActivity())
    await waitFor(() => expect(hook.result.current.status).toBe('ready'))

    act(() => document.dispatchEvent(new Event('visibilitychange')))
    expect(transportMock.invoke).toHaveBeenCalledTimes(1)
    visibility = 'visible'
    act(() => document.dispatchEvent(new Event('visibilitychange')))
    await waitFor(() => expect(transportMock.invoke).toHaveBeenCalledTimes(2))
  })

  it('rolls the range with one next-local-midnight timeout', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(2026, 6, 27, 23, 59, 59, 900))
    __resetTaskActivityStoreForTests()
    transportMock.invoke.mockImplementation(
      async (_query, params: GetTaskActivityParams) =>
        makeSnapshot(
          'generation-a',
          transportMock.invoke.mock.calls.length - 1,
          params
        )
    )
    const hook = renderHook(() => useTaskActivity())
    await act(async () => {
      await Promise.resolve()
    })
    expect(hook.result.current.status).toBe('ready')
    expect(transportMock.invoke).toHaveBeenCalledTimes(1)

    await act(async () => {
      vi.advanceTimersByTime(100)
      await Promise.resolve()
    })
    expect(transportMock.invoke).toHaveBeenCalledTimes(2)
    expect(paramsForCall(1).days).toHaveLength(371)

    await act(async () => {
      vi.advanceTimersByTime(1_000)
      await Promise.resolve()
    })
    expect(transportMock.invoke).toHaveBeenCalledTimes(2)
  })

  it('detaches timers and listeners after the final real unsubscribe', async () => {
    vi.useFakeTimers()
    transportMock.invoke.mockImplementation(
      async (_query, params: GetTaskActivityParams) =>
        makeSnapshot('generation-a', 0, params)
    )
    const hook = renderHook(() => useTaskActivity())
    await act(async () => {
      await Promise.resolve()
    })
    hook.unmount()
    await act(async () => {
      vi.runOnlyPendingTimers()
      await Promise.resolve()
    })

    expect(transportMock.off).toHaveBeenCalledWith(
      Events.TaskActivityUpdated,
      expect.any(Function)
    )
    expect(connectionListeners).toHaveLength(0)
    const calls = transportMock.invoke.mock.calls.length
    act(() => window.dispatchEvent(new Event('focus')))
    expect(transportMock.invoke).toHaveBeenCalledTimes(calls)
  })
})
