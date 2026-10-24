import { legacyHttpActivationSchema } from '@shared/schemas/legacy-http-activation'
import {
  TaskKind,
  TaskStatus,
  TaskType,
  TransitionPhase,
} from '@shared/types/task'
import { makeLegacyHttpTask } from '@test-utils/legacy-http-activation'
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

function pendingResumeTask() {
  const task = makeLegacyHttpTask({ status: TaskStatus.Downloading })
  task.instances[0].payload.legacyHttpActivation = {
    ...legacyHttpActivationSchema.parse(
      task.instances[0].payload.legacyHttpActivation
    ),
    stage: 'resume-uncertain',
    retainedContentDigest: 'a'.repeat(64),
  }
  return task
}

function harness(
  initial = true,
  finalizeLegacyHttp?: (taskId: string) => Promise<void>
) {
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
    finalizeLegacyHttp,
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
  const runTaskMutation = vi.spyOn(deps, 'runTaskMutation')
  return {
    ...deps,
    runTaskMutation,
    order,
    cleanup: new CompletedEngineTaskCleanup(deps),
  }
}

afterEach(() => vi.useRealTimers())

describe('CompletedEngineTaskCleanup', () => {
  it('retains completion observed before the first HTTP resume becomes durable', async () => {
    vi.useFakeTimers()
    const active = makeLegacyHttpTask({ status: TaskStatus.Downloading })
    const uncertain = pendingResumeTask()
    const finalize = vi.fn(async (taskId: string) => {
      h.taskManager.set(taskId, { ...active, status: TaskStatus.Completed })
    })
    const h = harness(false, finalize)
    h.taskManager.set(uncertain.id, uncertain)
    expect(h.taskManager.isEngineTaskIdRetired(uncertain.engineTaskId)).toBe(
      true
    )

    await expect(
      h.cleanup.observe({ ...uncertain, status: TaskStatus.Completed })
    ).resolves.toBe(true)
    await vi.advanceTimersByTimeAsync(1000)
    expect(finalize).not.toHaveBeenCalled()
    expect(h.taskManager.getById(active.id)?.status).toBe(
      TaskStatus.Downloading
    )

    h.taskManager.set(active.id, active)
    await vi.advanceTimersByTimeAsync(2000)

    expect(finalize).toHaveBeenCalledOnce()
    expect(h.taskManager.getById(active.id)?.status).toBe(TaskStatus.Completed)
    expect(h.adopt).not.toHaveBeenCalled()
    expect(h.adapter.forceRemoveTask).not.toHaveBeenCalled()
    expect(h.adapter.removeDownloadResult).not.toHaveBeenCalled()
    await h.cleanup.stopAndDrain()
  })

  it.each(['removed', 'taken over', 'still uncertain'])(
    'never finalizes a pending resume that is %s',
    async (state) => {
      vi.useFakeTimers()
      const uncertain = pendingResumeTask()
      const finalize = vi.fn(async () => {})
      const h = harness(false, finalize)
      h.taskManager.set(uncertain.id, uncertain)
      await h.cleanup.observe({ ...uncertain, status: TaskStatus.Completed })

      if (state === 'removed') h.taskManager.remove(uncertain.id)
      else if (state === 'taken over') {
        // Keep the old row too: its stale GID alone is insufficient ownership.
        h.taskManager.set(
          uncertain.id,
          makeLegacyHttpTask({ status: TaskStatus.Downloading })
        )
        const replacement = makeLegacyHttpTask({
          id: 'replacement-owner',
          status: TaskStatus.Downloading,
        })
        h.taskManager.set(replacement.id, replacement)
      }

      await vi.advanceTimersByTimeAsync(61000)

      expect(finalize).not.toHaveBeenCalled()
      expect(h.adopt).not.toHaveBeenCalled()
      expect(h.adapter.forceRemoveTask).not.toHaveBeenCalled()
      expect(h.adapter.removeDownloadResult).not.toHaveBeenCalled()
      await h.cleanup.stopAndDrain()
    }
  )

  it.each(['marker', 'digest', 'gid', 'path'])(
    'does not retain an invalid pending resume with a mismatched %s',
    async (field) => {
      const uncertain = pendingResumeTask()
      if (field === 'marker')
        uncertain.instances[0].payload.legacyImport = { version: 99 }
      else if (field === 'digest') {
        const activation = uncertain.instances[0].payload
          .legacyHttpActivation as Record<string, unknown>
        delete activation.retainedContentDigest
      } else if (field === 'gid')
        uncertain.instances[0].gid = 'aaaaaaaaaaaaaaaa'
      else uncertain.finalPath = '/original/other.bin'
      const finalize = vi.fn(async () => {})
      const h = harness(false, finalize)
      h.taskManager.set(uncertain.id, uncertain)

      expect(
        await h.cleanup.observe({ ...uncertain, status: TaskStatus.Completed })
      ).toBe(false)
      expect(finalize).not.toHaveBeenCalled()
      expect(h.adopt).not.toHaveBeenCalled()
      expect(h.adapter.removeDownloadResult).not.toHaveBeenCalled()
      await h.cleanup.stopAndDrain()
    }
  )

  it.each(['RPC unavailable', 'database busy'])(
    'retries an owned HTTP migration completion after %s without retiring its engine row',
    async (message) => {
      vi.useFakeTimers()
      const task = makeLegacyHttpTask({ status: TaskStatus.Downloading })
      const finalize = vi.fn(async (taskId: string) => {
        h.taskManager.set(
          taskId,
          makeLegacyHttpTask({ status: TaskStatus.Completed })
        )
      })
      const h = harness(false, finalize)
      h.taskManager.set(task.id, task)
      finalize.mockRejectedValueOnce(new Error(message))
      const snapshot = { ...task, status: TaskStatus.Completed }

      await expect(h.cleanup.observe(snapshot)).resolves.toBe(true)
      expect(h.taskManager.getById(task.id)?.status).toBe(
        TaskStatus.Downloading
      )
      expect(finalize).toHaveBeenCalledOnce()
      await vi.advanceTimersByTimeAsync(999)
      expect(finalize).toHaveBeenCalledOnce()
      await vi.advanceTimersByTimeAsync(1)

      expect(finalize).toHaveBeenCalledTimes(2)
      expect(h.taskManager.getById(task.id)?.status).toBe(TaskStatus.Completed)
      await h.cleanup.observe(snapshot)
      expect(finalize).toHaveBeenCalledTimes(2)
      expect(h.persist).not.toHaveBeenCalled()
      expect(h.adopt).not.toHaveBeenCalled()
      expect(h.adapter.forceRemoveTask).not.toHaveBeenCalled()
      expect(h.adapter.removeDownloadResult).not.toHaveBeenCalled()
      await h.cleanup.stopAndDrain()
    }
  )

  it.each(['removed', 'replaced', 'quarantined', 'error'])(
    'rechecks migration ownership under the mutation lock before retrying a %s owner',
    async (change) => {
      vi.useFakeTimers()
      const task = makeLegacyHttpTask({ status: TaskStatus.Downloading })
      const finalize = vi.fn().mockRejectedValue(new Error('RPC unavailable'))
      const h = harness(false, finalize)
      h.taskManager.set(task.id, task)
      await h.cleanup.observe({ ...task, status: TaskStatus.Completed })
      h.runTaskMutation.mockImplementationOnce(async (_ids, operation) => {
        if (change === 'removed') h.taskManager.remove(task.id)
        else if (change === 'replaced') {
          h.taskManager.set(
            task.id,
            makeLegacyHttpTask({ engineTaskId: 'aaaaaaaaaaaaaaaa' })
          )
        } else if (change === 'quarantined') {
          const quarantined = makeLegacyHttpTask()
          quarantined.instances[0].payload.legacyImport = { version: 99 }
          h.taskManager.set(task.id, quarantined)
        } else {
          h.taskManager.set(
            task.id,
            makeLegacyHttpTask({ status: TaskStatus.Error })
          )
        }
        return operation()
      })

      await vi.advanceTimersByTimeAsync(60000)

      expect(finalize).toHaveBeenCalledOnce()
      expect(h.adapter.forceRemoveTask).not.toHaveBeenCalled()
      expect(h.adapter.removeDownloadResult).not.toHaveBeenCalled()
      await h.cleanup.stopAndDrain()
    }
  )

  it('does not adopt an ownerless migration or run it without its verified finalizer', async () => {
    const task = makeLegacyHttpTask({ status: TaskStatus.Completed })
    const finalize = vi.fn(async () => {})
    const ownerless = harness(false, finalize)
    expect(await ownerless.cleanup.observe(task)).toBe(false)
    expect(finalize).not.toHaveBeenCalled()
    expect(ownerless.adopt).not.toHaveBeenCalled()
    const unsupported = harness(false)
    unsupported.taskManager.set(task.id, task)
    expect(await unsupported.cleanup.observe(task)).toBe(false)
    expect(unsupported.adapter.removeDownloadResult).not.toHaveBeenCalled()
    await ownerless.cleanup.stopAndDrain()
    await unsupported.cleanup.stopAndDrain()
  })

  it('backs off an unconfirmed migration completion while preserving its owner', async () => {
    vi.useFakeTimers()
    const task = makeLegacyHttpTask({ status: TaskStatus.Downloading })
    const finalize = vi.fn(async () => {})
    const h = harness(false, finalize)
    h.taskManager.set(task.id, task)
    await h.cleanup.observe({ ...task, status: TaskStatus.Completed })

    await vi.advanceTimersByTimeAsync(61000)
    expect(finalize).toHaveBeenCalledTimes(7)
    await vi.advanceTimersByTimeAsync(29999)
    expect(finalize).toHaveBeenCalledTimes(7)
    await vi.advanceTimersByTimeAsync(1)
    expect(finalize).toHaveBeenCalledTimes(8)
    expect(h.taskManager.getById(task.id)?.status).toBe(TaskStatus.Downloading)
    expect(h.adapter.removeDownloadResult).not.toHaveBeenCalled()

    await h.cleanup.stopAndDrain()
    await vi.advanceTimersByTimeAsync(60000)
    expect(finalize).toHaveBeenCalledTimes(8)
  })

  it('drains migration finalization and cancels its pending retry on shutdown', async () => {
    vi.useFakeTimers()
    const task = makeLegacyHttpTask({ status: TaskStatus.Downloading })
    let reject!: (error: Error) => void
    const finalize = vi.fn(
      () =>
        new Promise<void>((_resolve, fail) => {
          reject = fail
        })
    )
    const h = harness(false, finalize)
    h.taskManager.set(task.id, task)
    const observed = h.cleanup.observe({
      ...task,
      status: TaskStatus.Completed,
    })
    let drained = false
    const drain = h.cleanup.stopAndDrain().then(() => {
      drained = true
    })
    await Promise.resolve()
    expect(drained).toBe(false)
    reject(new Error('RPC unavailable'))
    await Promise.all([observed, drain])
    await vi.advanceTimersByTimeAsync(60000)
    expect(drained).toBe(true)
    expect(finalize).toHaveBeenCalledOnce()
  })

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
