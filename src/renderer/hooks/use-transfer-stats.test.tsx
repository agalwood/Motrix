import { Events } from '@shared/protocol/events'
import { Queries } from '@shared/protocol/queries'
import type {
  GetTransferStatsParams,
  TransferStatsSnapshot,
} from '@shared/types/stats'
import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mockInvoke = vi.fn()
const listeners = new Map<string, (...args: unknown[]) => void>()
const transportPlatform = vi.hoisted(() => ({
  current: 'darwin' as 'darwin' | 'web',
}))

vi.mock('@renderer/lib/transport', () => ({
  transport: {
    invoke: (...args: unknown[]) => mockInvoke(...args),
    on: (channel: string, listener: (...args: unknown[]) => void) =>
      listeners.set(channel, listener),
    off: (channel: string, listener: (...args: unknown[]) => void) => {
      if (listeners.get(channel) === listener) listeners.delete(channel)
    },
    get platform() {
      return transportPlatform.current
    },
  },
}))

const {
  getLocalDayEnvironment,
  TRANSFER_REFRESH_THROTTLE_MS,
  TRANSFER_WEB_FALLBACK_REFRESH_MS,
  useTransferStats,
} = await import('./use-transfer-stats')

function makeSnapshot(params: GetTransferStatsParams): TransferStatsSnapshot {
  return {
    today: {
      downloadBytes: '200',
      uploadBytes: '100',
      totalBytes: '300',
      startedAt: params.dayStartMs,
      endsAt: params.dayEndMs,
      coverageStartedAt: params.dayStartMs,
    },
    allTime: {
      downloadBytes: '400',
      uploadBytes: '200',
      totalBytes: '600',
      startedAt: params.dayStartMs - 86_400_000,
      coverageStartedAt: params.dayStartMs - 86_400_000,
    },
    updatedAt: params.dayStartMs + 1_000,
    accuracy: 'estimated',
  }
}

function resolvedSnapshot() {
  mockInvoke.mockImplementation(
    (_channel: string, params: GetTransferStatsParams) =>
      Promise.resolve(makeSnapshot(params))
  )
}

async function flushPromises() {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
}

beforeEach(() => {
  vi.useRealTimers()
  mockInvoke.mockReset()
  listeners.clear()
  transportPlatform.current = 'darwin'
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('useTransferStats', () => {
  it('subscribes before hydration and exposes loading then ready', async () => {
    let resolveQuery: ((value: TransferStatsSnapshot) => void) | undefined
    mockInvoke.mockImplementation(
      (_channel: string, params: GetTransferStatsParams) =>
        new Promise<TransferStatsSnapshot>((resolve) => {
          resolveQuery = () => resolve(makeSnapshot(params))
        })
    )

    const { result } = renderHook(() => useTransferStats())

    expect(result.current.status).toBe('loading')
    expect(listeners.has(Events.StatsUpdated)).toBe(true)
    expect(mockInvoke).toHaveBeenCalledWith(
      Queries.GetTransferStats,
      expect.objectContaining({
        dayStartMs: expect.any(Number),
        dayEndMs: expect.any(Number),
      })
    )

    await act(async () =>
      resolveQuery?.(makeSnapshot(getLocalDayEnvironment().params))
    )
    expect(result.current.status).toBe('ready')
  })

  it('keeps the last snapshot stale after failure and recovers on retry', async () => {
    resolvedSnapshot()
    const { result } = renderHook(() => useTransferStats())
    await waitFor(() => expect(result.current.status).toBe('ready'))

    mockInvoke.mockRejectedValueOnce(new Error('offline'))
    act(() => result.current.retry())
    await waitFor(() => expect(result.current.status).toBe('stale'))
    expect(
      result.current.status === 'stale'
        ? result.current.snapshot.today.totalBytes
        : null
    ).toBe('300')

    resolvedSnapshot()
    act(() => result.current.retry())
    await waitFor(() => expect(result.current.status).toBe('ready'))
  })

  it('uses unavailable without a prior snapshot and retries', async () => {
    mockInvoke.mockRejectedValueOnce(new Error('unavailable'))
    const { result } = renderHook(() => useTransferStats())
    await waitFor(() => expect(result.current.status).toBe('unavailable'))

    resolvedSnapshot()
    act(() => result.current.retry())
    await waitFor(() => expect(result.current.status).toBe('ready'))
  })

  it('delivers the leading and final trailing refresh in a burst', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(2026, 6, 26, 12, 0, 0, 0))
    resolvedSnapshot()
    renderHook(() => useTransferStats())
    await flushPromises()
    mockInvoke.mockClear()

    await act(async () => {
      vi.advanceTimersByTime(TRANSFER_REFRESH_THROTTLE_MS)
      listeners.get(Events.StatsUpdated)?.()
      listeners.get(Events.StatsUpdated)?.()
      listeners.get(Events.StatsUpdated)?.()
      await Promise.resolve()
    })
    expect(mockInvoke).toHaveBeenCalledTimes(1)

    await act(async () => {
      vi.advanceTimersByTime(TRANSFER_REFRESH_THROTTLE_MS - 1)
      listeners.get(Events.StatsUpdated)?.()
      await Promise.resolve()
    })
    expect(mockInvoke).toHaveBeenCalledTimes(1)

    await act(async () => {
      vi.advanceTimersByTime(1)
      await Promise.resolve()
    })
    expect(mockInvoke).toHaveBeenCalledTimes(2)
  })

  it('refreshes at the next real local midnight', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(2026, 6, 26, 23, 59, 59, 0))
    resolvedSnapshot()
    renderHook(() => useTransferStats())
    await flushPromises()
    const firstParams = mockInvoke.mock.calls[0]?.[1] as GetTransferStatsParams

    await act(async () => {
      vi.advanceTimersByTime(1_000)
      await Promise.resolve()
    })

    expect(mockInvoke).toHaveBeenCalledTimes(2)
    const secondParams = mockInvoke.mock.calls[1]?.[1] as GetTransferStatsParams
    expect(secondParams.dayStartMs).toBe(firstParams.dayEndMs)
  })

  it('deduplicates focus and visibility refresh after sleep across midnight', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(2026, 6, 26, 12, 0, 0, 0))
    resolvedSnapshot()
    renderHook(() => useTransferStats())
    await flushPromises()
    mockInvoke.mockClear()

    vi.setSystemTime(new Date(2026, 6, 27, 12, 0, 0, 0))
    await act(async () => {
      window.dispatchEvent(new Event('focus'))
      document.dispatchEvent(new Event('visibilitychange'))
      await Promise.resolve()
    })

    expect(mockInvoke).toHaveBeenCalledTimes(1)
  })

  it('detects a runtime timezone-offset change on focus', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(2026, 6, 26, 12, 0, 0, 0))
    const timezoneOffset = vi
      .spyOn(Date.prototype, 'getTimezoneOffset')
      .mockReturnValue(0)
    resolvedSnapshot()
    renderHook(() => useTransferStats())
    await flushPromises()
    mockInvoke.mockClear()

    timezoneOffset.mockReturnValue(60)
    await act(async () => {
      window.dispatchEvent(new Event('focus'))
      await Promise.resolve()
    })

    expect(mockInvoke).toHaveBeenCalledTimes(1)
  })

  it('coalesces refreshes while a slow request is in flight', async () => {
    const resolvers: Array<(snapshot: TransferStatsSnapshot) => void> = []
    const params: GetTransferStatsParams[] = []
    mockInvoke.mockImplementation(
      (_channel: string, value: GetTransferStatsParams) => {
        params.push(value)
        return new Promise<TransferStatsSnapshot>((resolve) => {
          resolvers.push(resolve)
        })
      }
    )
    const { result } = renderHook(() => useTransferStats())

    act(() => result.current.retry())
    act(() => listeners.get(Events.StatsUpdated)?.())
    expect(mockInvoke).toHaveBeenCalledTimes(1)

    await act(async () => {
      resolvers[0]?.({
        ...makeSnapshot(params[0]),
        updatedAt: 1,
      })
    })
    expect(mockInvoke).toHaveBeenCalledTimes(2)
    expect(
      result.current.status === 'ready'
        ? result.current.snapshot.updatedAt
        : null
    ).toBe(1)

    await act(async () => {
      resolvers[1]?.({
        ...makeSnapshot(params[1]),
        updatedAt: 2,
      })
    })
    expect(
      result.current.status === 'ready'
        ? result.current.snapshot.updatedAt
        : null
    ).toBe(2)
  })

  it('uses a low-frequency visible fallback refresh for the web transport', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(2026, 6, 26, 12, 0, 0, 0))
    transportPlatform.current = 'web'
    resolvedSnapshot()
    renderHook(() => useTransferStats())
    await flushPromises()
    mockInvoke.mockClear()

    await act(async () => {
      vi.advanceTimersByTime(TRANSFER_WEB_FALLBACK_REFRESH_MS)
      await Promise.resolve()
    })

    expect(mockInvoke).toHaveBeenCalledTimes(1)
  })

  it('uses local calendar operations for 23- and 25-hour DST days', () => {
    const originalTimezone = process.env.TZ
    process.env.TZ = 'America/Los_Angeles'
    try {
      const spring = getLocalDayEnvironment(
        new Date('2026-03-08T12:00:00')
      ).params
      const fall = getLocalDayEnvironment(
        new Date('2026-11-01T12:00:00')
      ).params

      expect(spring.dayEndMs - spring.dayStartMs).toBe(23 * 60 * 60 * 1000)
      expect(fall.dayEndMs - fall.dayStartMs).toBe(25 * 60 * 60 * 1000)
    } finally {
      if (originalTimezone === undefined) {
        delete process.env.TZ
      } else {
        process.env.TZ = originalTimezone
      }
    }
  })

  it('cleans up subscriptions and scheduled timers', async () => {
    vi.useFakeTimers()
    resolvedSnapshot()
    const { unmount } = renderHook(() => useTransferStats())
    await flushPromises()

    expect(listeners.has(Events.StatsUpdated)).toBe(true)
    unmount()
    expect(listeners.has(Events.StatsUpdated)).toBe(false)
    expect(vi.getTimerCount()).toBe(0)
  })
})
