import { Events } from '@shared/protocol/events'
import { Queries } from '@shared/protocol/queries'
import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useTaskFiles } from './use-task-files'

type Listener = (...args: unknown[]) => void

const listeners = new Map<string, Set<Listener>>()

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
  onConnectionChange: vi.fn(),
  platform: 'darwin' as const,
}))

vi.mock('@renderer/lib/transport', () => ({
  transport: transportMock,
}))

beforeEach(() => {
  listeners.clear()
  transportMock.invoke.mockReset()
  transportMock.on.mockClear()
  transportMock.off.mockClear()
  transportMock.onConnectionChange.mockReset()
  transportMock.invoke.mockResolvedValue([
    { index: 0, path: 'a', size: 1, completedBytes: 0, selected: true },
  ])
})

afterEach(() => {
  vi.clearAllMocks()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('useTaskFiles', () => {
  it('does not fetch for a disabled panel', async () => {
    const { result } = renderHook(() => useTaskFiles(null, true))
    await act(async () => {})
    expect(result.current.loading).toBe(false)
    expect(transportMock.invoke).not.toHaveBeenCalled()
  })

  it('coalesces invalidations during a slow request and rejects its stale data', async () => {
    let resolveOld!: (value: unknown) => void
    transportMock.invoke.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveOld = resolve
        })
    )
    const { result } = renderHook(() => useTaskFiles('t1', true))
    act(() => {
      for (let index = 0; index < 10; index++)
        listeners.get(Events.TaskFilesUpdated)?.forEach((cb) => {
          cb({ taskId: 't1' })
        })
    })
    expect(transportMock.invoke).toHaveBeenCalledTimes(1)
    await act(async () => {
      resolveOld([
        {
          index: 9,
          path: 'stale',
          size: 1,
          completedBytes: 0,
          selected: false,
        },
      ])
    })
    await waitFor(() => expect(result.current.files[0]?.path).toBe('a'))
    expect(transportMock.invoke).toHaveBeenCalledTimes(2)
  })

  it('does not overlap slow progress reads or apply responses after unmount', async () => {
    vi.useFakeTimers()
    let resolve!: (value: unknown) => void
    transportMock.invoke.mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done
        })
    )
    const { unmount } = renderHook(() => useTaskFiles('t1', true))
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000)
    })
    expect(transportMock.invoke).toHaveBeenCalledTimes(1)
    unmount()
    await act(async () => {
      resolve([])
      await vi.advanceTimersByTimeAsync(10_000)
    })
    expect(transportMock.invoke).toHaveBeenCalledTimes(1)
  })

  it('discards responses from a previous engine instance of the same task', async () => {
    let resolveOld!: (value: unknown) => void
    transportMock.invoke.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveOld = resolve
        })
    )
    const { result, rerender } = renderHook(
      ({ gid }) => useTaskFiles('t1', true, gid),
      { initialProps: { gid: 'old' } }
    )
    rerender({ gid: 'new' })
    await waitFor(() => expect(result.current.files[0]?.path).toBe('a'))
    await act(async () => {
      resolveOld([{ index: 9, path: 'stale' }])
    })
    expect(result.current.files[0]?.path).toBe('a')
  })

  it('suspends when the document is hidden and immediately refreshes when visible', async () => {
    vi.useFakeTimers()
    const hidden = vi.spyOn(document, 'hidden', 'get').mockReturnValue(false)
    renderHook(() => useTaskFiles('t1', true))
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
    })
    hidden.mockReturnValue(true)
    act(() => document.dispatchEvent(new Event('visibilitychange')))
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000)
    })
    expect(transportMock.invoke).toHaveBeenCalledTimes(1)
    hidden.mockReturnValue(false)
    act(() => document.dispatchEvent(new Event('visibilitychange')))
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(transportMock.invoke).toHaveBeenCalledTimes(2)
  })

  it('refreshes paused tasks after reconnect and retains references for unchanged files', async () => {
    const detach = vi.fn()
    transportMock.onConnectionChange.mockReturnValue(detach)
    const { result, unmount } = renderHook(() => useTaskFiles('t1'))
    await waitFor(() => expect(result.current.files).toHaveLength(1))
    const previous = result.current.files
    transportMock.invoke.mockResolvedValue(
      previous.map((file) => ({ ...file }))
    )
    await act(async () => {
      transportMock.onConnectionChange.mock.calls[0][0]({ state: 'connected' })
    })
    expect(transportMock.invoke).toHaveBeenCalledTimes(2)
    expect(result.current.files).toBe(previous)
    unmount()
    expect(detach).toHaveBeenCalledOnce()
  })

  it('retains last-known files across failures and retries on the next tick', async () => {
    vi.useFakeTimers()
    const { result } = renderHook(() => useTaskFiles('t1', true))
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
    })
    const previous = result.current.files
    transportMock.invoke.mockRejectedValueOnce(new Error('offline'))
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000)
    })
    expect(result.current.files).toBe(previous)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000)
    })
    expect(transportMock.invoke).toHaveBeenCalledTimes(3)
  })

  it('fetches files on mount', async () => {
    const { result } = renderHook(() => useTaskFiles('t1'))
    await waitFor(() => expect(result.current.files).toHaveLength(1))
    expect(transportMock.invoke).toHaveBeenCalledWith(
      Queries.GetTaskFiles,
      't1'
    )
  })

  it('refetches on TaskFilesUpdated event for matching taskId', async () => {
    renderHook(() => useTaskFiles('t1'))
    await waitFor(() => expect(transportMock.invoke).toHaveBeenCalledTimes(1))
    expect(transportMock.on).toHaveBeenCalledWith(
      Events.TaskFilesUpdated,
      expect.any(Function)
    )
    act(() => {
      listeners.get(Events.TaskFilesUpdated)?.forEach((cb) => {
        cb({ taskId: 't1' })
      })
    })
    await waitFor(() => expect(transportMock.invoke).toHaveBeenCalledTimes(2))
  })

  it('does not refetch on TaskFilesUpdated for other taskId', async () => {
    renderHook(() => useTaskFiles('t1'))
    await waitFor(() => expect(transportMock.invoke).toHaveBeenCalledTimes(1))
    act(() => {
      listeners.get(Events.TaskFilesUpdated)?.forEach((cb) => {
        cb({ taskId: 't2' })
      })
    })
    expect(transportMock.invoke).toHaveBeenCalledTimes(1)
  })

  it('refreshes on its own cadence without subscribing to list updates', async () => {
    vi.useFakeTimers()
    renderHook(() => useTaskFiles('t1', true))
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(transportMock.on).not.toHaveBeenCalledWith(
      Events.TaskUpdated,
      expect.any(Function)
    )
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000)
    })
    expect(transportMock.invoke).toHaveBeenCalledTimes(2)
  })

  it('does not subscribe to task updates when live refresh is disabled', async () => {
    renderHook(() => useTaskFiles('t1'))
    await waitFor(() => expect(transportMock.invoke).toHaveBeenCalledTimes(1))

    expect(transportMock.on).not.toHaveBeenCalledWith(
      Events.TaskUpdated,
      expect.any(Function)
    )
  })

  it('unsubscribes on unmount', async () => {
    const { unmount } = renderHook(() => useTaskFiles('t1', true))
    await waitFor(() => expect(transportMock.on).toHaveBeenCalled())
    unmount()
    expect(transportMock.off).toHaveBeenCalledWith(
      Events.TaskFilesUpdated,
      expect.any(Function)
    )
    expect(listeners.get(Events.TaskFilesUpdated)?.size).toBe(0)
  })
})
