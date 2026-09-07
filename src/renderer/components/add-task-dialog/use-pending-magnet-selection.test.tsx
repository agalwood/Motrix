import '@renderer/lib/i18n'
import { toast } from '@renderer/components/ui/toast'
import { transport } from '@renderer/lib/transport'
import { Commands } from '@shared/protocol/commands'
import type { DownloadTask } from '@shared/types/task'
import { TaskStatus, TaskType } from '@shared/types/task'
import { makeDownloadTask } from '@test-utils/task'
import { act, renderHook, waitFor } from '@testing-library/react'
import { StrictMode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAddTaskDialogStore } from './use-add-task-dialog-store'
import { usePendingMagnetSelection } from './use-pending-magnet-selection'

const taskList = vi.hoisted(() => ({
  tasks: [] as DownloadTask[],
  hasReadySnapshot: true,
}))
vi.mock('@renderer/hooks/use-task-list', () => ({
  useTaskList: () => taskList,
}))
vi.mock('@renderer/lib/transport', () => ({ transport: { invoke: vi.fn() } }))
vi.mock('@renderer/components/ui/toast', () => ({ toast: { add: vi.fn() } }))

function displayedTaskId() {
  const prefill = useAddTaskDialogStore.getState().prefill
  return prefill?.tab === 'torrent' ? prefill.existingTaskId : undefined
}

function ready(id: string) {
  return makeDownloadTask({
    id,
    type: TaskType.Magnet,
    status: TaskStatus.MetadataReady,
  })
}

function result(taskId: string) {
  return {
    ok: true,
    selection: {
      taskId,
      magnetUri: `magnet:?xt=urn:btih:${'a'.repeat(40)}`,
      torrentBase64: 'dG9ycmVudA==',
      saveDir: '/downloads',
      meta: {
        name: taskId,
        infoHash: 'a'.repeat(40),
        totalSize: 10,
        comment: null,
        isPrivate: false,
        files: [{ index: 0, path: 'demo/a.txt', size: 10, extension: '.txt' }],
      },
    },
  }
}

beforeEach(() => {
  vi.stubGlobal('__MOTRIX_TARGET__', 'web')
  vi.clearAllMocks()
  taskList.tasks = []
  useAddTaskDialogStore.setState({
    open: false,
    prefill: undefined,
    revision: 0,
  })
  vi.mocked(transport.invoke).mockImplementation(async (_channel, taskId) =>
    result(String(taskId))
  )
})
afterEach(() => vi.unstubAllGlobals())

describe('pending magnet selection recovery', () => {
  it('closes a stale picker when a reconnect snapshot shows it already downloading', () => {
    taskList.tasks = [ready('restored')]
    useAddTaskDialogStore
      .getState()
      .openWith({ tab: 'torrent', existingTaskId: 'restored' })
    const { rerender } = renderHook(() => usePendingMagnetSelection())
    taskList.tasks = [{ ...ready('restored'), status: TaskStatus.Downloading }]
    rerender()
    expect(useAddTaskDialogStore.getState().open).toBe(false)
  })

  it('opens a restored task without receiving a selection event', async () => {
    taskList.tasks = [ready('restored')]
    renderHook(() => usePendingMagnetSelection())
    await waitFor(() =>
      expect(useAddTaskDialogStore.getState().open).toBe(true)
    )
    expect(transport.invoke).toHaveBeenCalledWith(
      Commands.ReopenMagnetFileSelection,
      'restored'
    )
    expect(useAddTaskDialogStore.getState().prefill).toMatchObject({
      existingTaskId: 'restored',
      tab: 'torrent',
      selectedFiles: [0],
      saveDir: '/downloads',
    })
  })

  it('recovers a ready task from a reconnect snapshot', async () => {
    taskList.tasks = [
      { ...ready('reconnected'), status: TaskStatus.FetchingMetadata },
    ]
    const { rerender } = renderHook(() => usePendingMagnetSelection())
    expect(transport.invoke).not.toHaveBeenCalled()
    taskList.tasks = [ready('reconnected')]
    rerender()
    await waitFor(() => expect(displayedTaskId()).toBe('reconnected'))
  })

  it('waits for the current form, then offers multiple tasks once each', async () => {
    useAddTaskDialogStore
      .getState()
      .openWith({ tab: 'links', urls: 'https://example.com/a' })
    taskList.tasks = [ready('one'), ready('two')]
    const { rerender } = renderHook(() => usePendingMagnetSelection())
    expect(transport.invoke).not.toHaveBeenCalled()
    act(() => useAddTaskDialogStore.getState().close())
    await waitFor(() => expect(displayedTaskId()).toBe('one'))
    act(() => useAddTaskDialogStore.getState().close())
    await waitFor(() => expect(displayedTaskId()).toBe('two'))
    act(() => useAddTaskDialogStore.getState().close())
    taskList.tasks = [...taskList.tasks]
    rerender()
    expect(useAddTaskDialogStore.getState().open).toBe(false)
    expect(transport.invoke).toHaveBeenCalledTimes(2)
  })

  it('does not let a delayed automatic response overwrite a newly opened form', async () => {
    let resolve!: (value: unknown) => void
    vi.mocked(transport.invoke).mockReturnValueOnce(
      new Promise((done) => {
        resolve = done
      })
    )
    taskList.tasks = [ready('slow')]
    renderHook(() => usePendingMagnetSelection())
    act(() =>
      useAddTaskDialogStore
        .getState()
        .openWith({ tab: 'links', urls: 'https://example.com/keep' })
    )
    await act(async () => resolve(result('slow')))
    expect(useAddTaskDialogStore.getState().prefill).toMatchObject({
      urls: 'https://example.com/keep',
    })
    act(() => useAddTaskDialogStore.getState().close())
    await waitFor(() => expect(displayedTaskId()).toBe('slow'))
  })

  it('ignores a response after the task leaves MetadataReady', async () => {
    let resolve!: (value: unknown) => void
    vi.mocked(transport.invoke).mockReturnValueOnce(
      new Promise((done) => {
        resolve = done
      })
    )
    taskList.tasks = [ready('removed')]
    const { rerender } = renderHook(() => usePendingMagnetSelection())
    taskList.tasks = []
    rerender()
    await act(async () => resolve(result('removed')))
    expect(useAddTaskDialogStore.getState().open).toBe(false)
  })

  it('reports a failed automatic open once and leaves manual recovery available', async () => {
    vi.mocked(transport.invoke).mockRejectedValue(
      new Error('Metadata unavailable')
    )
    taskList.tasks = [ready('missing')]
    const { rerender } = renderHook(() => usePendingMagnetSelection())
    await waitFor(() => expect(toast.add).toHaveBeenCalledTimes(1))
    taskList.tasks = [...taskList.tasks]
    rerender()
    expect(transport.invoke).toHaveBeenCalledTimes(1)
    expect(useAddTaskDialogStore.getState().open).toBe(false)
  })

  it('does not get stuck during StrictMode effect replay', async () => {
    taskList.tasks = [ready('strict')]
    renderHook(() => usePendingMagnetSelection(), { wrapper: StrictMode })
    await waitFor(() => expect(displayedTaskId()).toBe('strict'))
  })
})
