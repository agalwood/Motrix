import '@renderer/lib/i18n'
import {
  __resetTaskListStoreForTests,
  useTaskList,
} from '@renderer/hooks/use-task-list'
import { Events } from '@shared/protocol/events'
import { Queries } from '@shared/protocol/queries'
import { TaskStatus, TaskType } from '@shared/types/task'
import { makeDownloadTask } from '@test-utils/task'
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { useAddTaskDialogStore } from './use-add-task-dialog-store'
import { usePendingMagnetSelection } from './use-pending-magnet-selection'

const { transport, listeners, connections } = vi.hoisted(() => {
  const listeners = new Map<string, (...args: unknown[]) => void>()
  const connections = new Set<(event: { state: string }) => void>()
  return {
    listeners,
    connections,
    transport: {
      platform: 'web',
      invoke: vi.fn(),
      on: vi.fn((channel, listener) => listeners.set(channel, listener)),
      off: vi.fn((channel) => listeners.delete(channel)),
      onConnectionChange: vi.fn((listener) => {
        connections.add(listener)
        return () => connections.delete(listener)
      }),
    },
  }
})
vi.mock('@renderer/lib/transport', () => ({ transport }))

afterEach(() => {
  cleanup()
  __resetTaskListStoreForTests()
  useAddTaskDialogStore.getState().close()
  vi.clearAllMocks()
})

it('keeps a retry picker over old cache, connection edges and an older HTTP response, then settles on fresh data', async () => {
  const task = (status: TaskStatus) =>
    makeDownloadTask({ id: 'retry', type: TaskType.Magnet, status })
  transport.invoke.mockResolvedValueOnce([task(TaskStatus.Error)])
  const { result } = renderHook(() => {
    usePendingMagnetSelection()
    return useTaskList()
  })
  await act(async () => {})
  expect(result.current.status).toBe('ready')

  let finishOld!: (value: unknown) => void
  let finishFresh!: (value: unknown) => void
  transport.invoke
    .mockReturnValueOnce(
      new Promise((resolve) => {
        finishOld = resolve
      })
    )
    .mockReturnValueOnce(
      new Promise((resolve) => {
        finishFresh = resolve
      })
    )
  act(() => {
    void result.current.retry()
  })
  act(() =>
    useAddTaskDialogStore.getState().openWith({
      tab: 'torrent',
      existingTaskId: 'retry',
    })
  )
  expect(useAddTaskDialogStore.getState().open).toBe(true)
  act(() => {
    for (const state of ['connected', 'disconnected', 'connected'])
      for (const listener of connections) listener({ state })
  })
  expect(useAddTaskDialogStore.getState().open).toBe(true)
  await act(async () => finishOld([task(TaskStatus.Paused)]))
  expect(result.current.tasks[0].status).toBe(TaskStatus.Error)
  expect(useAddTaskDialogStore.getState().open).toBe(true)
  await act(async () => finishFresh([task(TaskStatus.MetadataReady)]))
  expect(useAddTaskDialogStore.getState().open).toBe(true)
  expect(transport.invoke.mock.calls).toEqual([
    [Queries.ListTasks],
    [Queries.ListTasks],
    [Queries.ListTasks],
  ])

  act(() => listeners.get(Events.TaskUpdated)?.([task(TaskStatus.Downloading)]))
  expect(useAddTaskDialogStore.getState().open).toBe(false)
})
