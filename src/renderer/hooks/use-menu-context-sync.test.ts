import { Commands } from '@shared/protocol/commands'
import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const hookState = vi.hoisted(() => ({
  task: null as { id: string; status: string } | null,
  atTop: false,
  atBottom: false,
  hasAnyActive: false,
  hasAnyPaused: false,
  hasStopped: false,
  route: '/downloads',
}))

const transportMock = vi.hoisted(() => ({
  invoke: vi.fn(),
}))

vi.mock('@renderer/lib/transport', () => ({
  transport: transportMock,
}))

vi.mock('./use-selected-task', () => ({
  useSelectedTask: () => ({
    task: hookState.task,
    atTop: hookState.atTop,
    atBottom: hookState.atBottom,
  }),
}))

vi.mock('./use-task-list', () => ({
  useTaskList: () => ({
    hasAnyActive: hookState.hasAnyActive,
    hasAnyPaused: hookState.hasAnyPaused,
    hasStopped: hookState.hasStopped,
  }),
}))

vi.mock('./use-current-route', () => ({
  useCurrentRoute: () => hookState.route,
}))

import { useMenuContextSync } from './use-menu-context-sync'

interface Deferred<T = void> {
  promise: Promise<T>
  resolve(value: T): void
  reject(reason?: unknown): void
}

function deferred<T = void>(): Deferred<T> {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

function fullContext(overrides: Record<string, unknown> = {}) {
  return {
    selectedTaskId: null,
    selectedTaskStatus: null,
    selectedTaskAtTop: false,
    selectedTaskAtBottom: false,
    hasAnyActiveTask: false,
    hasAnyPausedTask: false,
    hasStoppedTasks: false,
    currentRoute: '/downloads',
    ...overrides,
  }
}

beforeEach(() => {
  hookState.task = null
  hookState.atTop = false
  hookState.atBottom = false
  hookState.hasAnyActive = false
  hookState.hasAnyPaused = false
  hookState.hasStopped = false
  hookState.route = '/downloads'
  transportMock.invoke.mockReset()
})

afterEach(() => {
  vi.useRealTimers()
  vi.clearAllMocks()
})

describe('useMenuContextSync', () => {
  it('serializes writes and sends only the latest desired state after each acknowledgement', async () => {
    const first = deferred()
    const second = deferred()
    transportMock.invoke
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise)
      .mockResolvedValue(undefined)

    const { rerender } = renderHook(() => useMenuContextSync())

    expect(transportMock.invoke).toHaveBeenCalledTimes(1)
    expect(transportMock.invoke).toHaveBeenNthCalledWith(
      1,
      Commands.UpdateMenuContext,
      fullContext()
    )

    hookState.hasAnyActive = true
    hookState.route = '/settings'
    rerender()
    hookState.hasAnyPaused = true
    hookState.route = '/activity'
    rerender()

    expect(transportMock.invoke).toHaveBeenCalledTimes(1)

    await act(async () => {
      first.resolve()
      await first.promise
    })

    expect(transportMock.invoke).toHaveBeenCalledTimes(2)
    expect(transportMock.invoke).toHaveBeenNthCalledWith(
      2,
      Commands.UpdateMenuContext,
      {
        hasAnyActiveTask: true,
        hasAnyPausedTask: true,
        currentRoute: '/activity',
      }
    )

    hookState.hasStopped = true
    rerender()
    expect(transportMock.invoke).toHaveBeenCalledTimes(2)

    await act(async () => {
      second.resolve()
      await second.promise
    })

    expect(transportMock.invoke).toHaveBeenCalledTimes(3)
    expect(transportMock.invoke).toHaveBeenNthCalledWith(
      3,
      Commands.UpdateMenuContext,
      { hasStoppedTasks: true }
    )

    await act(async () => {
      await Promise.resolve()
    })
    rerender()
    expect(transportMock.invoke).toHaveBeenCalledTimes(3)
  })

  it('retries failures every 500ms from the acknowledged state to the latest desired state', async () => {
    vi.useFakeTimers()
    const first = deferred()
    const second = deferred()
    const third = deferred()
    transportMock.invoke
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise)
      .mockReturnValueOnce(third.promise)

    const { rerender } = renderHook(() => useMenuContextSync())

    await act(async () => {
      first.reject(new Error('preload is not ready'))
      await Promise.resolve()
    })

    hookState.task = { id: 'task-1', status: 'downloading' }
    hookState.atTop = true
    hookState.hasAnyActive = true
    hookState.route = '/activity'
    rerender()

    await act(async () => {
      await vi.advanceTimersByTimeAsync(499)
    })
    expect(transportMock.invoke).toHaveBeenCalledTimes(1)

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1)
    })
    expect(transportMock.invoke).toHaveBeenCalledTimes(2)
    expect(transportMock.invoke).toHaveBeenNthCalledWith(
      2,
      Commands.UpdateMenuContext,
      fullContext({
        selectedTaskId: 'task-1',
        selectedTaskStatus: 'downloading',
        selectedTaskAtTop: true,
        hasAnyActiveTask: true,
        currentRoute: '/activity',
      })
    )

    await act(async () => {
      second.reject(new Error('main process is still unavailable'))
      await Promise.resolve()
      await vi.advanceTimersByTimeAsync(500)
    })

    expect(transportMock.invoke).toHaveBeenCalledTimes(3)
    expect(transportMock.invoke).toHaveBeenNthCalledWith(
      3,
      Commands.UpdateMenuContext,
      fullContext({
        selectedTaskId: 'task-1',
        selectedTaskStatus: 'downloading',
        selectedTaskAtTop: true,
        hasAnyActiveTask: true,
        currentRoute: '/activity',
      })
    )

    await act(async () => {
      third.resolve()
      await third.promise
      await vi.advanceTimersByTimeAsync(2_000)
    })
    expect(transportMock.invoke).toHaveBeenCalledTimes(3)
  })

  it('clears a scheduled retry when unmounted', async () => {
    vi.useFakeTimers()
    transportMock.invoke.mockRejectedValue(new Error('not ready'))

    const { unmount } = renderHook(() => useMenuContextSync())
    await act(async () => {
      await Promise.resolve()
    })
    expect(transportMock.invoke).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(1)

    unmount()
    expect(vi.getTimerCount()).toBe(0)

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000)
    })
    expect(transportMock.invoke).toHaveBeenCalledTimes(1)
  })

  it('does not retry or acknowledge a request that settles after unmount', async () => {
    vi.useFakeTimers()
    const request = deferred()
    transportMock.invoke.mockReturnValue(request.promise)

    const { unmount } = renderHook(() => useMenuContextSync())
    expect(transportMock.invoke).toHaveBeenCalledTimes(1)

    unmount()
    await act(async () => {
      request.reject(new Error('late failure'))
      await Promise.resolve()
      await vi.advanceTimersByTimeAsync(2_000)
    })

    expect(transportMock.invoke).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(0)
  })
})
