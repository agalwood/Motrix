import {
  type DownloadTask,
  TaskStatus,
  TransitionPhase,
} from '@shared/types/task'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CompletionShutdownController } from './completion-shutdown-controller'

function task(
  id: string,
  status = TaskStatus.Downloading,
  transitionPhase = TransitionPhase.Idle
): DownloadTask {
  return { id, status, transitionPhase } as DownloadTask
}

function fixture(initial = [task('one')]) {
  let tasks = initial
  const lease = {
    drain: vi.fn(async () => {}),
    hasIncomingWork: vi.fn(() => false),
    release: vi.fn(),
  }
  const deps = {
    supported: true,
    getTasks: () => tasks,
    isReady: vi.fn(() => true),
    probe: vi.fn(async () => {}),
    prepare: vi.fn(() => lease),
    save: vi.fn(async () => {}),
    requestShutdown: vi.fn(async () => {}),
    onState: vi.fn(),
    onError: vi.fn(),
  }
  const controller = new CompletionShutdownController(deps)
  return {
    controller,
    deps,
    lease,
    setTasks: (next: DownloadTask[]) => {
      tasks = next
      controller.evaluate()
    },
  }
}

describe('CompletionShutdownController', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('retains tasks that finish while authorization is pending', async () => {
    const f = fixture()
    const authorization = Promise.withResolvers<void>()
    f.deps.probe.mockReturnValue(authorization.promise)
    const enabling = f.controller.setEnabled(true)
    f.setTasks([task('one', TaskStatus.Completed)])
    authorization.resolve()
    await enabling
    await vi.advanceTimersByTimeAsync(60_000)
    expect(f.deps.requestShutdown).toHaveBeenCalledOnce()
    f.controller.dispose()
  })

  it('tracks new tasks even if their first published snapshot is already completed', async () => {
    const f = fixture([])
    await f.controller.setEnabled(true)
    f.setTasks([task('new', TaskStatus.Completed)])
    await vi.advanceTimersByTimeAsync(60_000)
    expect(f.deps.requestShutdown).toHaveBeenCalledOnce()
    f.controller.dispose()
  })

  it('does not treat restored completed history as newly finished work', async () => {
    const f = fixture([])
    f.deps.isReady.mockReturnValue(false)
    const authorization = Promise.withResolvers<void>()
    f.deps.probe.mockReturnValue(authorization.promise)
    const enabling = f.controller.setEnabled(true)
    f.setTasks([task('restored', TaskStatus.Completed)])
    f.deps.isReady.mockReturnValue(true)
    authorization.resolve()
    await enabling
    await vi.advanceTimersByTimeAsync(90_000)
    expect(f.deps.requestShutdown).not.toHaveBeenCalled()
    f.controller.dispose()
  })

  it('cancels authorization when an enrolled task is removed', async () => {
    const f = fixture()
    const authorization = Promise.withResolvers<void>()
    f.deps.probe.mockReturnValue(authorization.promise)
    const enabling = f.controller.setEnabled(true)
    f.setTasks([])
    authorization.resolve()
    await enabling
    await vi.advanceTimersByTimeAsync(90_000)
    expect(f.controller.getState().phase).toBe('off')
    expect(f.deps.requestShutdown).not.toHaveBeenCalled()
    f.controller.dispose()
  })

  it('checks clock jumps on task events before the interval can run', async () => {
    const f = fixture()
    await f.controller.setEnabled(true)
    f.setTasks([task('one', TaskStatus.Completed)])
    await vi.advanceTimersByTimeAsync(1_000)
    vi.setSystemTime(Date.now() + 3_600_000)
    f.controller.evaluate()
    await vi.advanceTimersByTimeAsync(59_000)
    expect(f.deps.requestShutdown).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1_000)
    expect(f.deps.requestShutdown).toHaveBeenCalledOnce()
    f.controller.dispose()
  })

  it('invalidates preparation if the clock jumps while saving', async () => {
    const f = fixture()
    f.deps.save.mockImplementation(async () => {
      vi.setSystemTime(Date.now() + 3_600_000)
    })
    await f.controller.setEnabled(true)
    f.setTasks([task('one', TaskStatus.Completed)])
    await vi.advanceTimersByTimeAsync(60_000)
    expect(f.deps.requestShutdown).not.toHaveBeenCalled()
    expect(f.controller.getState().phase).toBe('waiting')
    f.controller.dispose()
  })

  it('does not allow a cancelled save to execute or release a newer preparation', async () => {
    const f = fixture()
    const newLease = { ...f.lease, release: vi.fn() }
    f.deps.prepare.mockReturnValueOnce(f.lease).mockReturnValueOnce(newLease)
    const oldSave = Promise.withResolvers<void>()
    const newSave = Promise.withResolvers<void>()
    f.deps.save
      .mockReturnValueOnce(oldSave.promise)
      .mockReturnValueOnce(newSave.promise)
    await f.controller.setEnabled(true)
    f.setTasks([task('one', TaskStatus.Seeding)])
    await vi.advanceTimersByTimeAsync(60_000)
    f.controller.cancel()
    await f.controller.setEnabled(true)
    await vi.advanceTimersByTimeAsync(60_000)
    oldSave.resolve()
    await vi.advanceTimersByTimeAsync(0)
    expect(f.deps.requestShutdown).not.toHaveBeenCalled()
    expect(newLease.release).not.toHaveBeenCalled()
    newSave.resolve()
    await vi.advanceTimersByTimeAsync(0)
    expect(f.deps.requestShutdown).toHaveBeenCalledOnce()
    expect(newLease.release).toHaveBeenCalledOnce()
    f.controller.dispose()
  })

  it('restarts the grace period for newly observed work that already completed', async () => {
    const f = fixture()
    await f.controller.setEnabled(true)
    f.setTasks([task('one', TaskStatus.Completed)])
    await vi.advanceTimersByTimeAsync(59_000)
    f.setTasks([
      task('one', TaskStatus.Completed),
      task('two', TaskStatus.Completed),
    ])
    await vi.advanceTimersByTimeAsync(59_000)
    expect(f.deps.requestShutdown).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1_000)
    expect(f.deps.requestShutdown).toHaveBeenCalledOnce()
    f.controller.dispose()
  })

  it.each(['event', 'snapshot'] as const)(
    'invalidates a save when new completed work is observed by %s',
    async (delivery) => {
      const f = fixture()
      f.deps.save.mockImplementationOnce(async () => {
        const tasks = [
          task('one', TaskStatus.Completed),
          task('two', TaskStatus.Completed),
        ]
        if (delivery === 'event') f.setTasks(tasks)
        else f.deps.getTasks = () => tasks
      })
      await f.controller.setEnabled(true)
      f.setTasks([task('one', TaskStatus.Completed)])
      await vi.advanceTimersByTimeAsync(60_000)
      expect(f.deps.requestShutdown).not.toHaveBeenCalled()
      expect(f.controller.getState().phase).toBe('waiting')
      f.controller.dispose()
    }
  )

  it('cancels preparation when an existing task becomes unfinished even if it completes again before save returns', async () => {
    const f = fixture()
    f.deps.save.mockImplementationOnce(async () => {
      f.setTasks([task('one', TaskStatus.Downloading)])
      f.setTasks([task('one', TaskStatus.Completed)])
    })
    await f.controller.setEnabled(true)
    f.setTasks([task('one', TaskStatus.Completed)])
    await vi.advanceTimersByTimeAsync(60_000)
    expect(f.deps.requestShutdown).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(f.deps.requestShutdown).toHaveBeenCalledOnce()
    f.controller.dispose()
  })

  it('waits for file finalization, saves before shutdown, and submits only once', async () => {
    const f = fixture()
    await f.controller.setEnabled(true)
    f.setTasks([task('one', TaskStatus.Finalizing, TransitionPhase.Renaming)])
    await vi.advanceTimersByTimeAsync(70_000)
    expect(f.deps.requestShutdown).not.toHaveBeenCalled()
    f.setTasks([task('one', TaskStatus.Completed)])
    await vi.advanceTimersByTimeAsync(59_000)
    expect(f.deps.requestShutdown).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1_000)
    expect(f.deps.save).toHaveBeenCalledOnce()
    expect(f.deps.requestShutdown).toHaveBeenCalledOnce()
    expect(f.deps.save.mock.invocationCallOrder[0]).toBeLessThan(
      f.deps.requestShutdown.mock.invocationCallOrder[0]
    )
    await vi.advanceTimersByTimeAsync(90_000)
    f.controller.evaluate()
    expect(f.deps.requestShutdown).toHaveBeenCalledOnce()
    expect(f.lease.release).toHaveBeenCalledOnce()
  })

  it.each([
    TaskStatus.Paused,
    TaskStatus.Error,
    TaskStatus.Queued,
    TaskStatus.MetadataReady,
    TaskStatus.FetchingMetadata,
  ])('does not treat %s as completion', async (status) => {
    const f = fixture([task('one', status)])
    await f.controller.setEnabled(true)
    await vi.advanceTimersByTimeAsync(90_000)
    expect(f.controller.getState().phase).toBe('waiting')
    expect(f.deps.requestShutdown).not.toHaveBeenCalled()
  })

  it.each([{ tasks: [] }, { tasks: [task('old', TaskStatus.Completed)] }])(
    'does not shut down an empty or historical queue',
    async ({ tasks }) => {
      const f = fixture(tasks)
      await f.controller.setEnabled(true)
      await vi.advanceTimersByTimeAsync(90_000)
      expect(f.deps.requestShutdown).not.toHaveBeenCalled()
    }
  )

  it('cancels when participating tasks are removed', async () => {
    const f = fixture()
    await f.controller.setEnabled(true)
    f.setTasks([])
    await vi.advanceTimersByTimeAsync(90_000)
    expect(f.controller.getState().phase).toBe('off')
    expect(f.deps.requestShutdown).not.toHaveBeenCalled()
  })

  it('restarts the full countdown after a new task completes', async () => {
    const f = fixture()
    await f.controller.setEnabled(true)
    f.setTasks([task('one', TaskStatus.Completed)])
    await vi.advanceTimersByTimeAsync(50_000)
    f.setTasks([task('one', TaskStatus.Completed), task('two')])
    expect(f.controller.getState().phase).toBe('waiting')
    f.setTasks([
      task('one', TaskStatus.Completed),
      task('two', TaskStatus.Completed),
    ])
    await vi.advanceTimersByTimeAsync(59_000)
    expect(f.deps.requestShutdown).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1_000)
    expect(f.deps.requestShutdown).toHaveBeenCalledOnce()
  })

  it('allows finalized seeding and blocks reseeding transitions', async () => {
    const f = fixture([
      task('one', TaskStatus.Seeding, TransitionPhase.Reseeding),
    ])
    await f.controller.setEnabled(true)
    expect(f.controller.getState().phase).toBe('waiting')
    f.setTasks([task('one', TaskStatus.Seeding)])
    await vi.advanceTimersByTimeAsync(60_000)
    expect(f.deps.requestShutdown).toHaveBeenCalledOnce()
  })

  it('cancels while an asynchronous save is in flight', async () => {
    const f = fixture()
    let resolve!: () => void
    f.deps.save.mockImplementation(
      () =>
        new Promise<void>((done) => {
          resolve = done
        })
    )
    await f.controller.setEnabled(true)
    f.setTasks([task('one', TaskStatus.Completed)])
    await vi.advanceTimersByTimeAsync(60_000)
    await f.controller.setEnabled(false)
    resolve()
    await vi.advanceTimersByTimeAsync(1_000)
    expect(f.deps.requestShutdown).not.toHaveBeenCalled()
    expect(f.controller.getState().phase).toBe('off')
  })

  it('does not execute after incoming work, persistence failure, or engine loss', async () => {
    for (const cause of ['incoming', 'save', 'engine'] as const) {
      const f = fixture()
      f.deps.save.mockImplementation(async () => {
        if (cause === 'incoming') f.lease.hasIncomingWork.mockReturnValue(true)
        if (cause === 'engine') f.deps.isReady.mockReturnValue(false)
        if (cause === 'save') throw new Error('disk full')
      })
      await f.controller.setEnabled(true)
      f.setTasks([task('one', TaskStatus.Completed)])
      await vi.advanceTimersByTimeAsync(60_000)
      expect(f.deps.requestShutdown).not.toHaveBeenCalled()
      expect(f.lease.release).toHaveBeenCalled()
      f.controller.dispose()
    }
  })

  it('times out preparation without letting its late continuation submit shutdown', async () => {
    const f = fixture()
    let resolve!: () => void
    f.lease.drain.mockImplementation(
      () =>
        new Promise<void>((done) => {
          resolve = done
        })
    )
    await f.controller.setEnabled(true)
    f.setTasks([task('one', TaskStatus.Completed)])
    await vi.advanceTimersByTimeAsync(70_000)
    expect(f.controller.getState().phase).toBe('failed')
    resolve()
    await vi.advanceTimersByTimeAsync(1_000)
    expect(f.deps.save).not.toHaveBeenCalled()
    expect(f.deps.requestShutdown).not.toHaveBeenCalled()
  })

  it('cancels pending authorization and never arms after disposal', async () => {
    const f = fixture()
    let resolve!: () => void
    f.deps.probe.mockImplementation(
      () =>
        new Promise<void>((done) => {
          resolve = done
        })
    )
    const enabling = f.controller.setEnabled(true)
    f.controller.dispose()
    resolve()
    await enabling
    expect(f.controller.getState().phase).toBe('off')
    expect(vi.getTimerCount()).toBe(0)
  })

  it('resets the countdown after a sleep or wall-clock discontinuity', async () => {
    const f = fixture([task('one', TaskStatus.Seeding)])
    await f.controller.setEnabled(true)
    await vi.advanceTimersByTimeAsync(50_000)
    vi.setSystemTime(Date.now() + 3600_000)
    await vi.advanceTimersByTimeAsync(1_000)
    expect(f.controller.getState().deadline).toBe(Date.now() + 60_000)
    expect(f.deps.requestShutdown).not.toHaveBeenCalled()
    f.controller.interrupt()
    expect(f.controller.getState().phase).toBe('waiting')
  })

  it('reports platform rejection without retrying automatically', async () => {
    const f = fixture([task('one', TaskStatus.Seeding)])
    f.deps.requestShutdown.mockRejectedValue(new Error('permission denied'))
    await f.controller.setEnabled(true)
    await vi.advanceTimersByTimeAsync(120_000)
    expect(f.controller.getState().phase).toBe('failed')
    expect(f.deps.requestShutdown).toHaveBeenCalledOnce()
  })
})
