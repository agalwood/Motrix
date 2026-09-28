// src/renderer/hooks/use-global-speed-history.test.tsx
import { Events } from '@shared/protocol/events'
import { Queries } from '@shared/protocol/queries'
import type { SpeedPoint } from '@shared/types/stats'
import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mockInvoke = vi.fn()
const listeners = new Map<string, (...a: unknown[]) => void>()
const connectionListeners = new Set<(event: { state: string }) => void>()
vi.mock('@renderer/lib/transport', () => ({
  transport: {
    invoke: (...a: unknown[]) => mockInvoke(...a),
    on: (ch: string, cb: (...a: unknown[]) => void) => listeners.set(ch, cb),
    off: (ch: string) => listeners.delete(ch),
    onConnectionChange: (cb: (event: { state: string }) => void) => {
      connectionListeners.add(cb)
      return () => connectionListeners.delete(cb)
    },
    platform: 'darwin',
  },
}))

const { useGlobalSpeedHistory, __resetGlobalSpeedHistoryStoreForTests } =
  await import('./use-global-speed-history')

const stats = (down: number, up: number) => ({
  totalDownloadSpeed: down,
  totalUploadSpeed: up,
  activeTasks: down > 0 || up > 0 ? 1 : 0,
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
    vi.useRealTimers()
    vi.restoreAllMocks()
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

  describe('idle display clock', () => {
    beforeEach(() => {
      vi.useFakeTimers()
      vi.setSystemTime(100_000)
      vi.spyOn(document, 'hidden', 'get').mockReturnValue(false)
      mockInvoke.mockResolvedValue([{ t: 99_000, down: 500, up: 100 }])
    })

    async function mount() {
      const hook = renderHook(() => useGlobalSpeedHistory())
      await act(async () => {
        await Promise.resolve()
      })
      return hook
    }

    const emit = (down = 0, up = 0, activeTasks = 0) => {
      act(() =>
        listeners.get(Events.StatsUpdated)?.({
          ...stats(down, up),
          activeTasks,
        })
      )
    }

    const advance = async (ms: number) => {
      await act(async () => vi.advanceTimersByTimeAsync(ms))
    }

    it('scrolls a completed transfer out with one zero sample per second between 10s engine polls', async () => {
      const { result } = await mount()
      emit()
      for (let second = 1; second <= 30; second++) {
        await advance(1_000)
        if (second % 10 === 0) emit()
        expect(result.current).toHaveLength(second + 2)
        expect(result.current.at(-1)).toEqual({
          t: 100_000 + second * 1_000,
          down: 0,
          up: 0,
        })
      }
      expect(
        result.current
          .slice(-24)
          .every((point) => point.down === 0 && point.up === 0)
      ).toBe(true)
      expect(mockInvoke).toHaveBeenCalledTimes(1)
    })

    it('does not insert zero samples during active work or after a transfer resumes', async () => {
      const { result } = await mount()
      emit(0, 0, 1)
      const active = result.current
      await advance(5_000)
      expect(result.current).toBe(active)
      emit()
      await advance(2_000)
      emit(800, 50, 1)
      const resumed = result.current
      await advance(5_000)
      expect(result.current).toBe(resumed)
      expect(result.current.at(-1)).toMatchObject({ down: 800, up: 50 })
    })

    it('clears a stale non-zero engine rate as soon as the final active task stops', async () => {
      const { result } = await mount()
      emit(500, 100, 0)
      expect(result.current.at(-1)).toEqual({ t: 100_000, down: 0, up: 0 })
      await advance(3_000)
      expect(result.current.at(-1)).toEqual({ t: 103_000, down: 0, up: 0 })
      expect(result.current).toHaveLength(5)
    })

    it('stops extending idle data if engine confirmation becomes stale', async () => {
      const { result } = await mount()
      emit()
      await advance(15_000)
      const stale = result.current
      await advance(30_000)
      expect(result.current).toBe(stale)
      expect(vi.getTimerCount()).toBe(0)
    })

    it('cancels the idle clock immediately on transport disconnect', async () => {
      const { result } = await mount()
      emit()
      await advance(2_000)
      act(() => {
        for (const listener of connectionListeners)
          listener({ state: 'disconnected' })
      })
      const disconnected = result.current
      await advance(10_000)
      expect(result.current).toBe(disconnected)
      expect(vi.getTimerCount()).toBe(0)
    })

    it('pauses while hidden and cancels the timer when the last subscriber leaves', async () => {
      const { result, unmount } = await mount()
      emit()
      await advance(2_000)
      vi.spyOn(document, 'hidden', 'get').mockReturnValue(true)
      act(() => document.dispatchEvent(new Event('visibilitychange')))
      const hidden = result.current
      await advance(3_000)
      expect(result.current).toBe(hidden)
      expect(vi.getTimerCount()).toBe(0)
      vi.spyOn(document, 'hidden', 'get').mockReturnValue(false)
      act(() => document.dispatchEvent(new Event('visibilitychange')))
      await advance(0)
      expect(result.current.at(-1)?.t).toBe(Date.now())
      unmount()
      expect(vi.getTimerCount()).toBe(0)
    })

    it('starts the idle clock after an in-flight seed resolves without losing the idle event', async () => {
      let resolveSeed!: (points: SpeedPoint[]) => void
      mockInvoke.mockReturnValue(
        new Promise<SpeedPoint[]>((resolve) => {
          resolveSeed = resolve
        })
      )
      const { result } = renderHook(() => useGlobalSpeedHistory())
      emit()
      expect(vi.getTimerCount()).toBe(0)
      await act(async () => resolveSeed([{ t: 99_000, down: 500, up: 100 }]))
      await advance(1_000)
      expect(result.current).toEqual([
        { t: 99_000, down: 500, up: 100 },
        { t: 100_000, down: 0, up: 0 },
        { t: 101_000, down: 0, up: 0 },
      ])
    })
  })
})
