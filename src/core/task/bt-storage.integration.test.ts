// @vitest-environment node
import { existsSync } from 'node:fs'
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { Aria2RpcClient } from '@core/engine/aria2/aria2-rpc-client'
import type { EngineAdapter } from '@core/engine/engine-adapter'
import { EventBus } from '@core/events/event-bus'
import { getLogger } from '@core/logger'
import { NativeFinalizeFilesystemAdapter } from '@core/plugin/finalize/filesystem-adapter'
import { NativeFinalizeArtifactOperations } from '@core/plugin/finalize/native-artifact-operations'
import { DurableFinalizeRuntime } from '@core/session/durable-finalize-runtime'
import { MotrixDatabase } from '@core/session/motrix-database'
import { SessionManager } from '@core/session/session-manager'
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
import { afterEach, describe, expect, it, vi } from 'vitest'
import { parseBtFileLayout } from './bt-storage-layout'
import { authorizeBtDirectory, BtStorageService } from './bt-storage-service'
import { TaskManager } from './task-manager'
import { TorrentMetaStoreImpl } from './torrent-meta-store'

const binary = path.resolve(
  process.env.MOTRIX_FINALIZE_FS_TEST_BIN ??
    'packages/finalize-fs/target/debug/motrix-finalize-fs'
)
describe.skipIf(!existsSync(binary))(
  'BT storage with native publication and SQLite',
  () => {
    const cleanups: Array<() => Promise<void>> = []
    afterEach(async () => {
      vi.restoreAllMocks()
      for (const cleanup of cleanups.splice(0)) await cleanup()
    })

    async function setup(multiFile: boolean) {
      const root = await realpath(
        await mkdtemp(path.join(tmpdir(), 'motrix-bt-native-'))
      )
      await mkdir(path.join(root, 'old'))
      await mkdir(path.join(root, 'new'))
      const source = path.join(root, 'old', 'payload')
      const target = path.join(root, 'new', 'payload')
      const data = 'complete torrent payload'
      const files = multiFile
        ? [
            { name: 'first', data: data.slice(0, 5) },
            { name: 'second', data: data.slice(5) },
          ]
        : [{ name: 'original', data }]
      const metadata = storageTorrent(files, multiFile)
      if (multiFile) {
        await mkdir(source)
        for (const file of files)
          await writeFile(path.join(source, file.name), file.data)
      } else await writeFile(source, data)
      const store = new TorrentMetaStoreImpl(path.join(root, 'metadata'))
      const task = makeDownloadTask({
        id: 'task',
        engineTaskId: '0123456789abcdef',
        type: TaskType.Bt,
        kind: TaskKind.Bt,
        status: TaskStatus.Completed,
        finalPath: source,
        diskPath: source,
        saveDir: path.dirname(source),
        finalName: 'payload',
        name: 'payload',
        torrentMetaPath: await store.persist('task', metadata),
        infoHash: (await parseBtFileLayout(metadata)).infoHash,
        totalBytes: data.length,
        downloadedBytes: data.length,
        progress: 1,
        createdAt: 100,
        finishedAt: 200,
        bt: makeDefaultBtExtension({
          selectedFiles: files.map((_, index) => index),
        }),
        instances: [
          {
            instanceId: 'primary:task',
            motrixId: 'task',
            gid: '0123456789abcdef',
            phase: TaskInstancePhase.BtDownload,
            status: TaskStatus.Completed,
            diskPath: source,
            transitionPhase: TransitionPhase.Idle,
            progress: 1,
            totalBytes: data.length,
            downloadedBytes: data.length,
            uploadedBytes: 0,
            uris: [],
            uriHash: null,
            payload: {},
            createdAt: 100,
            updatedAt: 200,
          },
        ],
      })
      const taskManager = new TaskManager()
      taskManager.add(task)
      const adapter = {
        listActiveAndWaiting: async () => [],
        forceRemoveTask: async () => {},
        removeDownloadResult: async () => {},
        getUploadLength: async () => 0,
      } as unknown as EngineAdapter
      const db = new MotrixDatabase(path.join(root, 'motrix.db'))
      db.init()
      const session = new SessionManager(
        taskManager,
        {} as Aria2RpcClient,
        db,
        adapter
      )
      await session.persistTask(task)
      db.replaceTaskFiles(
        task.id,
        files.map((file, fileIndex) => ({
          fileIndex,
          path: multiFile ? path.join(source, file.name) : source,
          size: file.data.length,
          selected: true,
        }))
      )
      const setTask = taskManager.set.bind(taskManager)
      vi.spyOn(taskManager, 'set').mockImplementation((id, next) => {
        if (next.finalPath === target)
          expect(db.database.inTransaction).toBe(false)
        setTask(id, next)
      })
      const native = new NativeFinalizeFilesystemAdapter(binary)
      const fs = new NativeFinalizeArtifactOperations(native)
      const runtime = new DurableFinalizeRuntime({
        db: db.database,
        session,
        fs,
      })
      const service = new BtStorageService({
        taskManager,
        adapter,
        runtime,
        torrentMetaStore: store,
        log: getLogger('storage-test'),
        eventBus: new EventBus(),
        publishTaskUpdate: () => {},
        publishTaskUpdateNow: () => {},
        persistTask: (next) => session.persistTask(next),
        persistStorage: (next, from, to) =>
          session.persistBtStorage(next, from, to),
        authorizeDirectory: authorizeBtDirectory,
        runTaskMutation: async (_ids, operation) => operation(),
      })
      cleanups.push(async () => {
        await native.dispose()
        db.close()
        await rm(root, { recursive: true, force: true })
      })
      return {
        root,
        source,
        target,
        task,
        files,
        data,
        db,
        service,
        fs,
        runtime,
        session,
        taskManager,
      }
    }

    it.each([false, true])(
      'publishes the payload and file-cache paths atomically (multi-file=%s)',
      async (multiFile) => {
        const f = await setup(multiFile)
        expect(
          await f.service.run({
            taskId: 'task',
            mode: 'move',
            directory: path.dirname(f.target),
            name: 'payload',
          })
        ).toMatchObject({ path: f.target, verification: { complete: true } })
        expect(existsSync(f.source)).toBe(false)
        expect(
          await readFile(
            multiFile ? path.join(f.target, 'second') : f.target,
            'utf8'
          )
        ).toBe(multiFile ? f.data.slice(5) : f.data)
        expect(f.db.getTask('task')?.task).toMatchObject({
          motrixId: 'task',
          finalPath: f.target,
          createdAt: 100,
          finishedAt: 200,
        })
        expect(f.db.getTask('task')?.instances[0].diskPath).toBe(f.target)
        expect(
          f.db
            .getTaskFiles('task')
            .every((file) => file.path.startsWith(f.target))
        ).toBe(true)
        await f.runtime.recoverAll()
        expect(f.taskManager.getById('task')?.finalPath).toBe(f.target)
      }
    )

    it('uses the verified copy protocol across filesystems', async () => {
      const f = await setup(false)
      vi.spyOn(f.fs, 'sameFilesystem').mockResolvedValue(false)
      const copy = vi.spyOn(f.fs, 'materializePrivate')
      expect(
        await f.service.run({
          taskId: 'task',
          mode: 'move',
          directory: path.dirname(f.target),
          name: 'payload',
        })
      ).toMatchObject({ path: f.target })
      expect(copy).toHaveBeenCalled()
      expect(await readFile(f.target, 'utf8')).toBe(f.data)
      expect(existsSync(f.source)).toBe(false)
    })

    it('restores the original payload and paths when the database commit fails', async () => {
      const f = await setup(true)
      const commit = f.db.commitTerminalHookBoundary.bind(f.db)
      vi.spyOn(f.db, 'commitTerminalHookBoundary').mockImplementation(
        (input) => {
          if (input.payload.task.finalPath === f.target)
            throw new Error('database full')
          return commit(input)
        }
      )
      expect(
        await f.service.run({
          taskId: 'task',
          mode: 'move',
          directory: path.dirname(f.target),
          name: 'payload',
        })
      ).toEqual({ error: 'failed' })
      await f.runtime.recoverAll()
      expect(await readFile(path.join(f.source, 'first'), 'utf8')).toBe(
        f.data.slice(0, 5)
      )
      expect(existsSync(f.target)).toBe(false)
      expect(f.db.getTask('task')?.task.finalPath).toBe(f.source)
      expect(
        f.db
          .getTaskFiles('task')
          .every((file) => file.path.startsWith(f.source))
      ).toBe(true)
    })
  }
)
