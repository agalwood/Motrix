// @vitest-environment node
import { createHash } from 'node:crypto'
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type {
  AddTorrentParams,
  EngineAdapter,
} from '@core/engine/engine-adapter'
import { MotrixDatabase } from '@core/session/motrix-database'
import {
  type FinalizeTaskDeps,
  finalizeTask,
} from '@core/task/actions/finalize-task'
import { TaskManager } from '@core/task/task-manager'
import { taskRowToDownloadTask } from '@core/task/task-row-to-download-task'
import type {
  LegacyCheckpointImport,
  LegacyCheckpointReconciliation,
} from '@shared/schemas/legacy-checkpoint'
import { type DownloadTask, TaskStatus } from '@shared/types/task'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { LegacyBtActivationService } from './bt-activation-service'
import { LegacyImportService } from './import-service'

const cleanups: Array<() => Promise<void>> = []
const infoHash = '45c7c651e500cc0ceaa544d6fbafcb21b8cd52f8'
const digest = (bytes: Uint8Array) =>
  createHash('sha256').update(bytes).digest('hex')

async function fixture() {
  const root = await realpath(
    await mkdtemp(path.join(os.tmpdir(), 'legacy-bt-review-'))
  )
  const generated = path.resolve('tests/fixtures/legacy-v1/generated')
  await cp(generated, root, { recursive: true })
  const profile = path.join(root, 'profile')
  const downloads = path.join(profile, 'downloads')
  await cp(path.join(root, 'downloads'), downloads, { recursive: true })
  for (const name of ['download.session', 'system.json']) {
    const filename = path.join(profile, name)
    await writeFile(
      filename,
      (await readFile(filename, 'utf8'))
        .replaceAll('__FIXTURE_ROOT__', profile)
        .replaceAll('__FIXTURE_DOWNLOADS__', downloads)
        .replaceAll('__FIXTURE_HTTP_PORT__', '18080')
    )
  }
  await mkdir(path.join(downloads, 'fixture-bundle'))
  await writeFile(
    path.join(downloads, 'fixture-bundle', 'first.bin'),
    Buffer.alloc(16384, 1),
    { mode: 0o600 }
  )
  await writeFile(
    path.join(downloads, 'fixture-bundle', 'second.bin'),
    Buffer.alloc(16384, 2),
    { mode: 0o600 }
  )
  const db = new MotrixDatabase(path.join(root, 'motrix.db'))
  db.init()
  const taskManager = new TaskManager()
  const isProcessRunning = vi.fn(async () => false)
  const backupRoot = path.join(root, 'backups')
  const importer = new LegacyImportService({
    db,
    taskManager,
    backupRoot,
    isProcessRunning,
    publishTasks: vi.fn(),
  })
  const source = await importer.addSource(profile)
  const preview = await importer.scan(source.sourceHandle)
  const item = preview.items.find(
    (candidate) => candidate.type === 'bt' && candidate.selectable
  )
  expect(item).toBeDefined()
  const run = await importer.commit({
    previewId: preview.previewId,
    itemIds: [item!.itemId],
  })
  await expect.poll(() => importer.getRun(run.runId).stage).toBe('completed')
  const taskId = importer
    .getRun(run.runId)
    .items.find((entry) => entry.outcome === 'imported')!.taskId!
  let imported: LegacyCheckpointImport | null = null
  let engine: DownloadTask | null = null
  const receipt = () => ({
    status: 'created' as const,
    token: imported!.token,
    engineTaskId: imported!.engineTaskId,
    targetPath: imported!.targetPath,
    sourceDigest: imported!.sourceDigest,
  })
  const mocks = {
    supportsLegacyCheckpointImport: vi.fn(async () => true),
    supportsLegacyBtActivation: vi.fn(async () => true),
    inspectLegacyCheckpoint: vi.fn(async (bytes: Uint8Array) => ({
      type: 'bt' as const,
      totalBytes: 32768,
      pieceBytes: 16384,
      infoHash,
      sourceDigest: digest(bytes),
      completedBytes: 0,
      uploadedBytes: 0,
      ranges: [],
    })),
    reconcileLegacyCheckpoint: vi.fn(
      async (input: {
        token: string
        targetPath: string
      }): Promise<LegacyCheckpointReconciliation> =>
        imported ? receipt() : { ...input, status: 'absent' as const }
    ),
    importLegacyCheckpoint: vi.fn(async (input: LegacyCheckpointImport) => {
      imported = input
      return receipt()
    }),
    getTaskStatus: vi.fn(async () => engine),
    verifyLegacyBtBinding: vi.fn(async () => true),
    listActiveAndWaiting: vi.fn(async () => []),
    listStopped: vi.fn(async () => []),
    addTorrent: vi.fn(async (input: AddTorrentParams) => {
      const pair = db.getTask(taskId)!
      engine = {
        ...taskRowToDownloadTask(pair.task, pair.instances),
        engineTaskId: input.gid!,
        status: TaskStatus.Paused,
      }
      return input.gid!
    }),
    pauseTask: vi.fn(async () => {
      if (engine) engine.status = TaskStatus.Paused
    }),
    resumeTask: vi.fn(async () => {
      if (engine) engine.status = TaskStatus.Downloading
    }),
  }
  const deps = {
    db,
    taskManager,
    backupRoot,
    isProcessRunning,
    adapter: mocks as unknown as EngineAdapter,
    publishTasks: vi.fn(),
    runTaskMutation: async <T>(
      _ids: readonly string[],
      operation: () => Promise<T>
    ) => operation(),
    runExclusivePersistence: async <T>(operation: () => T | Promise<T>) =>
      operation(),
  }
  const services: LegacyBtActivationService[] = []
  const service = () => {
    const value = new LegacyBtActivationService(deps)
    services.push(value)
    return value
  }
  cleanups.push(async () => {
    for (const value of services) await value.drain()
    await importer.drain()
    db.close()
    await rm(root, { recursive: true, force: true })
  })
  return {
    root,
    profile,
    downloads,
    db,
    taskManager,
    taskId,
    mocks,
    service,
    pick: vi.fn(async () => downloads),
    setEngine: (value: DownloadTask) => {
      engine = value
    },
    getEngine: () => engine!,
    receipt,
    isProcessRunning,
  }
}

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup()
})

describe('legacy BT activation adversarial recovery', () => {
  it('reconciles a lost checkpoint response without replaying the mutation', async () => {
    const f = await fixture()
    const implementation =
      f.mocks.importLegacyCheckpoint.getMockImplementation()!
    f.mocks.importLegacyCheckpoint.mockImplementationOnce(async (input) => {
      await implementation(input)
      throw new Error('lost checkpoint response')
    })
    await expect(f.service().activate(f.taskId, f.pick)).rejects.toThrow(
      'lost checkpoint response'
    )
    expect(f.mocks.addTorrent).not.toHaveBeenCalled()
    await f.service().activate(f.taskId, f.pick)
    expect(f.mocks.importLegacyCheckpoint).toHaveBeenCalledOnce()
    expect(f.mocks.addTorrent).toHaveBeenCalledOnce()
    expect(f.mocks.resumeTask).toHaveBeenCalledOnce()
    expect(f.pick).toHaveBeenCalledOnce()
    expect(f.db.getAllTasks()).toHaveLength(1)
  })

  it('recovers a lost paused-create response without unpausing or creating twice', async () => {
    const f = await fixture()
    const implementation = f.mocks.addTorrent.getMockImplementation()!
    f.mocks.addTorrent.mockImplementationOnce(async (input) => {
      await implementation(input)
      throw new Error('lost create response')
    })
    await expect(f.service().activate(f.taskId, f.pick)).rejects.toThrow(
      'lost create response'
    )
    const gid = f.getEngine().engineTaskId
    const recovered = f.service()
    await recovered.recover()
    expect(f.mocks.resumeTask).not.toHaveBeenCalled()
    expect(f.db.getTask(f.taskId)?.instances[0]?.gid).toBe(gid)
    await recovered.activate(f.taskId, f.pick)
    expect(f.mocks.addTorrent).toHaveBeenCalledOnce()
    expect(f.mocks.resumeTask).toHaveBeenCalledExactlyOnceWith(gid)
    expect(f.db.getAllTasks()).toHaveLength(1)
  })

  it('does not pause or adopt a different torrent occupying an uncertain GID', async () => {
    const f = await fixture()
    const implementation = f.mocks.addTorrent.getMockImplementation()!
    f.mocks.addTorrent.mockImplementationOnce(async (input) => {
      await implementation(input)
      throw new Error('lost create response')
    })
    await expect(f.service().activate(f.taskId, f.pick)).rejects.toThrow()
    f.setEngine({
      ...f.getEngine(),
      status: TaskStatus.Downloading,
      infoHash: 'f'.repeat(40),
    })
    await expect(f.service().activate(f.taskId, f.pick)).rejects.toThrow()
    expect(f.mocks.pauseTask).not.toHaveBeenCalled()
    expect(f.mocks.resumeTask).not.toHaveBeenCalled()
    expect(f.db.getTask(f.taskId)?.instances[0]?.gid).toBeNull()
  })

  it('rechecks the old process before binding a previously created task', async () => {
    const f = await fixture()
    const implementation = f.mocks.addTorrent.getMockImplementation()!
    f.mocks.addTorrent.mockImplementationOnce(async (input) => {
      await implementation(input)
      throw new Error('lost create response')
    })
    await expect(f.service().activate(f.taskId, f.pick)).rejects.toThrow()
    await writeFile(path.join(f.profile, 'engine.pid'), '54321')
    f.isProcessRunning.mockResolvedValue(true)
    await expect(f.service().activate(f.taskId, f.pick)).rejects.toThrow(
      /running/
    )
    expect(f.mocks.resumeTask).not.toHaveBeenCalled()
    expect(f.db.getTask(f.taskId)?.instances[0]?.gid).toBeNull()
  })

  it('does not pause matching torrent content without a complete ownership proof', async () => {
    const f = await fixture()
    const implementation = f.mocks.addTorrent.getMockImplementation()!
    f.mocks.addTorrent.mockImplementationOnce(async (input) => {
      await implementation(input)
      throw new Error('lost create response')
    })
    await expect(f.service().activate(f.taskId, f.pick)).rejects.toThrow()
    f.setEngine({ ...f.getEngine(), status: TaskStatus.Downloading })
    f.mocks.verifyLegacyBtBinding.mockResolvedValue(false)
    await expect(f.service().activate(f.taskId, f.pick)).rejects.toThrow()
    expect(f.mocks.pauseTask).not.toHaveBeenCalled()
    expect(f.mocks.resumeTask).not.toHaveBeenCalled()
    expect(f.db.getTask(f.taskId)?.instances[0]?.gid).toBeNull()
  })

  it('cancels an outstanding directory picker on shutdown without creating intent', async () => {
    const f = await fixture()
    const service = f.service()
    let answer: (value: string) => void = () => {}
    const picked = new Promise<string>((resolve) => {
      answer = resolve
    })
    const choose = vi.fn(() => picked)
    const operation = service.activate(f.taskId, choose)
    await expect.poll(() => choose.mock.calls.length).toBe(1)
    await service.drain()
    await expect(operation).resolves.toBe(false)
    answer(f.downloads)
    await Promise.resolve()
    expect(f.mocks.importLegacyCheckpoint).not.toHaveBeenCalled()
    expect(f.mocks.addTorrent).not.toHaveBeenCalled()
    expect(f.mocks.resumeTask).not.toHaveBeenCalled()
    expect(f.db.getTask(f.taskId)?.instances[0]?.payload).not.toHaveProperty(
      'legacyBtActivation'
    )
  })

  it('never recreates consumed progress when its reserved task is absent', async () => {
    const f = await fixture()
    f.mocks.addTorrent.mockRejectedValueOnce(
      new Error('unknown create outcome')
    )
    await expect(f.service().activate(f.taskId, f.pick)).rejects.toThrow()
    f.mocks.reconcileLegacyCheckpoint.mockImplementation(async () => ({
      ...f.receipt(),
      status: 'consumed',
    }))
    await expect(f.service().activate(f.taskId, f.pick)).rejects.toThrow(
      /activationUncertain/
    )
    expect(f.mocks.addTorrent).toHaveBeenCalledOnce()
    expect(f.mocks.importLegacyCheckpoint).toHaveBeenCalledOnce()
    expect(f.mocks.resumeTask).not.toHaveBeenCalled()
  })

  it.each([
    {
      name: 'integrity verification is still running',
      status: TaskStatus.Downloading,
      bytes: 16384,
      mismatchedGid: false,
    },
    {
      name: 'the completed report has zero bytes',
      status: TaskStatus.Completed,
      bytes: 0,
      mismatchedGid: false,
    },
    {
      name: 'the public GID differs from the durable binding',
      status: TaskStatus.Completed,
      bytes: 16384,
      mismatchedGid: true,
    },
  ])(
    'does not finalize when $name',
    async ({ status, bytes, mismatchedGid }) => {
      const f = await fixture()
      await f.service().activate(f.taskId, f.pick)
      f.setEngine({
        ...f.getEngine(),
        status,
        downloadedBytes: bytes,
        totalBytes: bytes,
        progress: 1,
        ...(mismatchedGid ? { engineTaskId: 'fedcba0987654321' } : {}),
      })
      if (mismatchedGid)
        f.taskManager.getById(f.taskId)!.engineTaskId = 'fedcba0987654321'
      const persisted = vi.fn(async () => {})
      const publishTaskUpdateNow = vi.fn()
      const deps = {
        taskManager: {
          getById: f.taskManager.getById.bind(f.taskManager),
          set: f.taskManager.set.bind(f.taskManager),
          persist: persisted,
        },
        adapter: f.mocks,
        publishTaskUpdateNow,
        eventBus: { emit: vi.fn() },
        log: { warn: vi.fn(), info: vi.fn(), error: vi.fn() },
      } as unknown as FinalizeTaskDeps
      await finalizeTask(f.taskId, deps)
      expect(persisted).not.toHaveBeenCalled()
      expect(publishTaskUpdateNow).not.toHaveBeenCalled()
      expect(f.taskManager.getById(f.taskId)?.status).not.toBe(
        TaskStatus.Completed
      )
    }
  )
})
