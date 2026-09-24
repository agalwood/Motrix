import {
  TaskKind,
  TaskStatus,
  TaskType,
  TransitionPhase,
} from '@shared/types/task'
import { makeDownloadTask } from '@test-utils/task'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CompletedEngineTaskCleanup } from './completed-engine-task-cleanup'
import { TaskManager } from './task-manager'

const output = (overrides = {}) =>
  makeDownloadTask({
    diskPath: '/downloads/file.zip',
    finalPath: '/downloads/file.zip',
    status: TaskStatus.Completed,
    finishedAt: 1234,
    totalBytes: 100,
    downloadedBytes: 100,
    ...overrides,
  })

function harness(initial = true) {
  const taskManager = new TaskManager()
  if (initial)
    taskManager.set(
      'task-1',
      output({ status: TaskStatus.Downloading, finishedAt: null })
    )
  const order: string[] = []
  const deps = {
    taskManager,
    mintTaskId: () => 'adopted-task',
    persist: vi.fn(async () => {
      order.push('persist')
    }),
    adopt: vi.fn(async (_task: unknown, persist: () => Promise<void>) => {
      await persist()
    }),
    publish: vi.fn(() => {
      order.push('publish')
    }),
    dispatch: vi.fn(async () => {
      order.push('dispatch')
    }),
    prepareFiles: vi.fn(async () => {
      order.push('files')
    }),
    adapter: {
      forceRemoveTask: vi.fn(async () => {
        order.push('stop')
      }),
      removeDownloadResult: vi.fn(async () => {
        order.push('purge')
      }),
    },
    runTaskMutation: async <T>(_ids: readonly string[], fn: () => Promise<T>) =>
      fn(),
    log: { warn: vi.fn() },
  }
  return { ...deps, order, cleanup: new CompletedEngineTaskCleanup(deps) }
}

afterEach(() => vi.useRealTimers())

describe('CompletedEngineTaskCleanup', () => {
  it('persists final-path completion and files before purging the engine', async () => {
    const h = harness()
    expect(await h.cleanup.observe(output())).toBe(true)
    expect(h.order).toEqual([
      'persist',
      'publish',
      'dispatch',
      'files',
      'purge',
    ])
    expect(h.persist).toHaveBeenCalledWith(
      expect.objectContaining({ status: TaskStatus.Completed, progress: 1 }),
      expect.objectContaining({ toStatus: TaskStatus.Completed })
    )
    expect(h.taskManager.getById('task-1')?.finishedAt).toBe(1234)
    await h.cleanup.stopAndDrain()
  })

  it('adopts a tiny download first observed complete before cleaning it', async () => {
    const h = harness(false)
    await h.cleanup.observe(output())
    expect(h.adopt).toHaveBeenCalledOnce()
    expect(h.taskManager.getById('adopted-task')?.status).toBe(
      TaskStatus.Completed
    )
    expect(h.adapter.removeDownloadResult).toHaveBeenCalledWith('gid-1')
    await h.cleanup.stopAndDrain()
  })

  it('retries a failed durable completion without another engine notification', async () => {
    vi.useFakeTimers()
    const h = harness()
    h.persist.mockRejectedValueOnce(new Error('database busy'))
    await h.cleanup.observe(output())
    expect(h.taskManager.getById('task-1')?.status).toBe(TaskStatus.Downloading)
    expect(h.taskManager.getById('task-1')?.instances[0]?.status).not.toBe(
      TaskStatus.Completed
    )
    expect(h.adapter.removeDownloadResult).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1000)
    expect(h.taskManager.getById('task-1')?.status).toBe(TaskStatus.Completed)
    expect(h.adapter.removeDownloadResult).toHaveBeenCalledOnce()
    await h.cleanup.stopAndDrain()
  })

  it('coalesces concurrent completion snapshots while persistence is pending', async () => {
    const h = harness(false)
    let release!: () => void
    h.persist.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          release = resolve
        })
    )
    const first = h.cleanup.observe(output())
    const second = h.cleanup.observe(output({ finishedAt: 9999 }))
    release()
    await Promise.all([first, second])
    expect(h.persist).toHaveBeenCalledOnce()
    expect(h.adopt).toHaveBeenCalledOnce()
    expect(h.dispatch).toHaveBeenCalledOnce()
    expect(h.adapter.removeDownloadResult).toHaveBeenCalledOnce()
    expect(h.taskManager.getById('adopted-task')?.finishedAt).toBe(1234)
    await h.cleanup.stopAndDrain()
  })

  it('retries failed cleanup without changing the completion or notifying twice', async () => {
    vi.useFakeTimers()
    const h = harness()
    h.adapter.removeDownloadResult.mockRejectedValueOnce(
      new Error('RPC offline')
    )
    await h.cleanup.observe(output())
    await vi.advanceTimersByTimeAsync(1000)
    await h.cleanup.observe(output({ finishedAt: 9999 }))
    expect(h.adapter.removeDownloadResult).toHaveBeenCalledTimes(2)
    expect(h.persist).toHaveBeenCalledOnce()
    expect(h.dispatch).toHaveBeenCalledOnce()
    expect(h.taskManager.getById('task-1')?.finishedAt).toBe(1234)
    await h.cleanup.stopAndDrain()
  })

  it('stops a resurrected exact GID while preserving completed history', async () => {
    const h = harness()
    h.taskManager.set('task-1', output())
    await h.cleanup.observe(
      output({
        status: TaskStatus.Downloading,
        finishedAt: null,
        downloadedBytes: 1,
      })
    )
    expect(h.order).toEqual(['files', 'stop', 'purge'])
    expect(h.taskManager.getById('task-1')?.downloadedBytes).toBe(100)
    expect(h.persist).not.toHaveBeenCalled()
    expect(h.dispatch).not.toHaveBeenCalled()
    await h.cleanup.stopAndDrain()
  })

  it('does not purge a replacement task after a failed cleanup', async () => {
    vi.useFakeTimers()
    const h = harness()
    h.adapter.removeDownloadResult.mockRejectedValueOnce(new Error('busy'))
    await h.cleanup.observe(output())
    h.taskManager.set(
      'task-1',
      output({ engineTaskId: 'new-gid', status: TaskStatus.Downloading })
    )
    await vi.advanceTimersByTimeAsync(1000)
    expect(h.adapter.removeDownloadResult).toHaveBeenCalledTimes(1)
    await h.cleanup.stopAndDrain()
  })

  it.each([
    { diskPath: '/downloads/file.zip.motrix' },
    { transitionPhase: TransitionPhase.Renaming },
    { kind: TaskKind.Hls },
    { type: TaskType.Bt },
    { type: TaskType.Magnet },
    { diskPath: '', finalPath: '' },
  ])(
    'leaves application-owned finalization and other workflows alone: %o',
    async (overrides) => {
      const h = harness()
      h.taskManager.set(
        'task-1',
        output({ status: TaskStatus.Downloading, ...overrides })
      )
      expect(await h.cleanup.observe(output(overrides))).toBe(false)
      expect(h.persist).not.toHaveBeenCalled()
      expect(h.adapter.removeDownloadResult).not.toHaveBeenCalled()
      await h.cleanup.stopAndDrain()
    }
  )

  it('cancels scheduled retries when stopping', async () => {
    vi.useFakeTimers()
    const h = harness()
    h.persist.mockRejectedValue(new Error('busy'))
    await h.cleanup.observe(output())
    await h.cleanup.stopAndDrain()
    await vi.advanceTimersByTimeAsync(60000)
    expect(h.persist).toHaveBeenCalledOnce()
  })
})
