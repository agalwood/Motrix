import path from 'node:path'
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
import {
  getBtDirectStorageLayout,
  parseBtFileLayout,
} from './bt-storage-layout'
import { createRenameTaskFileHandler } from './rename-task-file'
import { TaskManager } from './task-manager'

function fixture(single = false) {
  const task = makeDownloadTask({
    id: 'task',
    engineTaskId: 'gid',
    type: TaskType.Bt,
    kind: TaskKind.Bt,
    status: TaskStatus.Paused,
    finalPath: single ? '/downloads/a.bin' : '/downloads/root',
    diskPath: single ? '/downloads/a.bin' : '/downloads/root',
    saveDir: '/downloads',
    bt: makeDefaultBtExtension(),
    infoHash: '1'.repeat(40),
    downloadedBytes: 37,
  })
  task.instances = [
    {
      instanceId: 'instance',
      motrixId: task.id,
      gid: task.engineTaskId,
      phase: TaskInstancePhase.BtDownload,
      status: task.status,
      progress: 0,
      totalBytes: 100,
      downloadedBytes: 37,
      uploadedBytes: 0,
      diskPath: task.diskPath,
      transitionPhase: TransitionPhase.Idle,
      uris: [],
      uriHash: null,
      createdAt: 1,
      updatedAt: 1,
      payload: {
        btStorageLayout: {
          version: 2,
          strategy: 'direct',
          torrentRootName: 'original',
          multiFile: !single,
          finalized: false,
        },
      },
    },
  ]
  const manager = new TaskManager()
  manager.set(task.id, task)
  let files = [
    {
      index: 0,
      path: single ? task.finalPath : path.join(task.finalPath, 'a.bin'),
      size: 100,
      selected: true,
      completedBytes: 37,
    },
  ]
  const persist = vi.fn(async () => {})
  const authorize = vi.fn(async () => {})
  const engine = {
    getTaskFiles: vi.fn(async () => files),
    renameTaskFile: vi.fn(
      async (_gid: string, index: number, _old: string, target: string) => {
        expect(persist).toHaveBeenCalled()
        expect(
          getBtDirectStorageLayout(manager.getById(task.id)!)?.filePaths?.[
            index
          ]
        ).toBe('a.bin')
        files = files.map((file) =>
          file.index === index ? { ...file, path: target } : file
        )
        return files
      }
    ),
  }
  const changed = vi.fn()
  const run = createRenameTaskFileHandler({
    nativeFileMutation: async (_taskId, operation) => operation(),
    taskManager: manager,
    engine,
    runTaskMutation: async (_ids, op) => op(),
    persistTask: persist,
    persistTaskFiles: persist,
    authorizeTaskWrite: authorize,
    publishFiles: changed,
    publishTaskUpdate: vi.fn(),
  })
  const request = {
    taskId: task.id,
    engineTaskId: task.engineTaskId,
    fileIndex: 0,
    expectedName: 'a.bin',
    name: 'renamed.bin',
  }
  return { task, manager, engine, persist, authorize, changed, run, request }
}

describe('native task file rename', () => {
  it.each([false, true])(
    'commits observed paths and preserves identity/progress (single=%s)',
    async (single) => {
      const f = fixture(single)
      await f.run(f.request)
      const task = f.manager.getById(f.task.id)!
      expect(task.engineTaskId).toBe('gid')
      expect(task.downloadedBytes).toBe(37)
      expect(task.infoHash).toBe('1'.repeat(40))
      expect(getBtDirectStorageLayout(task)?.filePaths).toEqual({
        0: 'renamed.bin',
      })
      expect(task.finalPath).toBe(
        single ? '/downloads/renamed.bin' : '/downloads/root'
      )
      expect(task.storageOperation).toBeUndefined()
      expect(f.changed).toHaveBeenCalledWith(task.id)
    }
  )
  it.each(['../escape', '/absolute', 'CON.txt', 'trailing.', 'bad/name'])(
    'rejects invalid filename %s before engine mutation',
    async (name) => {
      const f = fixture()
      await expect(f.run({ ...f.request, name })).rejects.toThrow(
        'task.fileRename.invalid'
      )
      expect(f.engine.renameTaskFile).not.toHaveBeenCalled()
    }
  )
  it('checks server write authorization before reading or changing the engine', async () => {
    const f = fixture()
    f.authorize.mockRejectedValueOnce(new Error('denied'))
    await expect(f.run(f.request)).rejects.toThrow('denied')
    expect(f.engine.getTaskFiles).not.toHaveBeenCalled()
  })
  it('rejects a stale file name and replaced owner', async () => {
    const f = fixture()
    await expect(
      f.run({ ...f.request, expectedName: 'old.bin' })
    ).rejects.toThrow('task.fileRename.changed')
    await expect(
      f.run({ ...f.request, engineTaskId: 'other' })
    ).rejects.toThrow('task.fileRename.changed')
    expect(f.engine.renameTaskFile).not.toHaveBeenCalled()
  })
  it('never adopts a requested name after the engine refuses it', async () => {
    const f = fixture()
    f.engine.renameTaskFile.mockRejectedValueOnce(
      new Error('task.fileRename.conflict')
    )
    await expect(f.run(f.request)).rejects.toThrow('task.fileRename.conflict')
    expect(
      getBtDirectStorageLayout(f.manager.getById('task')!)?.filePaths
    ).toEqual({ 0: 'a.bin' })
    expect(f.changed).not.toHaveBeenCalled()
    expect(f.manager.getById('task')?.storageOperation).toBeUndefined()
  })
  it('retains acknowledged paths if host persistence fails after engine commit', async () => {
    const f = fixture()
    f.persist
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('disk full'))
    await expect(f.run(f.request)).rejects.toThrow('disk full')
    expect(
      getBtDirectStorageLayout(f.manager.getById('task')!)?.filePaths
    ).toEqual({ 0: 'renamed.bin' })
  })
  it('applies index-based names to replay without changing torrent identity', async () => {
    const { encode } = await import('@motrix/torrent')
    const bytes = encode({
      info: {
        name: 'root',
        'piece length': 16384,
        pieces: Buffer.alloc(20),
        files: [{ length: 1, path: ['a.bin'] }],
      },
    })
    const original = await parseBtFileLayout(bytes)
    const renamed = await parseBtFileLayout(bytes, undefined, undefined, {
      0: 'changed.bin',
    })
    expect(renamed.infoHash).toBe(original.infoHash)
    expect(renamed.files[0].pathInsideRoot).toBe('changed.bin')
    await expect(
      parseBtFileLayout(bytes, undefined, undefined, { 0: '../outside' })
    ).rejects.toThrow()
  })
})
