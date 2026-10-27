// @vitest-environment node
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { EngineAdapter } from '@core/engine/engine-adapter'
import { EventBus } from '@core/events/event-bus'
import type { Logger } from '@core/logger'
import type { DurableFinalizeArtifactInput } from '@core/session/durable-finalize-runtime'
import {
  makeDefaultBtExtension,
  TaskInstancePhase,
  TaskKind,
  TaskStatus,
  TaskType,
  TransitionPhase,
} from '@shared/types/task'
import { storageTorrent } from '@test-utils/bt-storage'
import { makeDownloadTask } from '@test-utils/task'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { parseBtFileLayout } from './bt-storage-layout'
import {
  authorizeBtDirectory,
  BtStorageService,
  type BtStorageServiceDeps,
} from './bt-storage-service'
import { TaskManager } from './task-manager'

describe('BT storage operations', () => {
  let root: string
  const metadata = storageTorrent([{ name: 'file', data: 'abcdefgh' }])
  beforeEach(async () => {
    root = await realpath(
      await mkdtemp(path.join(tmpdir(), 'motrix-bt-storage-'))
    )
    await mkdir(path.join(root, 'old'))
    await mkdir(path.join(root, 'new'))
  })
  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  async function setup(status = TaskStatus.Completed) {
    const source = path.join(root, 'old', 'file')
    const target = path.join(root, 'new', 'file')
    await writeFile(source, 'abcdefgh')
    const task = makeDownloadTask({
      id: 'seed',
      type: TaskType.Bt,
      kind: TaskKind.Bt,
      status,
      engineTaskId: '0123456789abcdef',
      saveDir: path.dirname(source),
      diskPath: source,
      finalPath: source,
      finalName: 'file',
      name: 'display name',
      torrentMetaPath: path.join(root, 'metadata.torrent'),
      infoHash: (await parseBtFileLayout(metadata)).infoHash,
      createdAt: 42,
      finishedAt: 43,
      progress: 1,
      totalBytes: 8,
      downloadedBytes: 8,
      uploadedBytes: 20,
      bt: makeDefaultBtExtension({ selectedFiles: [0] }),
      instances: [
        {
          instanceId: 'instance',
          motrixId: 'seed',
          gid: '0123456789abcdef',
          phase: TaskInstancePhase.BtDownload,
          status,
          diskPath: source,
          transitionPhase: TransitionPhase.Idle,
          progress: 1,
          totalBytes: 8,
          downloadedBytes: 8,
          uploadedBytes: 20,
          uris: [],
          uriHash: null,
          payload: {},
          createdAt: 42,
          updatedAt: 43,
        },
      ],
    })
    const taskManager = new TaskManager()
    taskManager.add(task)
    const adapter = {
      listActiveAndWaiting: vi.fn(async () => []),
      forceRemoveTask: vi.fn(async () => {}),
      removeDownloadResult: vi.fn(async () => {}),
      getUploadLength: vi.fn(async () => 20),
      addTorrent: vi.fn(async () => 'fedcba9876543210'),
      getTaskStatus: vi.fn(async () => null),
    }
    const saved: unknown[] = []
    const deps: BtStorageServiceDeps = {
      taskManager,
      adapter: adapter as unknown as EngineAdapter,
      eventBus: new EventBus(),
      log: {
        warn: vi.fn(),
        error: vi.fn(),
        info: vi.fn(),
        debug: vi.fn(),
      } as unknown as Logger,
      torrentMetaStore: {
        read: async () => metadata,
        persist: vi.fn(),
        remove: vi.fn(),
      },
      persistTask: vi.fn(async () => {}),
      persistStorage: vi.fn(async (next, sourceRoot, targetRoot) => {
        saved.push({ task: structuredClone(next), sourceRoot, targetRoot })
        taskManager.set(next.id, structuredClone(next))
      }),
      publishTaskUpdate: vi.fn(),
      publishTaskUpdateNow: vi.fn(),
      runTaskMutation: async (_ids, operation) => operation(),
      authorizeDirectory: authorizeBtDirectory,
      createEngineTaskId: () => 'fedcba9876543210',
      runtime: {
        hasPendingFinalization: vi.fn(async () => false),
        withArtifactLease: vi.fn(async (_id, operation) => operation()),
        commit: vi.fn(async (input: DurableFinalizeArtifactInput) => {
          await input.verifySource?.()
          await rename(input.sourcePath, input.targetPath)
          input.onCommitted?.()
          return {
            journalId: 'journal',
            targetPath: input.targetPath,
            targetIdentity: {
              kind: 'file' as const,
              size: 8,
              sha256: 'sha',
              platformFileId: 'id',
            },
          }
        }),
      },
    }
    return {
      service: new BtStorageService(deps),
      deps,
      task,
      source,
      target,
      adapter,
      saved,
    }
  }

  it('locates already moved files even when the old parent disappeared', async () => {
    const { service, task, source, target, deps, adapter } = await setup()
    await rename(source, target)
    await rm(path.dirname(source), { recursive: true })
    const result = await service.run({
      taskId: task.id,
      mode: 'locate',
      directory: path.dirname(target),
      name: 'file',
    })
    expect(result).toMatchObject({
      path: target,
      verification: { complete: true },
      resumed: false,
    })
    expect(deps.taskManager.getById(task.id)).toMatchObject({
      id: task.id,
      createdAt: 42,
      finishedAt: 43,
      finalPath: target,
      diskPath: target,
      uploadedBytes: 20,
    })
    expect(deps.taskManager.getById(task.id)?.storageOperation).toBeUndefined()
    expect(adapter.addTorrent).not.toHaveBeenCalled()
    expect(deps.runtime.commit).not.toHaveBeenCalled()
  })

  it('moves through the durable runtime and retains identity and upload accounting when reseeding', async () => {
    const { service, task, source, target, deps, adapter } = await setup(
      TaskStatus.Seeding
    )
    const result = await service.run({
      taskId: task.id,
      mode: 'move',
      directory: path.dirname(target),
      name: 'file',
      resume: true,
    })
    expect(result).toMatchObject({ resumed: true, path: target })
    expect(await readFile(target, 'utf8')).toBe('abcdefgh')
    await expect(readFile(source)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(deps.runtime.commit).toHaveBeenCalledWith(
      expect.objectContaining({
        occurrence: null,
        fileRebase: { sourceRoot: source, targetRoot: target },
      })
    )
    expect(adapter.addTorrent).toHaveBeenCalledWith(
      expect.objectContaining({
        checkIntegrity: true,
        preserveExistingFiles: true,
        outputRoot: path.dirname(target),
      })
    )
    expect(deps.taskManager.getById(task.id)).toMatchObject({
      createdAt: 42,
      uploadedBytes: 20,
      status: TaskStatus.Seeding,
    })
  })

  it('resolves a selected source-parent alias before native movement', async () => {
    const { service, task, source, target, deps } = await setup()
    const alias = path.join(root, 'alias')
    await symlink(path.dirname(source), alias)
    const aliasedPath = path.join(alias, 'file')
    const owner = structuredClone(task)
    owner.finalPath = owner.diskPath = aliasedPath
    owner.saveDir = alias
    owner.instances[0].diskPath = aliasedPath
    deps.taskManager.set(owner.id, owner)
    expect(
      await service.run({
        taskId: owner.id,
        mode: 'move',
        directory: path.dirname(target),
        name: 'file',
      })
    ).toMatchObject({ path: target })
    expect(deps.runtime.commit).toHaveBeenCalledWith(
      expect.objectContaining({
        sourcePath: source,
        fileRebase: { sourceRoot: aliasedPath, targetRoot: target },
      })
    )
    expect(await readFile(target, 'utf8')).toBe('abcdefgh')
  })

  it('never replaces an occupied destination', async () => {
    const { service, task, source, target, deps, adapter } = await setup()
    await writeFile(target, 'unrelated')
    expect(
      await service.run({
        taskId: task.id,
        mode: 'move',
        directory: path.dirname(target),
        name: 'file',
      })
    ).toEqual({ error: 'destination' })
    expect(await readFile(target, 'utf8')).toBe('unrelated')
    expect(await readFile(source, 'utf8')).toBe('abcdefgh')
    expect(deps.runtime.commit).not.toHaveBeenCalled()
    expect(adapter.forceRemoveTask).not.toHaveBeenCalled()
  })

  it('leaves both locations intact when the new files fail verification', async () => {
    const { service, task, source, target, deps, adapter } = await setup()
    await writeFile(target, 'wrong!!!')
    const result = await service.run({
      taskId: task.id,
      mode: 'locate',
      directory: path.dirname(target),
      name: 'file',
      resume: true,
    })
    expect(result).toMatchObject({
      verification: { complete: false },
      path: source,
      resumed: false,
    })
    expect(deps.taskManager.getById(task.id)?.finalPath).toBe(source)
    expect(await readFile(target, 'utf8')).toBe('wrong!!!')
    expect(adapter.addTorrent).not.toHaveBeenCalled()
  })

  it('keeps the new location after an engine admission failure', async () => {
    const { service, task, target, deps, adapter } = await setup()
    adapter.addTorrent.mockRejectedValue(new Error('offline'))
    const result = await service.run({
      taskId: task.id,
      mode: 'move',
      directory: path.dirname(target),
      name: 'file',
      resume: true,
    })
    expect(result).toMatchObject({
      resumeFailed: true,
      resumed: false,
      path: target,
    })
    expect(deps.taskManager.getById(task.id)?.finalPath).toBe(target)
    expect(await readFile(target, 'utf8')).toBe('abcdefgh')
  })

  it('accepts an already-stopped result only after cleanup proves it absent', async () => {
    const { service, task, target, adapter } = await setup()
    adapter.forceRemoveTask.mockRejectedValue(
      new Error('cannot remove stopped download')
    )
    await writeFile(target, 'abcdefgh')
    expect(
      await service.run({
        taskId: task.id,
        mode: 'locate',
        directory: path.dirname(target),
        name: 'file',
      })
    ).toMatchObject({ path: target, verification: { complete: true } })
    expect(adapter.removeDownloadResult).toHaveBeenCalledWith(task.engineTaskId)
  })

  it('does not verify or move until the old engine owner is drained', async () => {
    const { service, task, target, deps, adapter } = await setup(
      TaskStatus.Seeding
    )
    adapter.removeDownloadResult.mockRejectedValue(new Error('still stopping'))
    expect(
      await service.run({
        taskId: task.id,
        mode: 'move',
        directory: path.dirname(target),
        name: 'file',
      })
    ).toEqual({ error: 'engine' })
    expect(deps.runtime.commit).not.toHaveBeenCalled()
    expect(deps.taskManager.getById(task.id)?.storageOperation).toBeUndefined()
  })

  it('rejects another task reserving a destination ancestor', async () => {
    const { service, task, target, deps } = await setup()
    deps.taskManager.add(
      makeDownloadTask({ id: 'other', finalPath: path.dirname(target) })
    )
    expect(
      await service.run({
        taskId: task.id,
        mode: 'locate',
        directory: path.dirname(target),
        name: 'file',
      })
    ).toEqual({ error: 'conflict' })
  })

  it('reports a failed recheck without starting repair downloads', async () => {
    const { service, task, source, deps, adapter } = await setup()
    await writeFile(source, 'broken!!')
    expect(
      await service.run({ taskId: task.id, mode: 'recheck', resume: true })
    ).toMatchObject({ verification: { complete: false }, resumed: false })
    expect(deps.taskManager.getById(task.id)?.status).toBe(TaskStatus.Error)
    expect(adapter.addTorrent).not.toHaveBeenCalled()
  })

  it('cancels before filesystem publication and clears transient busy state', async () => {
    const { service, task, target, deps } = await setup()
    deps.verify = vi.fn(async (input) => {
      service.cancel(task.id)
      input.signal?.throwIfAborted()
      throw new Error('unreachable')
    })
    expect(
      await service.run({
        taskId: task.id,
        mode: 'move',
        directory: path.dirname(target),
        name: 'file',
      })
    ).toEqual({ error: 'cancelled' })
    await expect(readFile(target)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(deps.taskManager.getById(task.id)?.storageOperation).toBeUndefined()
  })
})
