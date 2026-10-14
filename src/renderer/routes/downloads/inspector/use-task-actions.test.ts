import type { DownloadTask } from '@shared/types/task'
import {
  TaskInstancePhase,
  TaskKind,
  TaskStatus,
  TaskType,
  TransitionPhase,
} from '@shared/types/task'
import { makeDownloadTask } from '@test-utils/task'
import { renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@renderer/lib/transport', () => ({
  transport: { invoke: vi.fn().mockResolvedValue({ ok: true }) },
}))
vi.mock('@renderer/lib/open-add-task-dialog', () => ({
  openAddTaskDialog: vi.fn().mockResolvedValue(undefined),
}))
const { toastAddMock } = vi.hoisted(() => ({ toastAddMock: vi.fn() }))
vi.mock('@renderer/components/ui/toast', () => ({
  toast: { add: toastAddMock, close: vi.fn() },
}))

import '@renderer/lib/i18n'
import { openAddTaskDialog } from '@renderer/lib/open-add-task-dialog'
import { transport } from '@renderer/lib/transport'
import { Commands } from '@shared/protocol/commands'
import { Queries } from '@shared/protocol/queries'
import { useRedownloadOverwriteStore } from './redownload-overwrite-store'
import { useTaskActions } from './use-task-actions'

// Kept overrides: id:'t1' (≠ 'task-1'), name:'sample' (≠ 'task'),
// saveDir:'/tmp' (≠ ''), uris:['http://example.com/x'] (≠ []),
// fileCount:1 (≠ 0), filename:'sample' (≠ ''),
// diskPath:'/tmp/sample' (≠ ''), finalPath:'/tmp/sample' (≠ ''),
// finalName:'sample' (≠ '').
// Dropped: engineTaskId:'gid-1' (= default), kind:Direct (= default),
// type:Http (= default), status:Downloading (= default), all-zero/null/empty.
/** A retryable Error task: only BT-with-sidecar clears the capability gate
 *  now that HTTP/FTP inputs are known to be unreplayable. */
function makeRetryableErrorTask(
  overrides: Partial<DownloadTask> = {}
): DownloadTask {
  return makeTask({
    status: TaskStatus.Error,
    type: TaskType.Bt,
    torrentMetaPath: '/sidecar/x.torrent',
    ...overrides,
  })
}

function makeTask(overrides: Partial<DownloadTask> = {}): DownloadTask {
  return makeDownloadTask({
    id: 't1',
    name: 'sample',
    saveDir: '/tmp',
    uris: ['http://example.com/x'],
    fileCount: 1,
    filename: 'sample',
    diskPath: '/tmp/sample',
    finalPath: '/tmp/sample',
    finalName: 'sample',
    ...overrides,
  })
}

function makeRetryableMagnetMetadataTask(id: string): DownloadTask {
  return makeTask({
    id,
    status: TaskStatus.Error,
    kind: TaskKind.Bt,
    type: TaskType.Magnet,
    torrentMetaPath: null,
    instances: [
      {
        instanceId: `meta:${id}`,
        motrixId: id,
        gid: `gid-${id}`,
        phase: TaskInstancePhase.MagnetMetadataResolution,
        status: TaskStatus.Error,
        progress: 0,
        totalBytes: 0,
        downloadedBytes: 0,
        uploadedBytes: 0,
        diskPath: '/tmp/metadata',
        transitionPhase: TransitionPhase.Idle,
        uris: ['magnet:?xt=urn:btih:timeout'],
        uriHash: null,
        payload: {},
        createdAt: 1,
        updatedAt: 2,
      },
    ],
  })
}

describe('useTaskActions', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('counts pause-eligible tasks correctly', () => {
    const tasks = [
      makeTask({ id: 'a', status: TaskStatus.Downloading }),
      makeTask({ id: 'b', status: TaskStatus.Paused }),
      makeTask({ id: 'c', status: TaskStatus.Seeding, type: TaskType.Bt }),
    ]
    const { result } = renderHook(() => useTaskActions(tasks))
    expect(result.current.pauseCount).toBe(2) // a + c
    expect(result.current.resumeCount).toBe(1) // b
    expect(result.current.removeCount).toBe(3)
    expect(result.current.total).toBe(3)
  })

  it('onPause filters to canPause subset', async () => {
    const tasks = [
      makeTask({ id: 'a', status: TaskStatus.Downloading }),
      makeTask({ id: 'b', status: TaskStatus.Paused }),
    ]
    const { result } = renderHook(() => useTaskActions(tasks))
    await result.current.onPause()
    expect(transport.invoke).toHaveBeenCalledTimes(1)
    expect(transport.invoke).toHaveBeenCalledWith(Commands.PauseTasks, ['a'])
  })

  it('reports per-task failures from the plural command result', async () => {
    const tasks = [
      makeTask({ id: 'a', status: TaskStatus.Downloading }),
      makeTask({ id: 'b', name: 'broken', status: TaskStatus.Downloading }),
    ]
    ;(transport.invoke as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      succeeded: ['a'],
      failed: [{ taskId: 'b', reason: 'engine rejected' }],
    })
    const { result } = renderHook(() => useTaskActions(tasks))
    await result.current.onPause()
    expect(toastAddMock).toHaveBeenCalledTimes(1)
    expect(toastAddMock).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'error' })
    )
  })

  it('treats a whole-command rejection as every target failing', async () => {
    const tasks = [
      makeTask({ id: 'a', status: TaskStatus.Downloading }),
      makeTask({ id: 'b', status: TaskStatus.Downloading }),
    ]
    ;(transport.invoke as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error('transport down')
    )
    const { result } = renderHook(() => useTaskActions(tasks))
    await result.current.onPause()
    expect(toastAddMock).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'warning' })
    )
  })

  it('onRetry({ alt: true }) on single fetches options + opens dialog', async () => {
    const tasks = [makeRetryableErrorTask({ id: 'e' })]
    ;(transport.invoke as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      dir: '/x',
      header: ['User-Agent: F'],
    })
    const { result } = renderHook(() => useTaskActions(tasks))
    await result.current.onRetry({ alt: true })
    expect(transport.invoke).toHaveBeenCalledWith(
      Queries.GetEngineTaskOptions,
      'gid-1'
    )
    expect(openAddTaskDialog).toHaveBeenCalled()
  })

  it.each([false, true])(
    'retries finalization directly with alt=%s',
    async (alt) => {
      const task = makeTask({
        id: 'finalize-failed',
        status: TaskStatus.Error,
        transitionPhase: TransitionPhase.Renaming,
      })
      const { result } = renderHook(() => useTaskActions([task]))
      expect(result.current.retryCount).toBe(1)
      await result.current.onRetry({ alt })
      expect(transport.invoke).toHaveBeenCalledExactlyOnceWith(
        Commands.RetryTasks,
        [task.id]
      )
      expect(openAddTaskDialog).not.toHaveBeenCalled()
    }
  )

  it('onRetry({ alt: true }) on multi falls back to generic RetryTasks', async () => {
    const tasks = [
      makeRetryableErrorTask({ id: 'a' }),
      makeRetryableErrorTask({ id: 'b' }),
    ]
    const { result } = renderHook(() => useTaskActions(tasks))
    await result.current.onRetry({ alt: true })
    expect(openAddTaskDialog).not.toHaveBeenCalled()
    expect(transport.invoke).toHaveBeenCalledWith(Commands.RetryTasks, [
      'a',
      'b',
    ])
  })

  it('routes magnet metadata Retry directly even when Alt is pressed', async () => {
    const tasks = [makeRetryableMagnetMetadataTask('magnet-timeout')]
    const { result } = renderHook(() => useTaskActions(tasks))

    await result.current.onRetry({ alt: true })

    expect(openAddTaskDialog).not.toHaveBeenCalled()
    expect(transport.invoke).toHaveBeenCalledWith(Commands.RetryTasks, [
      'magnet-timeout',
    ])
  })

  it('retryCount counts only tasks whose engine inputs can be rebuilt', () => {
    const tasks = [
      // Never rebuildable: no single re-addable engine handle.
      makeTask({ id: 'm', status: TaskStatus.Error, kind: TaskKind.Mux }),
      // Not rebuildable either: headers/cookies/referer/proxy/out are not
      // persisted, so the uris alone are not the original request.
      makeTask({ id: 'h', status: TaskStatus.Error }),
      makeRetryableErrorTask({ id: 'e' }),
      makeRetryableMagnetMetadataTask('magnet'),
    ]
    const { result } = renderHook(() => useTaskActions(tasks))
    expect(result.current.retryCount).toBe(2) // sidecar BT + metadata magnet
  })

  it('onRetry() dispatches nothing for a Mux-kind Error task', async () => {
    const tasks = [
      makeTask({ id: 'm', status: TaskStatus.Error, kind: TaskKind.Mux }),
    ]
    const { result } = renderHook(() => useTaskActions(tasks))
    await result.current.onRetry()
    expect(transport.invoke).not.toHaveBeenCalled()
  })

  it('onRemove does not dispatch directly', () => {
    const tasks = [makeTask({ id: 'a', status: TaskStatus.Downloading })]
    const { result } = renderHook(() => useTaskActions(tasks))
    result.current.onRemove({ shift: false })
    expect(transport.invoke).not.toHaveBeenCalled()
  })

  it('correctly counts redownload-eligible completed tasks', () => {
    const tasks = [
      makeTask({ id: 'a', status: TaskStatus.Completed }),
      makeTask({ id: 'b', status: TaskStatus.Downloading }),
      makeTask({ id: 'c', status: TaskStatus.Error }),
      makeTask({ id: 'd', status: TaskStatus.Completed, kind: TaskKind.Mux }),
    ]
    const { result } = renderHook(() => useTaskActions(tasks))
    expect(result.current.redownloadCount).toBe(1) // Only task a is eligible.
  })

  it('onRedownload({ alt: true }) opens dialog with prefilled parameters', async () => {
    const task = makeTask({ id: 'comp', status: TaskStatus.Completed })
    ;(transport.invoke as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      dir: '/downloads',
      header: ['Cookie: session=123'],
    })
    const { result } = renderHook(() => useTaskActions([task]))
    await result.current.onRedownload({ alt: true })

    expect(transport.invoke).toHaveBeenCalledWith(
      Queries.GetEngineTaskOptions,
      'gid-1'
    )
    expect(openAddTaskDialog).toHaveBeenCalledWith(
      expect.objectContaining({
        tab: 'links',
        cookie: 'session=123',
        saveDir: '/downloads',
      })
    )
  })

  it('onRedownload opens overwrite confirm dialog when output file exists', async () => {
    const task = makeTask({ id: 'comp', status: TaskStatus.Completed })
    ;(transport.invoke as ReturnType<typeof vi.fn>).mockImplementation(
      async (channel) => {
        if (channel === Queries.CheckTaskFileExists) {
          return { exists: true }
        }
        return { ok: true }
      }
    )
    const { result } = renderHook(() => useTaskActions([task]))
    await result.current.onRedownload({ alt: false })

    expect(transport.invoke).toHaveBeenCalledWith(Queries.CheckTaskFileExists, {
      taskId: 'comp',
    })
    expect(useRedownloadOverwriteStore.getState().open).toBe(true)
    expect(useRedownloadOverwriteStore.getState().target?.id).toBe('comp')
    expect(transport.invoke).not.toHaveBeenCalledWith(
      Commands.CreateTask,
      expect.anything()
    )

    // The user confirms re-downloading in the dialog.
    await result.current.confirmRedownloadOverwrite()
    expect(transport.invoke).toHaveBeenCalledWith(
      Commands.CreateTask,
      expect.objectContaining({
        uris: ['http://example.com/x'],
      })
    )
    expect(useRedownloadOverwriteStore.getState().open).toBe(false)
  })

  it.each(['direct', 'confirm', 'edit'])(
    'uses the saved directory when engine options are unavailable: %s',
    async (mode) => {
      const task = makeTask({ status: TaskStatus.Completed })
      vi.mocked(transport.invoke).mockImplementation(async (channel) => {
        if (channel === Queries.CheckTaskFileExists) {
          return { exists: mode === 'confirm' }
        }
        if (channel === Queries.GetEngineTaskOptions) return null
        return { ok: true }
      })
      const { result } = renderHook(() => useTaskActions([task]))

      await result.current.onRedownload({ alt: mode === 'edit' })
      if (mode === 'confirm') {
        await result.current.confirmRedownloadOverwrite()
      }

      const expected = expect.objectContaining({
        saveDir: '/tmp',
        filename: 'sample',
      })
      if (mode === 'edit') {
        expect(openAddTaskDialog).toHaveBeenCalledWith(expected)
      } else {
        expect(transport.invoke).toHaveBeenCalledWith(
          Commands.CreateTask,
          expected
        )
      }
    }
  )

  it('onRedownload directly creates task when output file does not exist', async () => {
    const task = makeTask({ id: 'comp', status: TaskStatus.Completed })
    ;(transport.invoke as ReturnType<typeof vi.fn>).mockImplementation(
      async (channel) => {
        if (channel === Queries.CheckTaskFileExists) {
          return { exists: false }
        }
        return { ok: true }
      }
    )
    const { result } = renderHook(() => useTaskActions([task]))
    await result.current.onRedownload({ alt: false })

    expect(transport.invoke).toHaveBeenCalledWith(Queries.CheckTaskFileExists, {
      taskId: 'comp',
    })
    expect(useRedownloadOverwriteStore.getState().open).toBe(false)
    expect(transport.invoke).toHaveBeenCalledWith(
      Commands.CreateTask,
      expect.objectContaining({
        uris: ['http://example.com/x'],
      })
    )
  })

  it('onRedownload warns and falls back to dialog if original credentials expired', async () => {
    // This task requires credentials and cannot be replayed from its URI alone.
    const task = makeTask({
      id: 'comp-cred',
      status: TaskStatus.Completed,
      instances: [
        {
          instanceId: 'inst-1',
          motrixId: 'comp-cred',
          gid: 'gid-cred',
          phase: TaskInstancePhase.HttpDownload,
          status: TaskStatus.Completed,
          progress: 100,
          totalBytes: 1000,
          downloadedBytes: 1000,
          uploadedBytes: 0,
          diskPath: '/tmp/sample',
          transitionPhase: TransitionPhase.Idle,
          uris: ['http://example.com/file'],
          uriHash: null,
          payload: {
            directReplay: {
              version: 1,
              requestModifiers: ['cookies'],
              replayability: 'requires-credentials',
            },
          },
          createdAt: 1,
          updatedAt: 2,
        },
      ],
    })

    ;(transport.invoke as ReturnType<typeof vi.fn>).mockImplementation(
      async (channel) => {
        if (channel === Queries.CheckTaskFileExists) {
          return { exists: false }
        }
        if (channel === Queries.GetEngineTaskOptions) {
          return null // Simulate an engine restart or expired credentials.
        }
        return { ok: true }
      }
    )

    const { result } = renderHook(() => useTaskActions([task]))
    await result.current.onRedownload({ alt: false })

    expect(toastAddMock).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'warning',
      })
    )
    expect(openAddTaskDialog).toHaveBeenCalled()
    expect(transport.invoke).not.toHaveBeenCalledWith(
      Commands.CreateTask,
      expect.anything()
    )
  })
})
