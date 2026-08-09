import { transport } from '@renderer/lib/transport'
import { Events } from '@shared/protocol/events'
import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  type TransportMirrorOptions,
  useTransportMirror,
} from './use-transport-mirror'

vi.mock('@renderer/lib/transport', () => ({
  transport: {
    invoke: vi.fn(),
    on: vi.fn(),
    off: vi.fn(),
    onConnectionChange: vi.fn(() => () => {}),
  },
}))

function baseOptions(
  overrides: Partial<TransportMirrorOptions> = {}
): TransportMirrorOptions {
  return {
    events: [Events.TaskUpdated],
    load: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  }
}

describe('useTransportMirror', () => {
  beforeEach(() => {
    vi.mocked(transport.on).mockReset()
    vi.mocked(transport.off).mockReset()
    vi.mocked(transport.onConnectionChange!)
      .mockReset()
      .mockImplementation(() => () => {})
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('registers every transport.on subscription before the first load call', async () => {
    const events = [Events.TaskUpdated, Events.StatsUpdated]
    const load = vi.fn().mockResolvedValue(undefined)
    renderHook(() => useTransportMirror({ events, load }))

    await waitFor(() => expect(load).toHaveBeenCalledTimes(1))

    const onOrders = vi.mocked(transport.on).mock.invocationCallOrder
    expect(onOrders).toHaveLength(events.length)
    const firstLoadOrder = load.mock.invocationCallOrder[0]
    for (const order of onOrders) {
      expect(order).toBeLessThan(firstLoadOrder)
    }
  })

  it('refreshes when a subscribed event fires', async () => {
    const events = [Events.TaskUpdated, Events.StatsUpdated]
    const load = vi.fn().mockResolvedValue(undefined)
    renderHook(() => useTransportMirror({ events, load }))
    await waitFor(() => expect(load).toHaveBeenCalledTimes(1))

    const handler = vi
      .mocked(transport.on)
      .mock.calls.find((call) => call[0] === Events.StatsUpdated)?.[1] as (
      ...args: unknown[]
    ) => void
    expect(handler).toBeDefined()
    act(() => {
      handler()
    })
    await waitFor(() => expect(load).toHaveBeenCalledTimes(2))
  })

  it('refreshes on window focus by default', async () => {
    const load = vi.fn().mockResolvedValue(undefined)
    renderHook(() => useTransportMirror(baseOptions({ load })))
    await waitFor(() => expect(load).toHaveBeenCalledTimes(1))

    act(() => {
      window.dispatchEvent(new Event('focus'))
    })
    await waitFor(() => expect(load).toHaveBeenCalledTimes(2))
  })

  it('does not refresh on focus when refetchOnFocus is false', async () => {
    const load = vi.fn().mockResolvedValue(undefined)
    renderHook(() =>
      useTransportMirror(baseOptions({ load, refetchOnFocus: false }))
    )
    await waitFor(() => expect(load).toHaveBeenCalledTimes(1))

    act(() => {
      window.dispatchEvent(new Event('focus'))
    })
    await act(async () => {
      await Promise.resolve()
    })
    expect(load).toHaveBeenCalledTimes(1)
  })

  it('refreshes on document visibilitychange only when refetchOnVisibility is true, and only on the transition into visible', async () => {
    const loadDisabled = vi.fn().mockResolvedValue(undefined)
    const disabled = renderHook(() =>
      useTransportMirror(baseOptions({ load: loadDisabled }))
    )
    await waitFor(() => expect(loadDisabled).toHaveBeenCalledTimes(1))
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'))
    })
    await act(async () => {
      await Promise.resolve()
    })
    expect(loadDisabled).toHaveBeenCalledTimes(1)
    disabled.unmount()

    const loadEnabled = vi.fn().mockResolvedValue(undefined)
    const enabled = renderHook(() =>
      useTransportMirror(
        baseOptions({ load: loadEnabled, refetchOnVisibility: true })
      )
    )
    await waitFor(() => expect(loadEnabled).toHaveBeenCalledTimes(1))

    // visible -> refetch (jsdom defaults document.visibilityState to
    // 'visible', so this dispatch is the visible-state case).
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'))
    })
    await waitFor(() => expect(loadEnabled).toHaveBeenCalledTimes(2))

    // hidden -> no refetch; a hidden-tab refetch is a wasted round-trip.
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      get: () => 'hidden',
    })
    try {
      act(() => {
        document.dispatchEvent(new Event('visibilitychange'))
      })
      await act(async () => {
        await Promise.resolve()
      })
      expect(loadEnabled).toHaveBeenCalledTimes(2)
    } finally {
      Reflect.deleteProperty(document, 'visibilityState')
    }

    enabled.unmount()
  })

  it('stale-guard: only the newest generation may commit when loads resolve out of order', async () => {
    type Stale = () => boolean
    const resolvers: Array<() => void> = []
    const load = vi.fn((_stale: Stale) => {
      return new Promise<void>((resolve) => {
        resolvers.push(resolve)
      })
    })

    const { result } = renderHook(() =>
      useTransportMirror(baseOptions({ load }))
    )
    expect(load).toHaveBeenCalledTimes(1)
    const firstStale = load.mock.calls[0]?.[0] as Stale

    let secondRefresh!: Promise<void>
    act(() => {
      secondRefresh = result.current.refresh()
    })
    expect(load).toHaveBeenCalledTimes(2)
    const secondStale = load.mock.calls[1]?.[0] as Stale

    // Resolve the newer (second) refresh first, the older (first) LAST —
    // out-of-order resolution.
    const secondResolve = resolvers[1]
    const firstResolve = resolvers[0]
    expect(secondResolve).toBeDefined()
    expect(firstResolve).toBeDefined()

    await act(async () => {
      secondResolve?.()
      await secondRefresh
    })
    await act(async () => {
      firstResolve?.()
      await Promise.resolve()
    })

    expect(firstStale()).toBe(true)
    expect(secondStale()).toBe(false)
  })

  it('retries exactly once after load rejects, then gives up', async () => {
    vi.useFakeTimers()
    let callCount = 0
    const load = vi.fn(async () => {
      callCount += 1
      throw new Error('transient failure')
    })

    renderHook(() => useTransportMirror(baseOptions({ load })))

    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(callCount).toBe(1)

    await act(async () => {
      await vi.advanceTimersByTimeAsync(500)
    })
    expect(callCount).toBe(2)

    // Second failure in a row: bounded to exactly one retry per generation.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500)
    })
    expect(callCount).toBe(2)
  })

  it('does not retry when retryOnce is false', async () => {
    vi.useFakeTimers()
    const load = vi.fn().mockRejectedValue(new Error('boom'))

    renderHook(() =>
      useTransportMirror(baseOptions({ load, retryOnce: false }))
    )

    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(load).toHaveBeenCalledTimes(1)

    await act(async () => {
      await vi.advanceTimersByTimeAsync(500)
    })
    expect(load).toHaveBeenCalledTimes(1)
  })

  it('refreshes when the transport reports a connected state', async () => {
    let connectionListener: ((event: { state: string }) => void) | undefined
    vi.mocked(transport.onConnectionChange!).mockImplementation((cb) => {
      connectionListener = cb as (event: { state: string }) => void
      return () => {}
    })
    const load = vi.fn().mockResolvedValue(undefined)
    renderHook(() => useTransportMirror(baseOptions({ load })))
    await waitFor(() => expect(load).toHaveBeenCalledTimes(1))

    act(() => {
      connectionListener?.({ state: 'connected' })
    })
    await waitFor(() => expect(load).toHaveBeenCalledTimes(2))

    act(() => {
      connectionListener?.({ state: 'disconnected' })
    })
    await act(async () => {
      await Promise.resolve()
    })
    expect(load).toHaveBeenCalledTimes(2)
  })

  it('cleanup removes every listener and clears the retry timer', async () => {
    vi.useFakeTimers()
    const unsubscribe = vi.fn()
    vi.mocked(transport.onConnectionChange!).mockReturnValue(unsubscribe)
    const load = vi.fn().mockRejectedValue(new Error('boom'))
    const events = [Events.TaskUpdated, Events.StatsUpdated]

    const { unmount } = renderHook(() =>
      useTransportMirror(baseOptions({ events, load }))
    )

    // Flush the rejected initial load so a retry timer gets scheduled.
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(load).toHaveBeenCalledTimes(1)

    unmount()

    const offChannels = vi
      .mocked(transport.off)
      .mock.calls.map((call) => call[0])
    expect(offChannels.sort()).toEqual([...events].sort())
    expect(unsubscribe).toHaveBeenCalledTimes(1)

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000)
    })
    // The retry timer was cleared on unmount — no second call ever fires.
    expect(load).toHaveBeenCalledTimes(1)
  })

  it('does not schedule a retry when an in-flight load rejects after unmount', async () => {
    vi.useFakeTimers()
    let rejectLoad!: (error: unknown) => void
    const load = vi.fn(
      () =>
        new Promise<void>((_resolve, reject) => {
          rejectLoad = reject
        })
    )

    const { unmount } = renderHook(() =>
      useTransportMirror(baseOptions({ load }))
    )
    expect(load).toHaveBeenCalledTimes(1)

    // Unmount while the initial load() is still pending — its rejection
    // arrives AFTER cleanup has already run.
    unmount()

    await act(async () => {
      rejectLoad(new Error('boom'))
      await Promise.resolve()
      await Promise.resolve()
    })

    // The unmounted hook's catch branch must not schedule a retry timer.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000)
    })
    expect(load).toHaveBeenCalledTimes(1)
  })

  it('returns a refresh function with a stable identity across re-renders', () => {
    const load = vi.fn().mockResolvedValue(undefined)
    const { result, rerender } = renderHook(() =>
      useTransportMirror(baseOptions({ load }))
    )
    const firstRefresh = result.current.refresh
    rerender()
    expect(result.current.refresh).toBe(firstRefresh)
  })

  it('reads load fresh on every call — a later render’s load closure replaces the mount-time one', async () => {
    const events = [Events.TaskUpdated]
    const loadA = vi.fn().mockResolvedValue(undefined)
    const loadB = vi.fn().mockResolvedValue(undefined)

    const { rerender } = renderHook(
      ({ load }: { load: TransportMirrorOptions['load'] }) =>
        useTransportMirror({ events, load }),
      { initialProps: { load: loadA } }
    )
    await waitFor(() => expect(loadA).toHaveBeenCalledTimes(1))

    // A fresh `load` closure on a later render — this is what breaks if
    // someone hoists `const { load } = optionsRef.current` to setup scope
    // instead of reading `optionsRef.current.load` fresh on every call.
    rerender({ load: loadB })

    const handler = vi
      .mocked(transport.on)
      .mock.calls.find((call) => call[0] === Events.TaskUpdated)?.[1] as (
      ...args: unknown[]
    ) => void
    expect(handler).toBeDefined()
    act(() => {
      handler()
    })

    await waitFor(() => expect(loadB).toHaveBeenCalledTimes(1))
    expect(loadA).toHaveBeenCalledTimes(1)
  })

  it('dedupes a duplicate channel in events: one subscribe, one unsubscribe', async () => {
    const events = [Events.TaskUpdated, Events.TaskUpdated, Events.StatsUpdated]
    const load = vi.fn().mockResolvedValue(undefined)
    const { unmount } = renderHook(() => useTransportMirror({ events, load }))
    await waitFor(() => expect(load).toHaveBeenCalledTimes(1))

    const onCalls = vi
      .mocked(transport.on)
      .mock.calls.filter((call) => call[0] === Events.TaskUpdated)
    expect(onCalls).toHaveLength(1)

    unmount()

    const offCalls = vi
      .mocked(transport.off)
      .mock.calls.filter((call) => call[0] === Events.TaskUpdated)
    expect(offCalls).toHaveLength(1)
  })
})
