import { useOperatorSession } from '@renderer/lib/operator-auth'
import { transport } from '@renderer/lib/transport'
import { useDownloadsSelection } from '@renderer/routes/downloads/store'
import { CommandIds } from '@shared/commands-catalog'
import { Events } from '@shared/protocol/events'
import { TaskStatus } from '@shared/types/task'
import { makeDownloadTask } from '@test-utils/task'
import { act, renderHook } from '@testing-library/react'
import { useSyncExternalStore } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import {
  captureTaskMenuIntent,
  menuActionEnabled,
  menuContextPatch,
  menuContextSignature,
  registerDownloadsMenuContext,
  selectAllDownloads,
  selectedMenuTasks,
  startMenuConnection,
  subscribeMenuContext,
  validTaskMenuIntent,
} from './task-context'

const mocks = vi.hoisted(() => ({
  snapshot: { tasks: [] as unknown[], status: 'ready', hasReadySnapshot: true },
  listeners: new Set<() => void>(),
}))
vi.mock('@renderer/hooks/use-task-list', () => ({
  getTaskListSnapshot: () => mocks.snapshot,
  subscribeTaskList: (fn: () => void) => {
    mocks.listeners.add(fn)
    return () => mocks.listeners.delete(fn)
  },
}))
vi.mock('@renderer/lib/transport', () => ({
  transport: {
    platform: 'web',
    getConnectionState: vi.fn(() => 'connected'),
    invoke: vi.fn().mockResolvedValue({ state: 'ready' }),
    on: vi.fn(),
    off: vi.fn(),
  },
}))
let dispose: () => void
let connection: () => void
beforeEach(async () => {
  vi.mocked(transport.getConnectionState!).mockReturnValue('connected')
  vi.mocked(transport.invoke).mockResolvedValue({ state: 'ready' })
  mocks.snapshot = { tasks: [], status: 'ready', hasReadySnapshot: true }
  useDownloadsSelection.getState().setItems([])
  useOperatorSession.setState({ state: 'authenticated' })
  dispose = registerDownloadsMenuContext(vi.fn(), 'all')
  connection = startMenuConnection()
  await Promise.resolve()
})
afterEach(() => {
  dispose()
  connection()
  vi.useRealTimers()
})

it('keeps task actions available through HTTP when the event stream is disconnected', async () => {
  connection()
  vi.useFakeTimers()
  vi.mocked(transport.getConnectionState!).mockReturnValue('disconnected')
  mocks.snapshot.tasks = [makeDownloadTask({ status: TaskStatus.Downloading })]
  connection = startMenuConnection()
  await Promise.resolve()
  expect(menuActionEnabled(CommandIds.TaskPauseAll)).toBe(true)

  vi.mocked(transport.invoke).mockRejectedValueOnce(new Error('offline'))
  await vi.advanceTimersByTimeAsync(5_000)
  expect(menuActionEnabled(CommandIds.TaskPauseAll)).toBe(false)
  await vi.advanceTimersByTimeAsync(5_000)
  expect(menuActionEnabled(CommandIds.TaskPauseAll)).toBe(true)
})

it('accepts a newer engine event while the initial HTTP observation is still pending', async () => {
  connection()
  let resolve!: (value: unknown) => void
  vi.mocked(transport.invoke).mockReturnValueOnce(
    new Promise((done) => {
      resolve = done
    })
  )
  mocks.snapshot.tasks = [makeDownloadTask({ status: TaskStatus.Downloading })]
  connection = startMenuConnection()
  const onEngine = vi
    .mocked(transport.on)
    .mock.calls.findLast(
      ([channel]) => channel === Events.EngineStateChanged
    )?.[1]
  onEngine?.('ready')
  expect(menuActionEnabled(CommandIds.TaskPauseAll)).toBe(true)
  resolve({ state: 'stopped' })
  await Promise.resolve()
  expect(menuActionEnabled(CommandIds.TaskPauseAll)).toBe(true)
})
it('freezes only committed selection and cancels when selection changes', () => {
  const tasks = [
    makeDownloadTask({ id: 'one', status: TaskStatus.Paused }),
    makeDownloadTask({ id: 'two', status: TaskStatus.Downloading }),
  ]
  mocks.snapshot.tasks = tasks
  useDownloadsSelection.getState().setItems(tasks)
  useDownloadsSelection.getState().select('one')
  const intent = captureTaskMenuIntent()
  expect(menuActionEnabled(CommandIds.TaskResume, intent)).toBe(true)
  expect(selectedMenuTasks(intent).map((task) => task.id)).toEqual(['one'])
  useDownloadsSelection.getState().select('two')
  expect(validTaskMenuIntent(intent)).toBe(false)
  expect(menuActionEnabled(CommandIds.TaskResume, intent)).toBe(false)
})
it('selects all filtered tasks including virtual offscreen items and excludes Finalizing from remove', () => {
  const tasks = Array.from({ length: 10_000 }, (_, index) =>
    makeDownloadTask({ id: String(index), status: TaskStatus.Finalizing })
  )
  mocks.snapshot.tasks = tasks
  useDownloadsSelection.getState().setItems(tasks.slice(0, 500))
  selectAllDownloads()
  expect(captureTaskMenuIntent().ids).toHaveLength(500)
  expect(menuActionEnabled(CommandIds.TaskDelete)).toBe(false)
})
it('keeps local actions available while a fresh task snapshot is unavailable', () => {
  mocks.snapshot.status = 'loading'
  expect(menuActionEnabled(CommandIds.TaskNew)).toBe(true)
  expect(menuActionEnabled(CommandIds.TaskPauseAll)).toBe(false)
})
it('keeps global transfers available for tasks outside the filtered selection', () => {
  const completed = makeDownloadTask({
    id: 'completed',
    status: TaskStatus.Completed,
  })
  mocks.snapshot.tasks = [
    completed,
    makeDownloadTask({ id: 'active', status: TaskStatus.Downloading }),
    makeDownloadTask({ id: 'paused', status: TaskStatus.Paused }),
  ]
  useDownloadsSelection.getState().setItems([completed])
  useDownloadsSelection.getState().select(completed.id)
  expect(menuActionEnabled(CommandIds.TaskPause)).toBe(false)
  expect(menuActionEnabled(CommandIds.TaskResume)).toBe(false)
  expect(menuActionEnabled(CommandIds.TaskPauseAll)).toBe(true)
  expect(menuActionEnabled(CommandIds.TaskResumeAll)).toBe(true)
  useOperatorSession.setState({ state: 'locked' })
  expect(menuActionEnabled(CommandIds.TaskPauseAll)).toBe(false)
  expect(menuActionEnabled(CommandIds.TaskResumeAll)).toBe(false)
})
it('does not commit menu renders for progress-only updates in a 10,000 task list', () => {
  const tasks = Array.from({ length: 10_000 }, (_, index) =>
    makeDownloadTask({ id: String(index), status: TaskStatus.Downloading })
  )
  mocks.snapshot.tasks = tasks
  useDownloadsSelection.getState().setItems(tasks)
  useDownloadsSelection.getState().select('1')
  const intent = captureTaskMenuIntent()
  let renders = 0
  renderHook(() => {
    useSyncExternalStore(subscribeMenuContext, () =>
      menuContextSignature(intent)
    )
    renders++
  })
  const baseline = renders
  for (let tick = 0; tick < 10; tick++)
    act(() => {
      mocks.snapshot.tasks = tasks.map((task) => ({
        ...task,
        downloadedBytes: tick * 100,
      }))
      for (const listener of mocks.listeners) listener()
    })
  expect(renders).toBe(baseline)
})

it('keeps the primary native task aligned with the filtered list order', () => {
  const one = makeDownloadTask({ id: 'one', status: TaskStatus.Paused })
  const two = makeDownloadTask({ id: 'two', status: TaskStatus.Downloading })
  mocks.snapshot.tasks = [one, two]
  useDownloadsSelection.getState().setItems([two, one])
  selectAllDownloads()
  expect(menuContextPatch()).toMatchObject({
    selectedTaskId: 'two',
    selectedTaskStatus: TaskStatus.Downloading,
    selectedTaskIds: ['two', 'one'],
  })
})
