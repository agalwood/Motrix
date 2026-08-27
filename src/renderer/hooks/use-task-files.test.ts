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
  transportMock.invoke.mockResolvedValue([
    { index: 0, path: 'a', size: 1, completedBytes: 0, selected: true },
  ])
})

afterEach(() => {
  vi.clearAllMocks()
})

describe('useTaskFiles', () => {
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

  it('refetches live files when the matching task updates', async () => {
    renderHook(() => useTaskFiles('t1', true))
    await waitFor(() => expect(transportMock.invoke).toHaveBeenCalledTimes(1))
    expect(transportMock.on).toHaveBeenCalledWith(
      Events.TaskUpdated,
      expect.any(Function)
    )

    act(() => {
      listeners.get(Events.TaskUpdated)?.forEach((cb) => {
        cb([{ id: 't1' }])
      })
    })

    await waitFor(() => expect(transportMock.invoke).toHaveBeenCalledTimes(2))
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
    expect(transportMock.off).toHaveBeenCalledWith(
      Events.TaskUpdated,
      expect.any(Function)
    )
  })
})
