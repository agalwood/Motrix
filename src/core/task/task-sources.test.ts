import { ErrorCode } from '@shared/errors'
import {
  makeDefaultBtExtension,
  TaskInstancePhase,
  TaskKind,
  TaskStatus,
  TaskType,
  TransitionPhase,
} from '@shared/types/task'
import { makeDownloadTask } from '@test-utils/task'
import { describe, expect, it, vi } from 'vitest'
import { createTaskSourcesHandlers } from './task-sources'

function fixture(bt = false) {
  let task = makeDownloadTask({
    id: 'task',
    engineTaskId: 'gid',
    type: bt ? TaskType.Bt : TaskType.Http,
    kind: bt ? TaskKind.Bt : TaskKind.Direct,
    status: TaskStatus.Downloading,
    uris: bt
      ? [`magnet:?xt=urn:btih:${'1'.repeat(40)}`]
      : ['https://old.test/file'],
    ...(bt ? { bt: makeDefaultBtExtension() } : {}),
    downloadedBytes: 2048,
    progress: 0.5,
    instances: [
      {
        instanceId: 'instance',
        motrixId: 'task',
        gid: 'gid',
        phase: bt
          ? TaskInstancePhase.BtDownload
          : TaskInstancePhase.HttpDownload,
        status: TaskStatus.Downloading,
        progress: 50,
        totalBytes: 4096,
        downloadedBytes: 2048,
        uploadedBytes: 0,
        diskPath: '/downloads/file.motrix',
        transitionPhase: TransitionPhase.Idle,
        uris: ['https://old.test/file'],
        uriHash: null,
        payload: {},
        createdAt: 0,
        updatedAt: 0,
      },
    ],
  })
  let sources = ['https://old.test/file']
  const engine = {
    getTaskSources: vi.fn(async () => [...sources]),
    replaceTaskSources: vi.fn(async (_gid, _before, next) => {
      sources = [...next]
    }),
  }
  const persistTask = vi.fn(async () => {})
  const publishTaskUpdate = vi.fn()
  const authorizeTaskWrite = vi.fn(async () => {})
  let lane = Promise.resolve<unknown>(undefined)
  const handlers = createTaskSourcesHandlers({
    engine,
    persistTask,
    publishTaskUpdate,
    authorizeTaskWrite,
    taskManager: {
      getById: (id) => (id === task.id ? task : undefined),
      set: (_id, next) => {
        task = next
      },
    },
    runTaskMutation: (_ids, operation) => {
      const result = lane.then(operation)
      lane = result.catch(() => {})
      return result
    },
  })
  const update = (uris: string[], previous = ['https://old.test/file']) =>
    handlers.update({ taskId: 'task', engineTaskId: 'gid', previous, uris })
  return {
    handlers,
    update,
    engine,
    persistTask,
    publishTaskUpdate,
    authorizeTaskWrite,
    task: () => task,
    setTask: (next: typeof task) => {
      task = next
    },
  }
}

describe('task source editing', () => {
  it('updates HTTP replay sources without changing task identity or progress', async () => {
    const f = fixture()
    await f.update(['https://new.test/file', 'https://mirror.test/file'])
    expect(f.task()).toMatchObject({
      id: 'task',
      engineTaskId: 'gid',
      downloadedBytes: 2048,
      progress: 0.5,
      uris: ['https://new.test/file', 'https://mirror.test/file'],
    })
    expect(f.task().instances[0].uris).toEqual(f.task().uris)
    expect(f.persistTask).toHaveBeenCalledWith(f.task())
    expect(f.authorizeTaskWrite).toHaveBeenCalledOnce()
  })

  it('keeps magnet provenance separate and persists an explicit empty webseed override', async () => {
    const f = fixture(true)
    const original = f.task().uris
    await f.update([])
    expect(f.task().uris).toEqual(original)
    expect(f.task().bt?.webSeeds).toEqual([])
    expect(f.task().instances[0].payload.webSeeds).toEqual([])
  })

  it.each([
    { uris: [] },
    { uris: ['file:///etc/passwd'] },
    { uris: ['ftp://mirror.test/file'] },
    { uris: ['https://u:p@mirror.test/file'] },
  ])('rejects invalid HTTP sources $uris before dispatch', async ({ uris }) => {
    const f = fixture()
    await expect(f.update(uris)).rejects.toMatchObject({
      code: ErrorCode.TaskSourceInvalid,
    })
    expect(f.engine.replaceTaskSources).not.toHaveBeenCalled()
  })

  it('serializes edits and rejects an obsolete source snapshot', async () => {
    const f = fixture()
    const first = f.update(['https://one.test/file'])
    const second = f.update(['https://two.test/file'])
    await first
    await expect(second).rejects.toThrow('task.sources.changed')
    expect(f.engine.replaceTaskSources).toHaveBeenCalledOnce()
  })

  it('rechecks ownership after reading the engine', async () => {
    const f = fixture()
    f.engine.getTaskSources.mockImplementationOnce(async () => {
      f.setTask({ ...f.task(), engineTaskId: 'replacement' })
      return ['https://old.test/file']
    })
    await expect(f.update(['https://new.test/file'])).rejects.toThrow(
      'task.sources.changed'
    )
    expect(f.engine.replaceTaskSources).not.toHaveBeenCalled()
  })

  it.each([
    TaskStatus.FetchingMetadata,
    TaskStatus.MetadataReady,
    TaskStatus.Finalizing,
    TaskStatus.Completed,
    TaskStatus.Error,
    TaskStatus.Removed,
  ])('does not offer edits for %s', async (status) => {
    const f = fixture(true)
    f.setTask({ ...f.task(), status })
    expect(
      await f.handlers.get({ taskId: 'task', engineTaskId: 'gid' })
    ).toMatchObject({ editable: false })
    await expect(f.update([])).rejects.toThrow('task.sources.unavailable')
  })

  it('does not offer the metadata-only magnet no-op face', async () => {
    const f = fixture(true)
    f.setTask({ ...f.task(), type: TaskType.Magnet, status: TaskStatus.Paused })
    await expect(f.update([])).rejects.toThrow('task.sources.unavailable')
    expect(f.engine.getTaskSources).not.toHaveBeenCalled()
  })

  it('keeps acknowledged engine sources visible when host persistence fails', async () => {
    const f = fixture()
    f.persistTask.mockRejectedValueOnce(new Error('disk full'))
    await expect(f.update(['https://new.test/file'])).rejects.toThrow(
      'disk full'
    )
    expect(f.task().uris).toEqual(['https://new.test/file'])
    expect(f.publishTaskUpdate).toHaveBeenCalledOnce()
  })

  it('does not mutate sources when write authorization is refused', async () => {
    const f = fixture()
    f.authorizeTaskWrite.mockRejectedValueOnce(new Error('denied'))
    await expect(f.update(['https://new.test/file'])).rejects.toThrow('denied')
    expect(f.engine.replaceTaskSources).not.toHaveBeenCalled()
  })
})
