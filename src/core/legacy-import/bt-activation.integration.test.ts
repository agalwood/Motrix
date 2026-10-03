// @vitest-environment node
import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { EngineAdapter } from '@core/engine/engine-adapter'
import { EventBus } from '@core/events/event-bus'
import { getLogger } from '@core/logger'
import { SessionManager } from '@core/session/session-manager'
import { finalizeTask } from '@core/task/actions/finalize-task'
import { pauseTask } from '@core/task/actions/pause-task'
import { removeTask } from '@core/task/actions/remove-task'
import { resumeTask } from '@core/task/actions/resume-task'
import { mergeEngineTask } from '@core/task/merge-engine-task'
import { TorrentMetaStoreImpl } from '@core/task/torrent-meta-store'
import type { MagnetTracker } from '@core/torrent/magnet-tracker'
import { legacyBtActivationSchema } from '@shared/schemas/legacy-bt-activation'
import { TaskStatus } from '@shared/types/task'
import {
  type Aria2Handle,
  connectAdapter,
  spawnAria2ForTest,
} from '@test-utils/aria2'
import { legacyBtActivationFixture } from '@test-utils/legacy-bt-activation-fixture'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { LegacyBtActivationService } from './bt-activation-service'

const binaryPath = process.env.MOTRIX_LEGACY_CHECKPOINT_ENGINE
const cleanup: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn()
})
async function nativeFixture() {
  // The importer is offline; the adapter is installed before any activation call.
  const f = await legacyBtActivationFixture({} as EngineAdapter)
  cleanup.push(f.dispose)
  let handle: Aria2Handle | undefined
  let wired: Awaited<ReturnType<typeof connectAdapter>> | undefined
  const start = async () => {
    handle = await spawnAria2ForTest({
      baseDir: f.root,
      binaryPath,
      extraArgs: [
        '--enable-sqlite3-persistence=true',
        '--force-save=true',
        `--sqlite3-db-path=${path.join(f.root, 'engine.db')}`,
        '--enable-dht=false',
        '--enable-dht6=false',
        '--enable-peer-exchange=false',
        '--bt-enable-lpd=false',
        '--seed-time=20',
        '--seed-ratio=20',
        '--bt-seed-unverified=true',
        '--bt-remove-unselected-file=true',
        '--file-allocation=none',
      ],
    })
    wired = await connectAdapter(handle)
    f.deps.adapter = wired.adapter
    return wired
  }
  const stop = async () => {
    wired?.disconnect()
    wired = undefined
    await handle?.kill()
    handle = undefined
  }
  cleanup.push(stop)
  return { ...f, start, stop }
}
async function completed(adapter: EngineAdapter, gid: string) {
  const deadline = Date.now() + 20000
  while (Date.now() < deadline) {
    const task = await adapter.getTaskStatus(gid)
    if (
      task?.status === TaskStatus.Completed ||
      task?.status === TaskStatus.Error
    )
      return task
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  throw new Error('BT verification timed out')
}

function actionsFor(
  f: Awaited<ReturnType<typeof nativeFixture>>,
  wired: Awaited<ReturnType<typeof connectAdapter>>
) {
  const session = new SessionManager(
    f.taskManager,
    wired.rpc,
    f.db,
    wired.adapter
  )
  cleanup.push(() => session.stopAndDrain())
  const deps = {
    taskManager: f.taskManager,
    adapter: wired.adapter,
    eventBus: new EventBus(),
    log: getLogger('legacy-bt-native-test'),
    publishTaskUpdate: vi.fn(),
    publishTaskUpdateNow: vi.fn(),
    persistTask: session.persistTask.bind(session),
    persistTaskWithOccurrence: session.persistTaskWithOccurrence.bind(session),
    occurrenceDispatcher: { dispatch: vi.fn(async () => {}) },
    runTaskMutation: f.deps.runTaskMutation,
  }
  const cleanupFiles = vi.fn(async () => {
    throw new Error('Legacy payload cleanup must not run')
  })
  const finalizeDeps = {
    ...deps,
    taskManager: Object.assign(f.taskManager, { persist: deps.persistTask }),
    fs: { renameAtomic: cleanupFiles, removePathRecursive: cleanupFiles },
    torrentMetaStore: new TorrentMetaStoreImpl(
      path.join(f.root, 'unused-metadata')
    ),
    settings: { get: () => ({ bt: { seedTime: 20, seedRatio: 20 } }) },
    activityRecorder: {
      recordSubmitted: vi.fn(),
      recordDownloadCompleted: vi.fn(),
    },
  }
  const removeDeps = {
    ...deps,
    db: f.db,
    taskPersistence: session,
    fileCleanupService: { cleanup: cleanupFiles },
    torrentMetaStore: finalizeDeps.torrentMetaStore,
    magnetTracker: {
      cancel: vi.fn(),
      markPendingUserDelete: vi.fn(),
    } as unknown as MagnetTracker,
  }
  return { deps, finalizeDeps, removeDeps, cleanupFiles, session }
}

describe.skipIf(!binaryPath)(
  'real native application BT legacy activation',
  () => {
    it('verifies real v1 pieces with exact original selection, consumes once, and never auto-seeds', async () => {
      const f = await nativeFixture()
      const wired = await f.start()
      const { adapter, rpc } = wired
      const before = await readFile(
        path.join(f.downloads, 'fixture-bundle/second.bin')
      )
      await f.service.activate(f.taskId, async () => f.downloads)
      const intent = legacyBtActivationSchema.parse(
        f.db.getTask(f.taskId)?.instances[0].payload.legacyBtActivation
      )
      const task = await completed(adapter, intent.engineTaskId)
      expect(task.status).toBe(TaskStatus.Completed)
      expect(task.downloadedBytes).toBeGreaterThan(0)
      expect(await rpc.tellActive()).toEqual([])
      expect(await adapter.getTaskFiles(intent.engineTaskId)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ index: 0, selected: true }),
          expect.objectContaining({ index: 1, selected: false }),
        ])
      )
      expect(
        await readFile(path.join(f.downloads, 'fixture-bundle/second.bin'))
      ).toEqual(before)
      expect(
        await adapter.reconcileLegacyCheckpoint({
          token: intent.token,
          targetPath: intent.targetPath,
        })
      ).toMatchObject({ status: 'consumed' })
      const rows = [
        ...(await adapter.listActiveAndWaiting()),
        ...(await adapter.listStopped()),
      ]
      expect(
        new Set(
          rows
            .filter((row) => row.infoHash === intent.expected.infoHash)
            .map((row) => row.gid)
        )
      ).toEqual(new Set([intent.engineTaskId]))
      const actions = actionsFor(f, wired)
      await finalizeTask(f.taskId, actions.finalizeDeps)
      expect(f.db.getTask(f.taskId)?.task.aggStatus).toBe(TaskStatus.Completed)
      expect(f.db.listUndispatchedOccurrences()).toEqual([
        expect.objectContaining({
          taskId: f.taskId,
          toStatus: TaskStatus.Completed,
        }),
      ])
      expect(
        f.db.getTask(f.taskId)?.instances[0].payload.legacyImport
      ).toMatchObject({
        activation: 'active',
        storagePolicy: 'legacy-bt-in-place',
      })
      await f.stop()
      f.taskManager.clear()
      const restarted = await f.start()
      const recovery = new LegacyBtActivationService(f.deps)
      await recovery.recover()
      const replay = await restarted.adapter.getTaskStatus(intent.engineTaskId)
      expect(replay?.status).toBe(TaskStatus.Paused)
      const restored = actionsFor(f, restarted)
      await restored.session.restore()
      const history = f.taskManager.getById(f.taskId)
      expect(history?.status).toBe(TaskStatus.Completed)
      expect(f.db.getTask(f.taskId)?.task.aggStatus).toBe(TaskStatus.Completed)
      if (!history || !replay)
        throw new Error('Missing completed replay fixture')
      expect(mergeEngineTask(history, replay)).toBe(history)
      expect(
        await restarted.adapter.getTaskStatus(intent.engineTaskId)
      ).toMatchObject({ status: TaskStatus.Paused })
      await removeTask(f.taskId, { deleteWithFiles: true }, restored.removeDeps)
      await recovery.drain()
      expect(f.db.getTask(f.taskId)).toBeNull()
      expect(
        await readFile(path.join(f.downloads, 'fixture-bundle/first.bin'))
      ).toEqual(Buffer.alloc(16384, 1))
      expect(
        await readFile(path.join(f.downloads, 'fixture-bundle/second.bin'))
      ).toEqual(before)
      expect(actions.cleanupFiles).not.toHaveBeenCalled()
      expect(restored.cleanupFiles).not.toHaveBeenCalled()
    }, 30000)
    it('recovers a real lost paused add response after engine restart without recreating or unpausing', async () => {
      const f = await nativeFixture()
      const { adapter } = await f.start()
      const add = adapter.addTorrent.bind(adapter)
      adapter.addTorrent = async (input) => {
        await add(input)
        throw new Error('Simulated lost response')
      }
      await expect(
        f.service.activate(f.taskId, async () => f.downloads)
      ).rejects.toThrow('Simulated lost response')
      const intent = legacyBtActivationSchema.parse(
        f.db.getTask(f.taskId)?.instances[0].payload.legacyBtActivation
      )
      await f.stop()
      f.taskManager.clear()
      const resumed = await f.start()
      const service = new LegacyBtActivationService(f.deps)
      const proof = await resumed.adapter.verifyLegacyBtBinding({
        engineTaskId: intent.engineTaskId,
        saveDir: intent.saveDir,
        infoHash: intent.expected.infoHash ?? '',
        files: intent.files,
        selectedFiles: intent.selectedFiles,
        trackers: intent.trackers,
        isPrivate: intent.isPrivate,
      })
      expect(proof).toBe(true)
      await service.recover()
      expect(
        f.db.getTask(f.taskId)?.instances[0].payload.legacyBtActivation
      ).toMatchObject({ stage: 'bound' })
      expect(
        (await resumed.adapter.getTaskStatus(intent.engineTaskId))?.status
      ).toBe(TaskStatus.Paused)
      expect(
        (await resumed.adapter.listActiveAndWaiting()).filter(
          (row) => row.infoHash === intent.expected.infoHash
        )
      ).toHaveLength(1)
      await service.drain()
    }, 30000)
    it('reconciles a lost checkpoint response after restart without importing twice or starting work', async () => {
      const f = await nativeFixture()
      const { adapter } = await f.start()
      const importCheckpoint = adapter.importLegacyCheckpoint.bind(adapter)
      adapter.importLegacyCheckpoint = async (input) => {
        await importCheckpoint(input)
        throw new Error('Simulated lost checkpoint response')
      }
      await expect(
        f.service.activate(f.taskId, async () => f.downloads)
      ).rejects.toThrow('Simulated lost checkpoint response')
      const intent = legacyBtActivationSchema.parse(
        f.db.getTask(f.taskId)?.instances[0].payload.legacyBtActivation
      )
      expect(intent.stage).toBe('import-uncertain')
      expect(await adapter.getTaskStatus(intent.engineTaskId)).toBeNull()
      await f.stop()
      f.taskManager.clear()
      const resumed = await f.start()
      const repeatedImport = vi.spyOn(resumed.adapter, 'importLegacyCheckpoint')
      const service = new LegacyBtActivationService(f.deps)
      await service.recover()
      expect(repeatedImport).not.toHaveBeenCalled()
      expect(
        (await resumed.adapter.getTaskStatus(intent.engineTaskId))?.status
      ).toBe(TaskStatus.Paused)
      expect(
        f.db.getTask(f.taskId)?.instances[0].payload.legacyBtActivation
      ).toMatchObject({ stage: 'bound', engineTaskId: intent.engineTaskId })
      expect(
        (await resumed.adapter.listActiveAndWaiting()).filter(
          (row) => row.infoHash === intent.expected.infoHash
        )
      ).toHaveLength(1)
      await service.drain()
    }, 30000)
    it('allows bound pause/resume and keeps every original payload on delete-with-files', async () => {
      const f = await nativeFixture()
      const incomplete = Buffer.alloc(16384, 0)
      await writeFile(
        path.join(f.downloads, 'fixture-bundle/first.bin'),
        incomplete
      )
      const wired = await f.start()
      await f.service.activate(f.taskId, async () => f.downloads)
      const intent = legacyBtActivationSchema.parse(
        f.db.getTask(f.taskId)?.instances[0].payload.legacyBtActivation
      )
      const actions = actionsFor(f, wired)
      await pauseTask(f.taskId, actions.deps)
      expect(
        (await wired.adapter.getTaskStatus(intent.engineTaskId))?.status
      ).toBe(TaskStatus.Paused)
      await resumeTask(f.taskId, actions.deps)
      expect(
        (await wired.adapter.getTaskStatus(intent.engineTaskId))?.status
      ).not.toBe(TaskStatus.Paused)
      await removeTask(f.taskId, { deleteWithFiles: true }, actions.removeDeps)
      expect(await wired.adapter.getTaskStatus(intent.engineTaskId)).toBeNull()
      expect(f.db.getTask(f.taskId)).toBeNull()
      expect(f.taskManager.isEngineTaskIdRetired(intent.engineTaskId)).toBe(
        true
      )
      expect(
        await readFile(path.join(f.downloads, 'fixture-bundle/first.bin'))
      ).toEqual(incomplete)
      expect(
        await readFile(path.join(f.downloads, 'fixture-bundle/second.bin'))
      ).toEqual(Buffer.alloc(16384, 2))
      expect(actions.cleanupFiles).not.toHaveBeenCalled()
    }, 30000)
  }
)
