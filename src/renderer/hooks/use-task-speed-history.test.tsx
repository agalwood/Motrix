import { Events } from '@shared/protocol/events'
import { Queries } from '@shared/protocol/queries'
import type { DownloadTask } from '@shared/types/task'
import { TaskStatus } from '@shared/types/task'
import { makeDownloadTask } from '@test-utils/task'
import { act, renderHook, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { StrictMode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const listeners = new Map<string, (...a: unknown[]) => void>()
const mockInvoke = vi.fn()
vi.mock('@renderer/lib/transport', () => ({
  transport: {
    invoke: (...args: unknown[]) => mockInvoke(...args),
    on: (ch: string, cb: (...a: unknown[]) => void) => listeners.set(ch, cb),
    off: (ch: string) => listeners.delete(ch),
    platform: 'darwin',
  },
}))

import { useTaskSpeedHistory } from './use-task-speed-history'

function task(over: Partial<DownloadTask>): DownloadTask {
  return makeDownloadTask(over)
}

function StrictModeWrapper({ children }: { children: ReactNode }) {
  return <StrictMode>{children}</StrictMode>
}

describe('useTaskSpeedHistory', () => {
  beforeEach(() => {
    listeners.clear()
    mockInvoke.mockReset()
    mockInvoke.mockResolvedValue([])
  })

  it('hydrates saved samples before consuming live updates', async () => {
    mockInvoke.mockResolvedValue([{ t: 1, down: 50, up: 5 }])
    const { result } = renderHook(() => useTaskSpeedHistory('t-1'))
    expect(mockInvoke).toHaveBeenCalledWith(Queries.GetTaskSpeedHistory, {
      taskId: 't-1',
      limit: 60,
    })
    await waitFor(() => expect(result.current.isLoading).toBe(false))
    expect(result.current.history).toEqual([{ t: 1, down: 50, up: 5 }])

    act(() => {
      listeners.get(Events.TaskUpdated)?.([
        task({ id: 't-1', downloadSpeed: 100, uploadSpeed: 10 }),
      ])
    })
    expect(result.current.history.at(-1)).toEqual(
      expect.objectContaining({ down: 100, up: 10 })
    )
  })

  it('ignores snapshots that do not contain the target id', async () => {
    const { result } = renderHook(() => useTaskSpeedHistory('t-1'))
    await waitFor(() => expect(result.current.isLoading).toBe(false))
    act(() => {
      listeners.get(Events.TaskUpdated)?.([
        task({ id: 'other', downloadSpeed: 99, uploadSpeed: 9 }),
      ])
    })
    expect(result.current.history).toHaveLength(0)
  })

  it('skips null, accessor, and invalid numeric TaskUpdated elements', async () => {
    const getter = vi.fn(() => 't-1')
    const accessor = {
      status: TaskStatus.Downloading,
      downloadSpeed: 10,
      uploadSpeed: 1,
    }
    Object.defineProperty(accessor, 'id', {
      enumerable: true,
      get: getter,
    })
    const { result } = renderHook(() => useTaskSpeedHistory('t-1'))
    await waitFor(() => expect(result.current.isLoading).toBe(false))

    act(() => {
      listeners.get(Events.TaskUpdated)?.([
        null,
        accessor,
        {
          id: 't-1',
          status: TaskStatus.Downloading,
          downloadSpeed: Number.NaN,
          uploadSpeed: 0,
        },
      ])
    })

    expect(result.current.history).toHaveLength(0)
    expect(getter).not.toHaveBeenCalled()
  })

  it.each([
    ['a null row', [null]],
    ['a missing field', [{ t: 1, down: 1 }]],
    ['a NaN speed', [{ t: 1, down: Number.NaN, up: 0 }]],
    [
      'more than 60 rows',
      Array.from({ length: 61 }, (_, index) => ({
        t: index + 1,
        down: 1,
        up: 0,
      })),
    ],
  ])(
    'safely discards a speed-history response with %s',
    async (_label, rows) => {
      mockInvoke.mockResolvedValue(rows)

      const { result } = renderHook(() => useTaskSpeedHistory('t-1'))

      await waitFor(() => expect(result.current.isLoading).toBe(false))
      expect(result.current.history).toEqual([])
    }
  )

  it('caps the buffer at 60 points', async () => {
    const { result } = renderHook(() => useTaskSpeedHistory('t-1'))
    await waitFor(() => expect(result.current.isLoading).toBe(false))
    act(() => {
      for (let i = 0; i < 65; i++) {
        listeners.get(Events.TaskUpdated)?.([
          task({ id: 't-1', downloadSpeed: i, uploadSpeed: 0 }),
        ])
      }
    })
    expect(result.current.history).toHaveLength(60)
  })

  it('adds one zero endpoint and freezes after the task stops', async () => {
    const { result } = renderHook(() => useTaskSpeedHistory('t-1'))
    await waitFor(() => expect(result.current.isLoading).toBe(false))
    act(() => {
      listeners.get(Events.TaskUpdated)?.([
        task({ id: 't-1', downloadSpeed: 100 }),
      ])
      listeners.get(Events.TaskUpdated)?.([
        task({ id: 't-1', status: TaskStatus.Paused, downloadSpeed: 0 }),
      ])
      listeners.get(Events.TaskUpdated)?.([
        task({ id: 't-1', status: TaskStatus.Paused, downloadSpeed: 0 }),
      ])
    })

    expect(result.current.history.map((point) => point.down)).toEqual([100, 0])
  })

  it('keeps the terminal zero when React replays state updaters', async () => {
    const { result } = renderHook(() => useTaskSpeedHistory('t-1'), {
      wrapper: StrictModeWrapper,
    })
    await waitFor(() => expect(result.current.isLoading).toBe(false))

    act(() => {
      listeners.get(Events.TaskUpdated)?.([
        task({ id: 't-1', downloadSpeed: 100, uploadSpeed: 10 }),
      ])
      listeners.get(Events.TaskUpdated)?.([
        task({
          id: 't-1',
          status: TaskStatus.Paused,
          downloadSpeed: 0,
          uploadSpeed: 0,
        }),
      ])
    })

    expect(result.current.history.map((point) => point.down)).toEqual([100, 0])
  })

  it('adds one terminal zero after hydrating an active nonzero history', async () => {
    mockInvoke.mockResolvedValue([{ t: 1, down: 50, up: 5 }])
    const { result } = renderHook(() => useTaskSpeedHistory('t-1'))
    await waitFor(() => expect(result.current.isLoading).toBe(false))

    act(() => {
      listeners.get(Events.TaskUpdated)?.([
        task({
          id: 't-1',
          status: TaskStatus.Paused,
          downloadSpeed: 0,
          uploadSpeed: 0,
        }),
      ])
      listeners.get(Events.TaskUpdated)?.([
        task({
          id: 't-1',
          status: TaskStatus.Paused,
          downloadSpeed: 0,
          uploadSpeed: 0,
        }),
      ])
    })

    expect(result.current.history.map((point) => point.down)).toEqual([50, 0])
  })

  it('replays a pending paused boundary against hydrated recording state', async () => {
    let resolveHistory: (value: unknown) => void = () => {}
    mockInvoke.mockReturnValue(
      new Promise((resolve) => {
        resolveHistory = resolve
      })
    )
    const { result } = renderHook(() => useTaskSpeedHistory('t-1'))

    act(() => {
      listeners.get(Events.TaskUpdated)?.([
        task({
          id: 't-1',
          status: TaskStatus.Paused,
          downloadSpeed: 0,
          uploadSpeed: 0,
        }),
      ])
      resolveHistory([{ t: 1, down: 50, up: 5 }])
    })

    await waitFor(() => expect(result.current.isLoading).toBe(false))
    expect(result.current.history.map((point) => point.down)).toEqual([50, 0])
  })

  it('does not drop updates received while hydration is pending', async () => {
    let resolveHistory: (value: unknown) => void = () => {}
    mockInvoke.mockReturnValue(
      new Promise((resolve) => {
        resolveHistory = resolve
      })
    )
    const { result } = renderHook(() => useTaskSpeedHistory('t-1'))

    act(() => {
      listeners.get(Events.TaskUpdated)?.([
        task({ id: 't-1', downloadSpeed: 100, uploadSpeed: 10 }),
      ])
      resolveHistory([{ t: 1, down: 50, up: 5 }])
    })

    await waitFor(() => expect(result.current.isLoading).toBe(false))
    expect(result.current.history.map((point) => point.down)).toEqual([50, 100])
  })

  it('keeps pending live updates when hydration fails', async () => {
    let rejectHistory: (reason?: unknown) => void = () => {}
    mockInvoke.mockReturnValue(
      new Promise((_resolve, reject) => {
        rejectHistory = reject
      })
    )
    const { result } = renderHook(() => useTaskSpeedHistory('t-1'))

    act(() => {
      listeners.get(Events.TaskUpdated)?.([
        task({ id: 't-1', downloadSpeed: 100, uploadSpeed: 10 }),
      ])
      rejectHistory(new Error('unavailable'))
    })

    await waitFor(() => expect(result.current.isLoading).toBe(false))
    expect(result.current.history.at(-1)?.down).toBe(100)
  })
})
