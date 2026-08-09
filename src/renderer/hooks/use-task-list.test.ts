import { Events } from '@shared/protocol/events'
import { Queries } from '@shared/protocol/queries'
import type { DownloadTask } from '@shared/types/task'
import { TaskStatus } from '@shared/types/task'
import { makeDownloadTask } from '@test-utils/task'
import { act, renderHook, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { createElement, StrictMode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { __resetTaskListStoreForTests, useTaskList } from './use-task-list'

type Listener = (...args: unknown[]) => void

const listeners = new Map<string, Set<Listener>>()

const connectionListeners = new Set<(event: { state: string }) => void>()

const transportMock = vi.hoisted(() => ({
  invoke: vi.fn(),
  on: vi.fn((channel: string, cb: Listener) => {
    let set = listeners.get(channel)
    if (!set) {
      set = new Set()
      listeners.set(channel, set)
    }
    set.add(cb)
  }),
  off: vi.fn((channel: string, cb: Listener) => {
    listeners.get(channel)?.delete(cb)
  }),
  onConnectionChange: vi.fn(
    (cb: (event: { state: string }) => void): (() => void) => {
      connectionListeners.add(cb)
      return () => connectionListeners.delete(cb)
    }
  ),
  platform: 'darwin' as const,
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

function task(id: string, status: TaskStatus): DownloadTask {
  return makeDownloadTask({ id, status })
}

function emit(channel: string, payload?: readonly DownloadTask[]): void {
  for (const listener of listeners.get(channel) ?? []) listener(payload)
}

async function flushDeferredTeardown(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}

beforeEach(() => {
  __resetTaskListStoreForTests()
  listeners.clear()
  transportMock.invoke.mockReset()
  transportMock.on.mockClear()
  transportMock.off.mockClear()
})

afterEach(() => {
  __resetTaskListStoreForTests()
  vi.clearAllMocks()
})

describe('useTaskList external store', () => {
  it('hydrates once for three consumers and attaches one listener set', async () => {
    const rows = [task('t1', TaskStatus.Downloading)]
    transportMock.invoke.mockResolvedValue(rows)

    const first = renderHook(() => useTaskList())
    const second = renderHook(() => useTaskList())
    const third = renderHook(() => useTaskList())

    await waitFor(() => expect(first.result.current.status).toBe('ready'))

    expect(transportMock.invoke).toHaveBeenCalledTimes(1)
    expect(transportMock.invoke).toHaveBeenCalledWith(Queries.ListTasks)
    expect(transportMock.on).toHaveBeenCalledTimes(1)
    expect(listeners.get(Events.TaskUpdated)).toHaveLength(1)
    expect(first.result.current).toBe(second.result.current)
    expect(second.result.current).toBe(third.result.current)
  })

  it('starts loading and distinguishes the first empty ready snapshot', async () => {
    const hydration = deferred<readonly DownloadTask[]>()
    transportMock.invoke.mockReturnValue(hydration.promise)

    const { result } = renderHook(() => useTaskList())
    expect(result.current.status).toBe('loading')
    expect(result.current.hasReadySnapshot).toBe(false)
    expect(result.current.tasks).toEqual([])

    await act(async () => {
      hydration.resolve([])
      await hydration.promise
    })

    expect(result.current.status).toBe('ready')
    expect(result.current.hasReadySnapshot).toBe(true)
    expect(result.current.tasks).toEqual([])
  })

  it('publishes one immutable event snapshot to all consumers', async () => {
    transportMock.invoke.mockResolvedValue([])
    const first = renderHook(() => useTaskList())
    const second = renderHook(() => useTaskList())
    await waitFor(() => expect(first.result.current.status).toBe('ready'))

    const rows = [task('paused', TaskStatus.Paused)]
    act(() => emit(Events.TaskUpdated, rows))

    expect(first.result.current).toBe(second.result.current)
    expect(first.result.current.tasks).toEqual(rows)
    expect(Object.isFrozen(first.result.current.tasks)).toBe(true)
    expect(first.result.current.hasAnyPaused).toBe(true)
  })

  it('distinguishes an initial error from an error with cached data', async () => {
    transportMock.invoke.mockRejectedValueOnce(new Error('offline'))
    const { result } = renderHook(() => useTaskList())

    await waitFor(() => expect(result.current.status).toBe('error'))
    expect(result.current.hasReadySnapshot).toBe(false)
    expect(result.current.tasks).toEqual([])

    const cached = [task('cached', TaskStatus.Completed)]
    act(() => emit(Events.TaskUpdated, cached))
    expect(result.current.status).toBe('ready')
    expect(result.current.hasReadySnapshot).toBe(true)

    transportMock.invoke.mockRejectedValueOnce(new Error('offline again'))
    act(() => emit(Events.TaskUpdated))
    await waitFor(() => expect(result.current.status).toBe('error'))

    expect(result.current.hasReadySnapshot).toBe(true)
    expect(result.current.tasks).toEqual(cached)
  })

  it('deduplicates concurrent retries and recovers to ready', async () => {
    transportMock.invoke.mockRejectedValueOnce(new Error('offline'))
    const { result } = renderHook(() => useTaskList())
    await waitFor(() => expect(result.current.status).toBe('error'))

    const retryRequest = deferred<readonly DownloadTask[]>()
    transportMock.invoke.mockReturnValueOnce(retryRequest.promise)

    let firstRetry!: Promise<void>
    let secondRetry!: Promise<void>
    act(() => {
      firstRetry = result.current.retry()
      secondRetry = result.current.retry()
    })

    expect(firstRetry).toBe(secondRetry)
    expect(transportMock.invoke).toHaveBeenCalledTimes(2)
    expect(result.current.status).toBe('loading')

    const recovered = [task('recovered', TaskStatus.Downloading)]
    await act(async () => {
      retryRequest.resolve(recovered)
      await firstRetry
    })

    expect(result.current.status).toBe('ready')
    expect(result.current.hasReadySnapshot).toBe(true)
    expect(result.current.tasks).toEqual(recovered)
  })

  it('retains the exact snapshot object for stable inputs', async () => {
    const row = task('stable', TaskStatus.Downloading)
    const rows = [row]
    transportMock.invoke.mockResolvedValue(rows)
    const { result } = renderHook(() => useTaskList())
    await waitFor(() => expect(result.current.status).toBe('ready'))

    const before = result.current
    act(() => emit(Events.TaskUpdated, rows))
    expect(result.current).toBe(before)

    act(() => emit(Events.TaskUpdated, [row]))
    expect(result.current).toBe(before)
  })

  it('reuses pending hydration across a Strict Mode remount', async () => {
    const hydration = deferred<readonly DownloadTask[]>()
    transportMock.invoke.mockReturnValue(hydration.promise)
    const wrapper = ({ children }: { children: ReactNode }) =>
      createElement(StrictMode, null, children)

    const { result } = renderHook(() => useTaskList(), { wrapper })
    expect(transportMock.invoke).toHaveBeenCalledTimes(1)

    await act(async () => {
      hydration.resolve([])
      await hydration.promise
    })
    expect(result.current.status).toBe('ready')
  })

  it('ignores an old lifecycle result after real teardown', async () => {
    const oldHydration = deferred<readonly DownloadTask[]>()
    const newHydration = deferred<readonly DownloadTask[]>()
    transportMock.invoke
      .mockReturnValueOnce(oldHydration.promise)
      .mockReturnValueOnce(newHydration.promise)

    const oldConsumer = renderHook(() => useTaskList())
    oldConsumer.unmount()
    await flushDeferredTeardown()

    const nextConsumer = renderHook(() => useTaskList())
    expect(transportMock.invoke).toHaveBeenCalledTimes(2)

    await act(async () => {
      oldHydration.resolve([task('stale', TaskStatus.Downloading)])
      await oldHydration.promise
    })
    expect(nextConsumer.result.current.tasks).toEqual([])

    await act(async () => {
      newHydration.resolve([task('current', TaskStatus.Downloading)])
      await newHydration.promise
    })
    expect(nextConsumer.result.current.tasks.map((row) => row.id)).toEqual([
      'current',
    ])
  })

  it('does not let late hydration overwrite a newer event snapshot', async () => {
    const hydration = deferred<readonly DownloadTask[]>()
    transportMock.invoke.mockReturnValue(hydration.promise)
    const { result } = renderHook(() => useTaskList())

    act(() => emit(Events.TaskUpdated, [task('event', TaskStatus.Downloading)]))
    expect(result.current.status).toBe('ready')

    await act(async () => {
      hydration.resolve([task('hydrate', TaskStatus.Completed)])
      await hydration.promise
    })
    expect(result.current.tasks.map((row) => row.id)).toEqual(['event'])
  })

  it('re-snapshots after the transport reconnects', async () => {
    transportMock.invoke.mockResolvedValueOnce([
      task('stale', TaskStatus.Downloading),
    ])
    const { result } = renderHook(() => useTaskList())
    await waitFor(() => expect(result.current.status).toBe('ready'))
    expect(transportMock.invoke).toHaveBeenCalledTimes(1)

    // A disconnect window can swallow removal/terminal frames, and the
    // delta-gated poll tick never re-broadcasts an unchanged engine — the
    // reconnect re-snapshot is the only recovery path.
    transportMock.invoke.mockResolvedValueOnce([
      task('fresh', TaskStatus.Completed),
    ])
    act(() => {
      for (const cb of connectionListeners) cb({ state: 'disconnected' })
      for (const cb of connectionListeners) cb({ state: 'connected' })
    })

    await waitFor(() => expect(transportMock.invoke).toHaveBeenCalledTimes(2))
    await waitFor(() =>
      expect(result.current.tasks.map((row) => row.id)).toEqual(['fresh'])
    )
  })

  it('coalesces a reconnect storm into one active and one trailing snapshot', async () => {
    transportMock.invoke.mockResolvedValueOnce([
      task('stale', TaskStatus.Downloading),
    ])
    const { result } = renderHook(() => useTaskList())
    await waitFor(() => expect(result.current.status).toBe('ready'))
    expect(transportMock.invoke).toHaveBeenCalledTimes(1)

    const first = deferred<readonly DownloadTask[]>()
    const trailing = deferred<readonly DownloadTask[]>()
    transportMock.invoke
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(trailing.promise)

    // A flapping transport delivers several connected edges back to back.
    // Firing one ListTasks per edge lets an EARLIER response get discarded
    // by the generation guard while a LATER failure strands the stale list.
    act(() => {
      for (const cb of connectionListeners) cb({ state: 'connected' })
      for (const cb of connectionListeners) cb({ state: 'connected' })
    })
    expect(transportMock.invoke).toHaveBeenCalledTimes(2)

    await act(async () => {
      first.resolve([task('mid', TaskStatus.Downloading)])
      await first.promise
    })

    await waitFor(() => expect(transportMock.invoke).toHaveBeenCalledTimes(3))
    await act(async () => {
      trailing.resolve([task('fresh', TaskStatus.Completed)])
      await trailing.promise
    })
    expect(result.current.tasks.map((row) => row.id)).toEqual(['fresh'])
    expect(result.current.status).toBe('ready')
  })

  it('retries a failed reconnect snapshot with backoff instead of staying stale', async () => {
    vi.useFakeTimers()
    try {
      transportMock.invoke.mockResolvedValueOnce([
        task('stale', TaskStatus.Downloading),
      ])
      const { result } = renderHook(() => useTaskList())
      await act(async () => {})
      expect(result.current.status).toBe('ready')

      // The reconnect re-snapshot fails transiently. With a ready snapshot
      // on screen the error state is invisible, so without a retry the
      // frames missed during the disconnect stay stale forever.
      transportMock.invoke.mockRejectedValueOnce(new Error('flaky'))
      act(() => {
        for (const cb of connectionListeners) cb({ state: 'connected' })
      })
      await act(async () => {})
      expect(result.current.status).toBe('error')
      expect(result.current.tasks.map((row) => row.id)).toEqual(['stale'])
      expect(transportMock.invoke).toHaveBeenCalledTimes(2)

      transportMock.invoke.mockResolvedValueOnce([
        task('fresh', TaskStatus.Completed),
      ])
      // Base delay 1s plus up to 25% jitter: advance past the upper bound.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1_500)
      })
      expect(transportMock.invoke).toHaveBeenCalledTimes(3)
      expect(result.current.status).toBe('ready')
      expect(result.current.tasks.map((row) => row.id)).toEqual(['fresh'])
    } finally {
      vi.useRealTimers()
    }
  })

  it('keeps retrying a failed resync with capped backoff instead of giving up', async () => {
    vi.useFakeTimers()
    try {
      transportMock.invoke.mockResolvedValueOnce([
        task('stale', TaskStatus.Downloading),
      ])
      const { result } = renderHook(() => useTaskList())
      await act(async () => {})
      expect(result.current.status).toBe('ready')

      // The snapshot query rides a separate HTTP POST: it can stay broken
      // long past any finite retry budget while the WS never re-fires a
      // connected edge, and the delta-gated push will not replay what was
      // missed. The retry loop must therefore be unbounded (capped delay).
      transportMock.invoke.mockRejectedValue(new Error('http down'))
      act(() => {
        for (const cb of connectionListeners) cb({ state: 'connected' })
      })
      await act(async () => {})
      expect(transportMock.invoke).toHaveBeenCalledTimes(2)

      const before = transportMock.invoke.mock.calls.length
      await act(async () => {
        await vi.advanceTimersByTimeAsync(10 * 60_000)
      })
      expect(
        transportMock.invoke.mock.calls.length - before
      ).toBeGreaterThanOrEqual(8)

      transportMock.invoke.mockResolvedValueOnce([
        task('fresh', TaskStatus.Completed),
      ])
      await act(async () => {
        await vi.advanceTimersByTimeAsync(60_000)
      })
      expect(result.current.status).toBe('ready')
      expect(result.current.tasks.map((row) => row.id)).toEqual(['fresh'])
    } finally {
      vi.useRealTimers()
    }
  })

  it('abandons a hung snapshot request after the deadline and recovers', async () => {
    vi.useFakeTimers()
    try {
      transportMock.invoke.mockResolvedValueOnce([
        task('stale', TaskStatus.Downloading),
      ])
      const { result } = renderHook(() => useTaskList())
      await act(async () => {})
      expect(result.current.status).toBe('ready')

      // The transport has no deadline of its own: a request that never
      // settles must not pin pendingRequest forever and wedge the
      // coalescer — no later event or edge could ever fetch again.
      const hung = deferred<readonly DownloadTask[]>()
      transportMock.invoke.mockReturnValueOnce(hung.promise)
      act(() => {
        for (const cb of connectionListeners) cb({ state: 'connected' })
      })
      expect(transportMock.invoke).toHaveBeenCalledTimes(2)

      transportMock.invoke.mockResolvedValueOnce([
        task('fresh', TaskStatus.Completed),
      ])
      await act(async () => {
        await vi.advanceTimersByTimeAsync(120_000)
      })
      expect(transportMock.invoke).toHaveBeenCalledTimes(3)
      expect(result.current.tasks.map((row) => row.id)).toEqual(['fresh'])
    } finally {
      vi.useRealTimers()
    }
  })

  it('a hung request invalidated by the deadline cannot evict the retry result', async () => {
    vi.useFakeTimers()
    try {
      transportMock.invoke.mockResolvedValueOnce([
        task('stale', TaskStatus.Downloading),
      ])
      const { result } = renderHook(() => useTaskList())
      await act(async () => {})
      expect(result.current.status).toBe('ready')

      const hung = deferred<readonly DownloadTask[]>()
      const retryReq = deferred<readonly DownloadTask[]>()
      transportMock.invoke
        .mockReturnValueOnce(hung.promise)
        .mockReturnValueOnce(retryReq.promise)
      act(() => {
        for (const cb of connectionListeners) cb({ state: 'connected' })
      })

      // Deadline fires, then the backoff retry starts a second request.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(20_000)
      })
      expect(transportMock.invoke).toHaveBeenCalledTimes(3)

      // The abandoned request responds LATE, before the retry's response.
      // Publishing it would bump the generation and discard the retry's
      // fresher snapshot — the deadline must have invalidated it instead.
      await act(async () => {
        hung.resolve([task('old', TaskStatus.Downloading)])
        await hung.promise
      })
      await act(async () => {
        retryReq.resolve([task('fresh', TaskStatus.Completed)])
        await retryReq.promise
      })
      expect(result.current.status).toBe('ready')
      expect(result.current.tasks.map((row) => row.id)).toEqual(['fresh'])
    } finally {
      vi.useRealTimers()
    }
  })

  it('the deadline does not mark fresh pushed data as error', async () => {
    vi.useFakeTimers()
    try {
      transportMock.invoke.mockResolvedValueOnce([
        task('stale', TaskStatus.Downloading),
      ])
      const { result } = renderHook(() => useTaskList())
      await act(async () => {})
      expect(result.current.status).toBe('ready')

      const hung = deferred<readonly DownloadTask[]>()
      transportMock.invoke.mockReturnValueOnce(hung.promise)
      act(() => {
        for (const cb of connectionListeners) cb({ state: 'connected' })
      })

      // An authoritative push supersedes the hung snapshot request…
      act(() =>
        emit(Events.TaskUpdated, [task('pushed', TaskStatus.Completed)])
      )
      expect(result.current.tasks.map((row) => row.id)).toEqual(['pushed'])

      // …so the later deadline must not stamp 'error' over the fresh data.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(20_000)
      })
      expect(result.current.status).toBe('ready')
      expect(result.current.tasks.map((row) => row.id)).toEqual(['pushed'])
    } finally {
      vi.useRealTimers()
    }
  })

  it('refetches after a legacy event that arrives during hydration', async () => {
    const hydration = deferred<readonly DownloadTask[]>()
    const refetch = deferred<readonly DownloadTask[]>()
    transportMock.invoke
      .mockReturnValueOnce(hydration.promise)
      .mockReturnValueOnce(refetch.promise)
    const { result } = renderHook(() => useTaskList())

    act(() => emit(Events.TaskUpdated))
    expect(transportMock.invoke).toHaveBeenCalledTimes(1)

    await act(async () => {
      hydration.resolve([task('stale', TaskStatus.Completed)])
      await hydration.promise
    })

    await waitFor(() => expect(transportMock.invoke).toHaveBeenCalledTimes(2))
    expect(result.current.status).toBe('loading')
    expect(result.current.tasks).toEqual([])

    await act(async () => {
      refetch.resolve([task('current', TaskStatus.Completed)])
      await refetch.promise
    })
    expect(result.current.status).toBe('ready')
    expect(result.current.tasks.map((row) => row.id)).toEqual(['current'])
  })

  it('detaches listeners once after the final deferred unsubscribe', async () => {
    transportMock.invoke.mockResolvedValue([])
    const first = renderHook(() => useTaskList())
    const second = renderHook(() => useTaskList())
    await waitFor(() => expect(first.result.current.status).toBe('ready'))

    first.unmount()
    expect(transportMock.off).not.toHaveBeenCalled()
    second.unmount()
    expect(transportMock.off).not.toHaveBeenCalled()

    await flushDeferredTeardown()
    expect(transportMock.off).toHaveBeenCalledTimes(1)
    expect(transportMock.off).toHaveBeenCalledWith(
      Events.TaskUpdated,
      expect.any(Function)
    )
  })

  it('coalesces concurrent legacy events into one trailing refetch', async () => {
    transportMock.invoke.mockResolvedValueOnce([])
    const { result } = renderHook(() => useTaskList())
    await waitFor(() => expect(result.current.status).toBe('ready'))

    const refetch = deferred<readonly DownloadTask[]>()
    const trailingRefetch = deferred<readonly DownloadTask[]>()
    transportMock.invoke
      .mockReturnValueOnce(refetch.promise)
      .mockReturnValueOnce(trailingRefetch.promise)
    act(() => {
      emit(Events.TaskUpdated)
      emit(Events.TaskUpdated)
      emit(Events.TaskUpdated)
    })
    expect(transportMock.invoke).toHaveBeenCalledTimes(2)

    await act(async () => {
      refetch.resolve([task('stale', TaskStatus.Error)])
      await refetch.promise
    })

    await waitFor(() => expect(transportMock.invoke).toHaveBeenCalledTimes(3))
    expect(result.current.tasks).toEqual([])

    await act(async () => {
      trailingRefetch.resolve([task('next', TaskStatus.Error)])
      await trailingRefetch.promise
    })
    expect(result.current.tasks.map((row) => row.id)).toEqual(['next'])
  })

  it('derives the existing menu aggregates from the shared snapshot', async () => {
    transportMock.invoke.mockResolvedValue([
      task('active', TaskStatus.Downloading),
      task('paused', TaskStatus.Paused),
      task('stopped', TaskStatus.Completed),
    ])
    const { result } = renderHook(() => useTaskList())
    await waitFor(() => expect(result.current.status).toBe('ready'))

    expect(result.current.hasAnyActive).toBe(true)
    expect(result.current.hasAnyPaused).toBe(true)
    expect(result.current.hasStopped).toBe(true)
  })
})
