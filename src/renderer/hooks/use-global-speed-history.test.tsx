// src/renderer/hooks/use-global-speed-history.test.tsx
import { Events } from '@shared/protocol/events'
import { Queries } from '@shared/protocol/queries'
import type { SpeedPoint } from '@shared/types/stats'
import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mockInvoke = vi.fn()
const listeners = new Map<string, (...a: unknown[]) => void>()
vi.mock('@renderer/lib/transport', () => ({
  transport: {
    invoke: (...a: unknown[]) => mockInvoke(...a),
    on: (ch: string, cb: (...a: unknown[]) => void) => listeners.set(ch, cb),
    off: (ch: string) => listeners.delete(ch),
    platform: 'darwin',
  },
}))

const { useGlobalSpeedHistory, __resetGlobalSpeedHistoryStoreForTests } =
  await import('./use-global-speed-history')

const stats = (down: number, up: number) => ({
  totalDownloadSpeed: down,
  totalUploadSpeed: up,
  activeTasks: 0,
  waitingTasks: 0,
  stoppedTasks: 0,
})

describe('useGlobalSpeedHistory', () => {
  beforeEach(() => {
    mockInvoke.mockReset()
    listeners.clear()
    __resetGlobalSpeedHistoryStoreForTests()
  })
  afterEach(() => {
    __resetGlobalSpeedHistoryStoreForTests()
  })

  it('hydrates from GetSpeedHistory on first mount and merges later events', async () => {
    const seed: SpeedPoint[] = [{ t: 100, down: 1, up: 1 }]
    mockInvoke.mockResolvedValue(seed)

    const { result } = renderHook(() => useGlobalSpeedHistory())

    await waitFor(() => expect(result.current).toEqual(seed))
    expect(mockInvoke).toHaveBeenCalledWith(Queries.GetSpeedHistory, {
      limit: 200,
    })

    act(() => listeners.get(Events.StatsUpdated)?.(stats(2, 3)))
    expect(result.current).toHaveLength(2)
    expect(result.current.at(-1)).toMatchObject({ down: 2, up: 3 })
  })

  it('does not drop points that arrive while GetSpeedHistory is in flight', async () => {
    let resolveSeed: ((data: SpeedPoint[]) => void) | null = null
    mockInvoke.mockReturnValue(
      new Promise<SpeedPoint[]>((resolve) => {
        resolveSeed = resolve
      })
    )

    const { result } = renderHook(() => useGlobalSpeedHistory())

    // event arrives BEFORE GetSpeedHistory resolves
    act(() => listeners.get(Events.StatsUpdated)?.(stats(7, 8)))

    // now resolve the seed
    await act(async () => {
      resolveSeed?.([{ t: 1, down: 1, up: 1 }])
      await Promise.resolve()
    })

    await waitFor(() => expect(result.current).toHaveLength(2))
    expect(result.current[0]).toMatchObject({ down: 1, up: 1 })
    expect(result.current[1]).toMatchObject({ down: 7, up: 8 })
  })

  it('shares the buffer across multiple callers (single subscription)', async () => {
    mockInvoke.mockResolvedValue([])
    const a = renderHook(() => useGlobalSpeedHistory())
    const b = renderHook(() => useGlobalSpeedHistory())

    await waitFor(() => expect(a.result.current).toEqual([]))

    act(() => listeners.get(Events.StatsUpdated)?.(stats(5, 6)))

    expect(a.result.current).toHaveLength(1)
    expect(b.result.current).toHaveLength(1)
    expect(a.result.current).toBe(b.result.current) // same reference
    expect(mockInvoke).toHaveBeenCalledTimes(1)
  })
})
