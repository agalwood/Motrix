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
})
