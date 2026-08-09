import { Queries } from '@shared/protocol/queries'
import type { PluginCommandGraphDTO } from '@shared/types/plugin-command-graph'
import { act, renderHook } from '@testing-library/react'
import { StrictMode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { usePluginGraph } from './use-plugin-graph'

const transportMock = vi.hoisted(() => ({
  invoke: vi.fn(),
  on: vi.fn(),
  off: vi.fn(),
  platform: 'darwin' as const,
}))

vi.mock('@renderer/lib/transport', () => ({
  transport: transportMock,
}))

const POLL_INTERVAL_MS = 5 * 60 * 1000

const GRAPH: PluginCommandGraphDTO = {
  edges: [
    {
      sourcePluginId: 'plugin.source',
      targetPluginId: 'plugin.target',
      commandId: 'plugin.target.resolve',
      calls: 2,
      lastCalledAt: 1_800_000_000_000,
    },
  ],
  cutoff: 1_799_913_600_000,
  generatedAt: 1_800_000_000_000,
  truncated: false,
}

const REFRESHED_GRAPH: PluginCommandGraphDTO = {
  ...GRAPH,
  edges: [{ ...GRAPH.edges[0], calls: 3 }],
  generatedAt: 1_800_000_000_100,
}

interface Deferred<T> {
  promise: Promise<T>
  resolve(value: T): void
  reject(reason: unknown): void
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

async function flushMicrotasks() {
  await Promise.resolve()
  await Promise.resolve()
}

describe('usePluginGraph', () => {
  let visibilityState: DocumentVisibilityState

  beforeEach(() => {
    vi.useFakeTimers()
    visibilityState = 'visible'
    vi.spyOn(document, 'visibilityState', 'get').mockImplementation(
      () => visibilityState
    )
    transportMock.invoke.mockReset()
    transportMock.on.mockClear()
    transportMock.off.mockClear()
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('moves from idle through loading to successful graph data', async () => {
    const request = deferred<PluginCommandGraphDTO>()
    transportMock.invoke.mockReturnValue(request.promise)
    const observedStatuses: string[] = []

    const { result } = renderHook(() => {
      const state = usePluginGraph()
      observedStatuses.push(state.status)
      return state
    })

    expect(observedStatuses).toEqual(
      expect.arrayContaining(['idle', 'loading'])
    )
    expect(result.current).toMatchObject({
      data: null,
      status: 'loading',
      error: null,
      isRefreshing: false,
    })
    expect(transportMock.invoke).toHaveBeenCalledWith(
      Queries.GetPluginCommandGraph
    )

    await act(async () => {
      request.resolve(GRAPH)
      await request.promise
    })

    expect(result.current).toMatchObject({
      data: GRAPH,
      status: 'success',
      error: null,
      isRefreshing: false,
    })
  })

  it('normalizes an unknown rejection without fabricating an empty graph', async () => {
    const request = deferred<PluginCommandGraphDTO>()
    transportMock.invoke.mockReturnValue(request.promise)
    const { result } = renderHook(() => usePluginGraph())

    await act(async () => {
      request.reject(17)
      await flushMicrotasks()
    })

    expect(result.current).toEqual({
      data: null,
      status: 'error',
      error: {
        code: 'PLUGIN_GRAPH_LOAD_FAILED',
        message: 'Plugin command graph request failed',
      },
      isRefreshing: false,
      refresh: expect.any(Function),
    })
  })

  it('recovers from an initial error through manual refresh', async () => {
    transportMock.invoke
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce(GRAPH)
    const { result } = renderHook(() => usePluginGraph())

    await act(flushMicrotasks)
    expect(result.current.status).toBe('error')

    await act(async () => {
      await result.current.refresh()
    })

    expect(transportMock.invoke).toHaveBeenCalledTimes(2)
    expect(result.current).toMatchObject({
      data: GRAPH,
      status: 'success',
      error: null,
      isRefreshing: false,
    })
  })

  it('retains successful data during a background refresh', async () => {
    transportMock.invoke.mockResolvedValueOnce(GRAPH)
    const { result } = renderHook(() => usePluginGraph())
    await act(flushMicrotasks)

    const refreshRequest = deferred<PluginCommandGraphDTO>()
    transportMock.invoke.mockReturnValueOnce(refreshRequest.promise)
    act(() => {
      void result.current.refresh()
    })

    expect(result.current).toMatchObject({
      data: GRAPH,
      status: 'success',
      error: null,
      isRefreshing: true,
    })

    await act(async () => {
      refreshRequest.resolve(REFRESHED_GRAPH)
      await refreshRequest.promise
    })
    expect(result.current).toMatchObject({
      data: REFRESHED_GRAPH,
      status: 'success',
      isRefreshing: false,
    })
  })

  it('polls every five minutes while the document is visible', async () => {
    transportMock.invoke.mockResolvedValue(GRAPH)
    renderHook(() => usePluginGraph())
    await act(flushMicrotasks)

    await act(async () => {
      await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS)
    })
    expect(transportMock.invoke).toHaveBeenCalledTimes(2)

    await act(async () => {
      await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS)
    })
    expect(transportMock.invoke).toHaveBeenCalledTimes(3)
  })

  it('does not poll while hidden and refreshes immediately when visible', async () => {
    visibilityState = 'hidden'
    transportMock.invoke.mockResolvedValue(GRAPH)
    renderHook(() => usePluginGraph())
    await act(flushMicrotasks)

    await act(async () => {
      await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS * 2)
    })
    expect(transportMock.invoke).toHaveBeenCalledTimes(1)

    visibilityState = 'visible'
    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'))
      await flushMicrotasks()
    })
    expect(transportMock.invoke).toHaveBeenCalledTimes(2)

    visibilityState = 'hidden'
    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'))
      await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS)
    })
    expect(transportMock.invoke).toHaveBeenCalledTimes(2)
  })

  it('restarts the polling phase when the document becomes visible', async () => {
    transportMock.invoke.mockResolvedValue(GRAPH)
    renderHook(() => usePluginGraph())
    await act(flushMicrotasks)

    await act(async () => {
      await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS - 1_000)
    })
    visibilityState = 'hidden'
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'))
    })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(121_000)
    })
    expect(transportMock.invoke).toHaveBeenCalledTimes(1)

    visibilityState = 'visible'
    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'))
      await flushMicrotasks()
    })
    expect(transportMock.invoke).toHaveBeenCalledTimes(2)

    await act(async () => {
      await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS - 1)
    })
    expect(transportMock.invoke).toHaveBeenCalledTimes(2)

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1)
    })
    expect(transportMock.invoke).toHaveBeenCalledTimes(3)
  })

  it('shares one request across manual, timer, and visibility triggers', async () => {
    transportMock.invoke.mockResolvedValueOnce(GRAPH)
    const { result } = renderHook(() => usePluginGraph())
    await act(flushMicrotasks)

    const refreshRequest = deferred<PluginCommandGraphDTO>()
    transportMock.invoke.mockReturnValueOnce(refreshRequest.promise)
    let manualRequest!: Promise<void>
    let duplicateManualRequest!: Promise<void>
    act(() => {
      manualRequest = result.current.refresh()
      duplicateManualRequest = result.current.refresh()
    })
    expect(duplicateManualRequest).toBe(manualRequest)

    await act(async () => {
      await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS)
      document.dispatchEvent(new Event('visibilitychange'))
    })
    expect(transportMock.invoke).toHaveBeenCalledTimes(2)

    await act(async () => {
      refreshRequest.resolve(REFRESHED_GRAPH)
      await manualRequest
    })
    expect(result.current.data).toEqual(REFRESHED_GRAPH)
    expect(result.current.isRefreshing).toBe(false)
  })

  it('does not let a stale StrictMode request overwrite newer data', async () => {
    const staleRequest = deferred<PluginCommandGraphDTO>()
    const currentRequest = deferred<PluginCommandGraphDTO>()
    transportMock.invoke
      .mockReturnValueOnce(staleRequest.promise)
      .mockReturnValueOnce(currentRequest.promise)
    const { result } = renderHook(() => usePluginGraph(), {
      wrapper: StrictMode,
    })
    expect(transportMock.invoke).toHaveBeenCalledTimes(2)

    await act(async () => {
      currentRequest.resolve(REFRESHED_GRAPH)
      await currentRequest.promise
    })
    expect(result.current.data).toEqual(REFRESHED_GRAPH)

    await act(async () => {
      staleRequest.resolve(GRAPH)
      await staleRequest.promise
    })
    expect(result.current.data).toEqual(REFRESHED_GRAPH)
  })

  it('removes its timer and visibility listener on unmount', async () => {
    const removeListener = vi.spyOn(document, 'removeEventListener')
    transportMock.invoke.mockResolvedValue(GRAPH)
    const { unmount } = renderHook(() => usePluginGraph())
    await act(flushMicrotasks)

    unmount()
    expect(removeListener).toHaveBeenCalledWith(
      'visibilitychange',
      expect.any(Function)
    )

    await act(async () => {
      await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS * 2)
    })
    expect(transportMock.invoke).toHaveBeenCalledTimes(1)
  })

  it('does not update state when a stale request settles after unmount', async () => {
    const request = deferred<PluginCommandGraphDTO>()
    transportMock.invoke.mockReturnValue(request.promise)
    const observedStatuses: string[] = []
    const { unmount } = renderHook(() => {
      const state = usePluginGraph()
      observedStatuses.push(state.status)
      return state
    })
    const renderCountBeforeUnmount = observedStatuses.length

    unmount()
    await act(async () => {
      request.resolve(GRAPH)
      await request.promise
    })

    expect(observedStatuses).toHaveLength(renderCountBeforeUnmount)
  })
})
