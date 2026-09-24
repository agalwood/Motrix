import { AppError } from '@shared/errors'
import { Events } from '@shared/protocol/events'
import { TaskStatus, TaskType, TransitionPhase } from '@shared/types/task'
import { describe, expect, it, vi } from 'vitest'
import {
  createSetSelectedFilesHandler,
  formatRange,
} from './set-selected-files'

const mkTask = () => ({
  id: 't1',
  engineTaskId: 'gid1',
  status: TaskStatus.Paused,
  type: TaskType.Bt,
  name: 'x',
  progress: 0,
  totalBytes: 0,
  downloadedBytes: 0,
  downloadSpeed: 0,
  uploadSpeed: 0,
  etaSeconds: 0,
  saveDir: '',
  createdAt: 0,
  updatedAt: 0,
  finishedAt: null,
  errorMessage: null,
  uris: [],
  uploadedBytes: 0,
  uploadedBytesBaseline: 0,
  fileCount: 2,
  connections: 0,
  infoHash: null,
  errorCode: null,
  metadataProgress: 0,
  priority: 0,
  category: null,
  dlLimit: 0,
  ulLimit: 0,
  filename: '',
  sizeWhenDone: 0,
  diskPath: '',
  finalPath: '',
  finalName: '',
  transitionPhase: TransitionPhase.Idle,
  torrentMetaPath: null,
  bt: {
    selectedFiles: [0],
    peers: 0,
    seeds: 0,
    ratio: 0,
    trackers: [],
    peersInSwarm: 0,
    seedsInSwarm: 0,
    announceList: [],
    comment: null,
    isPrivate: false,
    magnetUri: null,
    sequentialDownload: false,
  },
})

describe('setSelectedFiles handler', () => {
  it('rejects empty selection', async () => {
    const handler = createSetSelectedFilesHandler({
      taskManager: { getById: vi.fn(), set: vi.fn() },
      engine: { changeOption: vi.fn(), getTaskFiles: vi.fn() },
    } as unknown as Parameters<typeof createSetSelectedFilesHandler>[0])
    await expect(handler({ taskId: 't1', indices: [] })).rejects.toThrow(
      AppError
    )
  })

  it('happy path: changeOption -> getTaskFiles -> replaceTaskFiles -> set -> emit', async () => {
    const taskManager = {
      getById: vi.fn(() => mkTask()),
      set: vi.fn(),
    }
    const engine = {
      changeOption: vi.fn(async () => undefined),
      getTaskFiles: vi.fn(async () => [
        { index: 0, path: 'a', size: 1, completedBytes: 0, selected: true },
        { index: 1, path: 'b', size: 2, completedBytes: 0, selected: true },
      ]),
    }
    const db = { replaceTaskFiles: vi.fn() }
    const eventBus = { emit: vi.fn() }
    const runTaskMutation = vi.fn(
      async (_taskIds: readonly string[], operation: () => Promise<unknown>) =>
        operation()
    )
    const handler = createSetSelectedFilesHandler({
      taskManager,
      engine,
      db,
      eventBus,
      runTaskMutation,
    } as unknown as Parameters<typeof createSetSelectedFilesHandler>[0])
    await handler({ taskId: 't1', indices: [0, 1] })

    expect(runTaskMutation).toHaveBeenCalledWith(['t1'], expect.any(Function))
    expect(engine.changeOption).toHaveBeenCalledWith('gid1', {
      'select-file': '1,2',
    })
    expect(engine.getTaskFiles).toHaveBeenCalledWith('gid1')
    expect(db.replaceTaskFiles).toHaveBeenCalledWith('t1', [
      { fileIndex: 0, path: 'a', size: 1, selected: true },
      { fileIndex: 1, path: 'b', size: 2, selected: true },
    ])
    expect(taskManager.set).toHaveBeenCalledWith(
      't1',
      expect.objectContaining({
        bt: expect.objectContaining({ selectedFiles: [0, 1] }),
      })
    )
    expect(eventBus.emit).toHaveBeenCalledWith(Events.TaskFilesUpdated, {
      taskId: 't1',
    })
  })

  it('rejects non-integer and duplicate indices before entering the task lock', async () => {
    const runTaskMutation = vi.fn()
    const handler = createSetSelectedFilesHandler({
      taskManager: { getById: vi.fn(), set: vi.fn() },
      engine: { changeOption: vi.fn(), getTaskFiles: vi.fn() },
      db: { replaceTaskFiles: vi.fn() },
      eventBus: { emit: vi.fn() },
      runTaskMutation,
    })

    await expect(
      handler({ taskId: 't1', indices: [0, 0] })
    ).rejects.toBeInstanceOf(AppError)
    await expect(
      handler({ taskId: 't1', indices: [0.5] })
    ).rejects.toBeInstanceOf(AppError)
    expect(runTaskMutation).not.toHaveBeenCalled()
  })

  it('changeOption failure: no db write, no emit, error rethrown', async () => {
    const taskManager = { getById: vi.fn(() => mkTask()), set: vi.fn() }
    const engine = {
      changeOption: vi.fn(async () => {
        throw new Error('rpc fail')
      }),
      getTaskFiles: vi.fn(),
    }
    const db = { replaceTaskFiles: vi.fn() }
    const eventBus = { emit: vi.fn() }
    const handler = createSetSelectedFilesHandler({
      taskManager,
      engine,
      db,
      eventBus,
      runTaskMutation: async (
        _taskIds: readonly string[],
        operation: () => Promise<unknown>
      ) => operation(),
    } as unknown as Parameters<typeof createSetSelectedFilesHandler>[0])
    await expect(handler({ taskId: 't1', indices: [0] })).rejects.toThrow()
    expect(db.replaceTaskFiles).not.toHaveBeenCalled()
    expect(eventBus.emit).not.toHaveBeenCalled()
  })
})

describe('formatRange', () => {
  it('formats consecutive indices into ranges', () => {
    expect(formatRange([0, 1])).toBe('1,2')
    expect(formatRange([0, 2, 3, 4, 7])).toBe('1,3-5,8')
    expect(formatRange([5])).toBe('6')
    expect(formatRange([])).toBe('')
  })

  it('sorts unsorted input before formatting', () => {
    expect(formatRange([7, 0, 4, 3, 2])).toBe('1,3-5,8')
  })
})
