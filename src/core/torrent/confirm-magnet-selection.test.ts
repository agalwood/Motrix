import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { EngineAdapter } from '@core/engine/engine-adapter'
import {
  MotrixDatabase,
  type TaskInstanceRow,
  type TaskRow,
} from '@core/session/motrix-database'
import { TaskManager } from '@core/task/task-manager'
import { taskRowToDownloadTask } from '@core/task/task-row-to-download-task'
import { TorrentMetaStoreImpl } from '@core/task/torrent-meta-store'
import {
  TaskInstancePhase,
  TaskKind,
  TaskStatus,
  TaskType,
  TransitionPhase,
} from '@shared/types/task'
import { storageTorrent } from '@test-utils/bt-storage'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { confirmMagnetSelection } from './confirm-magnet-selection'
import type { MagnetTracker } from './magnet-tracker'
import { confirmPendingTorrentSelection } from './pending-torrent-selection'

const metadata = storageTorrent([
  { name: 'a', data: 'a' },
  { name: 'b', data: 'b' },
  { name: 'c', data: 'c' },
])
const resources: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const close of resources.splice(0)) await close()
})

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'motrix-confirm-'))
  const db = new MotrixDatabase(path.join(root, 'motrix.db'))
  db.init()
  resources.push(async () => {
    db.close()
    await rm(root, { recursive: true, force: true })
  })
  const taskId = 'magnet-selection'
  const task = makeMetadataReadyTask(taskId, root),
    instance = makeMetadataReadyInstance(taskId)
  db.saveTaskWithInstances({ task, instances: [instance] })
  const taskManager = new TaskManager()
  taskManager.set(taskId, taskRowToDownloadTask(task, [instance]))
  const adapter = {
    getTorrentMetadata: vi.fn().mockResolvedValue({
      data: metadata.toString('base64'),
      awaitingSelection: true,
    }),
    confirmTorrentSelection: vi.fn().mockResolvedValue(undefined),
    getTaskFiles: vi.fn().mockResolvedValue([]),
    addTorrent: vi.fn(),
    forceRemoveTask: vi.fn(),
    removeDownloadResult: vi.fn(),
  }
  const tracker = {
    hasPendingSwapCleanup: () => false,
    releaseSelection: vi.fn(),
    cancel: vi.fn(),
  }
  let tail = Promise.resolve()
  const deps = {
    db,
    taskManager,
    adapter: adapter as unknown as EngineAdapter,
    magnetTracker: tracker as unknown as MagnetTracker,
    finalNamePicker: {
      pick: vi.fn(async (_dir: string, name: string) => name),
      isTaken: vi.fn().mockResolvedValue(false),
    },
    torrentMetaStore: new TorrentMetaStoreImpl(path.join(root, 'metadata')),
    publishTaskUpdate: vi.fn(),
    publishTaskUpdateNow: vi.fn(),
    recordTransition: vi.fn(),
    runTaskMutation: <T>(
      _ids: readonly string[],
      operation: () => Promise<T>
    ): Promise<T> => {
      const run = tail.then(operation, operation)
      tail = run.then(
        () => {},
        () => {}
      )
      return run
    },
    runExclusivePersistence: async <T>(
      operation: () => T | Promise<T>
    ): Promise<T> => operation(),
  }
  const input = {
    taskId,
    base64: metadata.toString('base64'),
    selectedFiles: [0, 2],
    saveDir: path.join(root, 'downloads'),
    name: 'renamed',
  }
  return { root, taskId, db, taskManager, adapter, tracker, deps, input }
}

describe('confirm magnet selection on the existing task', () => {
  it('commits selection and output ownership before starting the same GID', async () => {
    const f = await fixture()
    f.adapter.confirmTorrentSelection.mockImplementation(
      async (gid, selection) => {
        expect(gid).toBe('g-metadata')
        expect(f.db.getTask(f.taskId)?.instances[0]).toMatchObject({
          gid,
          phase: TaskInstancePhase.BtDownload,
          payload: { pendingTorrentSelection: selection },
        })
        expect(selection).toMatchObject({
          selectedFiles: [0, 2],
          saveDir: path.join(f.input.saveDir, 'renamed'),
        })
        expect(f.taskManager.getByEngineTaskId(gid)?.id).toBe(f.taskId)
      }
    )
    expect(await confirmMagnetSelection(f.input, f.deps)).toMatchObject({
      taskId: f.taskId,
      gid: 'g-metadata',
    })
    expect(f.db.getTask(f.taskId)?.task).toMatchObject({
      taskType: TaskType.Bt,
      aggStatus: TaskStatus.Downloading,
      createdAt: 1700000000000,
    })
    expect(f.db.getTask(f.taskId)?.instances[0].payload).not.toHaveProperty(
      'pendingTorrentSelection'
    )
    expect(f.adapter.addTorrent).not.toHaveBeenCalled()
    expect(f.adapter.forceRemoveTask).not.toHaveBeenCalled()
    expect(f.tracker.cancel).not.toHaveBeenCalled()
  })

  it.each(['parent', 'instances', 'files'])(
    'keeps metadata intact if the %s transaction fails',
    async (seam) => {
      const f = await fixture()
      const table =
        seam === 'parent'
          ? 'tasks'
          : seam === 'instances'
            ? 'task_instances'
            : 'task_files'
      f.db.database.exec(
        `CREATE TEMP TRIGGER fail_selection BEFORE ${seam === 'parent' ? 'UPDATE' : 'INSERT'} ON ${table} BEGIN SELECT RAISE(ABORT, 'disk full'); END`
      )
      await expect(confirmMagnetSelection(f.input, f.deps)).rejects.toThrow(
        'disk full'
      )
      expect(f.db.getTask(f.taskId)?.task.aggStatus).toBe(
        TaskStatus.MetadataReady
      )
      expect(f.taskManager.getById(f.taskId)?.status).toBe(
        TaskStatus.MetadataReady
      )
      expect(f.adapter.confirmTorrentSelection).not.toHaveBeenCalled()
      expect(f.tracker.releaseSelection).not.toHaveBeenCalled()
    }
  )

  it('keeps successful confirmation when optional activity recording fails', async () => {
    const f = await fixture()
    f.deps.recordTransition.mockRejectedValue(new Error('activity unavailable'))
    await expect(
      confirmMagnetSelection(f.input, f.deps)
    ).resolves.toHaveProperty('gid', 'g-metadata')
    expect(f.taskManager.getById(f.taskId)?.bt?.selectedFiles).toEqual([0, 2])
  })

  it('retains durable intent after a lost engine response and replays without re-adding', async () => {
    const f = await fixture()
    f.adapter.confirmTorrentSelection.mockRejectedValueOnce(
      new Error('response lost')
    )
    await expect(confirmMagnetSelection(f.input, f.deps)).rejects.toThrow(
      'response lost'
    )
    const saved = f.db.getTask(f.taskId)!
    expect(saved.task.aggStatus).toBe(TaskStatus.Paused)
    expect(saved.instances[0].gid).toBe('g-metadata')
    const recovered = await confirmPendingTorrentSelection(
      taskRowToDownloadTask(saved.task, saved.instances),
      f.deps.adapter
    )
    expect(recovered.status).toBe(TaskStatus.Downloading)
    expect(f.adapter.confirmTorrentSelection.mock.calls[1]).toEqual(
      f.adapter.confirmTorrentSelection.mock.calls[0]
    )
    expect(f.adapter.addTorrent).not.toHaveBeenCalled()
  })

  it('retains confirmation intent if the completion acknowledgement cannot be saved', async () => {
    const f = await fixture()
    f.adapter.confirmTorrentSelection.mockImplementation(async () => {
      f.db.database.exec(
        "CREATE TEMP TRIGGER fail_ack BEFORE UPDATE ON tasks WHEN NEW.agg_status = 'downloading' BEGIN SELECT RAISE(ABORT, 'ack failed'); END"
      )
    })
    await expect(confirmMagnetSelection(f.input, f.deps)).rejects.toThrow(
      'ack failed'
    )
    expect(f.db.getTask(f.taskId)?.instances[0].payload).toHaveProperty(
      'pendingTorrentSelection'
    )
    expect(f.adapter.forceRemoveTask).not.toHaveBeenCalled()
  })

  it('serializes duplicate confirmations and preserves one task', async () => {
    const f = await fixture()
    const results = await Promise.allSettled([
      confirmMagnetSelection(f.input, f.deps),
      confirmMagnetSelection(f.input, f.deps),
    ])
    expect(results.map((item) => item.status)).toEqual([
      'fulfilled',
      'rejected',
    ])
    expect(f.adapter.confirmTorrentSelection).toHaveBeenCalledOnce()
    expect(f.db.getAllTasks()).toHaveLength(1)
  })

  it.each([[], [-1], [3], [0.5]].map((selectedFiles) => ({ selectedFiles })))(
    'rejects invalid selection %j before persisting intent',
    async ({ selectedFiles }) => {
      const f = await fixture()
      await expect(
        confirmMagnetSelection({ ...f.input, selectedFiles }, f.deps)
      ).rejects.toThrow()
      expect(f.db.getTask(f.taskId)?.task.aggStatus).toBe(
        TaskStatus.MetadataReady
      )
      expect(f.adapter.confirmTorrentSelection).not.toHaveBeenCalled()
    }
  )

  it('rejects a different torrent supplied by the caller', async () => {
    const f = await fixture()
    await expect(
      confirmMagnetSelection(
        {
          ...f.input,
          base64: storageTorrent([{ name: 'other', data: 'other' }]).toString(
            'base64'
          ),
        },
        f.deps
      )
    ).rejects.toThrow('does not match')
    expect(f.adapter.confirmTorrentSelection).not.toHaveBeenCalled()
  })

  it('keeps selection open when metadata persistence fails', async () => {
    const f = await fixture()
    vi.spyOn(f.deps.torrentMetaStore, 'persist').mockRejectedValue(
      new Error('disk full')
    )
    await expect(confirmMagnetSelection(f.input, f.deps)).rejects.toThrow(
      'disk full'
    )
    expect(f.db.getTask(f.taskId)?.task.aggStatus).toBe(
      TaskStatus.MetadataReady
    )
    expect(f.tracker.releaseSelection).not.toHaveBeenCalled()
  })

  it('refuses conflicting existing outputs before confirmation', async () => {
    const f = await fixture()
    f.deps.finalNamePicker.isTaken.mockResolvedValue(true)
    await expect(confirmMagnetSelection(f.input, f.deps)).rejects.toThrow()
    expect(f.adapter.confirmTorrentSelection).not.toHaveBeenCalled()
  })
})
function makeMetadataReadyTask(taskId: string, saveDir: string): TaskRow {
  return {
    motrixId: taskId,
    name: '[METADATA] resolved.torrent',
    kind: TaskKind.Bt,
    taskType: TaskType.Magnet,
    category: null,
    priority: 0,
    tags: null,
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_100,
    saveDir,
    finalPath: saveDir,
    finalName: '',
    torrentMetaPath: null,
    infoHash: null,
    totalBytes: 0,
    downloadedBytes: 0,
    sizeWhenDone: 0,
    fileCount: 0,
    isPrivate: false,
    trackers: [],
    pieceLength: 0,
    aggStatus: TaskStatus.MetadataReady,
    finishedAt: null,
    errorMessage: null,
    errorCode: null,
    errorDetailKey: null,
    errorDetailParams: null,
    diagnosisRevision: 0,
    uploadedBytesBaseline: 0,
    source: 'user',
    sourceMeta: null,
  }
}

function makeMetadataReadyInstance(taskId: string): TaskInstanceRow {
  return {
    instanceId: `metadata:${taskId}`,
    motrixId: taskId,
    gid: 'g-metadata',
    phase: TaskInstancePhase.MagnetMetadataResolution,
    status: TaskStatus.MetadataReady,
    progress: 100,
    totalBytes: 0,
    downloadedBytes: 0,
    uploadedBytes: 0,
    diskPath: '/tmp/motrix-metadata',
    transitionPhase: TransitionPhase.Idle,
    uris: ['magnet:?xt=urn:btih:atomicity'],
    uriHash: null,
    payload: { metadataDir: '/tmp/motrix-metadata' },
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_100,
  }
}
