import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { MotrixDatabase } from '@core/session/motrix-database'
import { SessionManager } from '@core/session/session-manager'
import { trackBtFilePath } from '@core/task/bt-file-paths'
import {
  createBtDirectStoragePlan,
  getBtDirectStorageLayout,
  markBtDirectOutputFinalized,
  parseBtFileLayout,
} from '@core/task/bt-storage-layout'
import { createRenameTaskFileHandler } from '@core/task/rename-task-file'
import { TaskManager } from '@core/task/task-manager'
import { encode } from '@motrix/torrent'
import {
  makeDefaultBtExtension,
  TaskInstancePhase,
  TaskKind,
  TaskStatus,
  TaskType,
  TransitionPhase,
} from '@shared/types/task'
import { bundled, listen, start } from '@test-utils/taiji'
import { makeDownloadTask } from '@test-utils/task'
import { expect, it } from 'vitest'

it.skipIf(!process.env.MOTRIX_TAIJI_BIN && !existsSync(bundled))(
  'renames paused, active and seeding payloads and recovers an interrupted host commit and missing engine task',
  async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'taiji-rename-'))
    const half = 2 * 1024 * 1024
    const payload = Buffer.concat([
      Buffer.alloc(half, 31),
      Buffer.alloc(half, 47),
    ])
    let requests = 0
    const server = createServer((request, response) => {
      requests++
      const range = /^bytes=(\d+)-(\d+)$/.exec(request.headers.range ?? '')
      const first = Number(range?.[1] ?? 0),
        last = Math.min(
          Number(range?.[2] ?? payload.length - 1),
          payload.length - 1
        )
      response.writeHead(range ? 206 : 200, {
        'Content-Length': last - first + 1,
        ...(range
          ? { 'Content-Range': `bytes ${first}-${last}/${payload.length}` }
          : {}),
      })
      const timer = setTimeout(
        () => response.end(payload.subarray(first, last + 1)),
        40
      )
      response.on('close', () => clearTimeout(timer))
    })
    const port = await listen(server)
    const metadata = encode({
      info: {
        name: 'original',
        'piece length': 16384,
        pieces: Buffer.concat(
          Array.from({ length: payload.length / 16384 }, (_, index) =>
            createHash('sha1')
              .update(payload.subarray(index * 16384, (index + 1) * 16384))
              .digest()
          )
        ),
        files: [
          { length: half, path: ['first.bin'] },
          { length: half, path: ['nested', 'second.bin'] },
        ],
      },
      'url-list': [`http://127.0.0.1:${port}/payload`],
    })
    const metadataPath = path.join(root, 'source.torrent')
    await writeFile(metadataPath, metadata)
    const layout = await parseBtFileLayout(metadata)
    const output = path.join(root, 'chosen')
    const plan = createBtDirectStoragePlan(output, layout, metadataPath)
    let engine: Awaited<ReturnType<typeof start>> | undefined
    const db = new MotrixDatabase(path.join(root, 'motrix.db'))
    db.init()
    try {
      engine = await start(root)
      const gid = await engine.adapter.addTorrent({
        metadata,
        ...plan,
        pause: true,
        gid: '1234567890abcdef',
        seedRatio: 0,
      })
      const manager = new TaskManager()
      const task = makeDownloadTask({
        id: 'owner',
        engineTaskId: gid,
        kind: TaskKind.Bt,
        type: TaskType.Bt,
        status: TaskStatus.Paused,
        name: 'chosen',
        finalName: 'chosen',
        finalPath: output,
        diskPath: output,
        saveDir: root,
        torrentMetaPath: metadataPath,
        infoHash: layout.infoHash,
        fileCount: 2,
        totalBytes: payload.length,
        bt: makeDefaultBtExtension({ selectedFiles: [0, 1] }),
      })
      task.instances = [
        {
          instanceId: 'instance',
          motrixId: task.id,
          gid,
          phase: TaskInstancePhase.BtDownload,
          status: task.status,
          progress: 0,
          totalBytes: payload.length,
          downloadedBytes: 0,
          uploadedBytes: 0,
          diskPath: output,
          transitionPhase: TransitionPhase.Idle,
          uris: [],
          uriHash: null,
          payload: { btStorageLayout: plan.layout },
          createdAt: 1,
          updatedAt: 1,
        },
      ]
      manager.set(task.id, task)
      const session = new SessionManager(
        manager,
        engine.rpc,
        db,
        engine.adapter
      )
      await session.persistTaskFiles(
        task,
        await engine.adapter.getTaskFiles(gid)
      )
      const rename = createRenameTaskFileHandler({
        nativeFileMutation: async (_taskId, operation) => operation(),
        taskManager: manager,
        engine: engine.adapter,
        runTaskMutation: async (_ids, operation) => operation(),
        persistTask: (task) => session.persistTask(task),
        persistTaskFiles: (task, files) =>
          session.persistTaskFiles(task, files),
        publishTaskUpdate: () => {},
        publishFiles: () => {},
      })
      const edit = (index: number, expectedName: string, name: string) =>
        rename({
          taskId: task.id,
          engineTaskId: gid,
          fileIndex: index,
          expectedName,
          name,
        })
      await edit(0, 'first.bin', 'paused.bin')
      await writeFile(path.join(output, 'occupied.bin'), 'foreign')
      await expect(edit(0, 'paused.bin', 'occupied.bin')).rejects.toThrow(
        'task.fileRename.conflict'
      )
      expect(await readFile(path.join(output, 'occupied.bin'), 'utf8')).toBe(
        'foreign'
      )
      await engine.adapter.resumeTask(gid)
      manager.set(task.id, {
        ...manager.getById(task.id)!,
        status: TaskStatus.Downloading,
      })
      await expect
        .poll(
          async () =>
            (await engine!.adapter.getTaskStatus(gid))!.downloadedBytes,
          { interval: 20, timeout: 10000 }
        )
        .toBeGreaterThan(0)
      const before = (await engine.adapter.getTaskStatus(gid))!.downloadedBytes
      await edit(1, 'second.bin', 'active.bin')
      await expect
        .poll(async () => (await engine!.adapter.getTaskStatus(gid))!.status, {
          timeout: 20000,
        })
        .toBe(TaskStatus.Seeding)
      expect(
        (await engine.adapter.getTaskStatus(gid))!.downloadedBytes
      ).toBeGreaterThanOrEqual(before)
      const completed = {
        ...manager.getById(task.id)!,
        status: TaskStatus.Seeding,
        downloadedBytes: payload.length,
        progress: 1,
      }
      markBtDirectOutputFinalized(completed)
      manager.set(task.id, completed)
      await edit(0, 'paused.bin', 'seed.bin')
      await expect
        .poll(async () => (await engine!.adapter.getTaskStatus(gid))!.status)
        .toBe(TaskStatus.Seeding)
      expect(await readFile(path.join(output, 'seed.bin'))).toEqual(
        payload.subarray(0, half)
      )
      expect(await readFile(path.join(output, 'nested/active.bin'))).toEqual(
        payload.subarray(half)
      )
      expect(
        Buffer.from(
          (await engine.adapter.getTorrentMetadata(gid)).data,
          'base64'
        )
      ).toEqual(Buffer.from(metadata))
      // The process dies after engine commit, before the host sees its reply.
      const files = await engine.adapter.getTaskFiles(gid)
      const tracked = trackBtFilePath(manager.getById(task.id)!, files[1])
      await session.persistTaskFiles(tracked, files)
      await engine.adapter.renameTaskFile(
        gid,
        1,
        files[1].path,
        path.join(output, 'nested/recovered.bin')
      )
      const late = await session.reconcileTaskFilePaths(
        manager.getById(task.id)!,
        await engine.adapter.getTaskFiles(gid)
      )
      expect(late.changed).toBe(true)
      expect(db.getTaskFilePath(task.id, 1)).toBe(
        path.join(output, 'nested/recovered.bin')
      )
      // Restore the older durable snapshot to also exercise startup repair.
      await session.persistTaskFiles(tracked, files)
      await engine.close()
      engine = await start(root)
      const restored = new TaskManager()
      const recovery = new SessionManager(
        restored,
        engine.rpc,
        db,
        engine.adapter
      )
      await recovery.restore()
      expect(
        getBtDirectStorageLayout(restored.getById(task.id)!)?.filePaths
      ).toEqual({ 0: 'seed.bin', 1: path.join('nested', 'recovered.bin') })
      expect(db.getTaskFiles(task.id)[1].path).toBe(
        path.join(output, 'nested/recovered.bin')
      )
      await engine.adapter.forceRemoveTask(gid)
      await engine.adapter.removeDownloadResult(gid)
      const count = requests
      await recovery.restore()
      const recreated = restored.getById(task.id)!
      expect(recreated.engineTaskId).not.toBe(gid)
      await expect
        .poll(
          async () =>
            (await engine!.adapter.getTaskStatus(recreated.engineTaskId))!
              .downloadedBytes,
          { timeout: 10000 }
        )
        .toBe(payload.length)
      expect(requests).toBe(count)
      expect(
        (await engine.adapter.getTaskFiles(recreated.engineTaskId)).map(
          (file) => file.path
        )
      ).toEqual([
        path.join(output, 'seed.bin'),
        path.join(output, 'nested/recovered.bin'),
      ])
      expect(await readFile(metadataPath)).toEqual(Buffer.from(metadata))
    } finally {
      await engine?.close()
      db.close()
      server.closeAllConnections()
      await new Promise<void>((resolve) => server.close(() => resolve()))
      await rm(root, { recursive: true, force: true })
    }
  },
  60000
)

it.skipIf(!process.env.MOTRIX_TAIJI_BIN && !existsSync(bundled))(
  'preserves a v2 infohash when a renamed file is restored',
  async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'taiji-v2-rename-'))
    const metadata = encode({
      info: {
        name: 'original',
        'meta version': 2,
        'piece length': 16384,
        'file tree': {
          'first.bin': {
            '': {
              length: 1,
              'pieces root': createHash('sha256').update('x').digest(),
            },
          },
        },
      },
    })
    let engine: Awaited<ReturnType<typeof start>> | undefined
    try {
      engine = await start(root)
      const gid = await engine.adapter.addTorrent({
        metadata,
        saveDir: root,
        outputRoot: path.join(root, 'payload'),
        outputFilePaths: [{ fileIndex: 0, relativePath: 'first.bin' }],
        pause: true,
      })
      const before = await engine.adapter.getTorrentMetadata(gid)
      const file = (await engine.adapter.getTaskFiles(gid))[0]
      await engine.adapter.renameTaskFile(
        gid,
        0,
        file.path,
        path.join(path.dirname(file.path), 'changed.bin')
      )
      await engine.close()
      engine = await start(root)
      const after = await engine.adapter.getTorrentMetadata(gid)
      expect(after.manifest.v2).toBe(before.manifest.v2)
      expect(after.data).toBe(before.data)
      expect((await engine.adapter.getTaskFiles(gid))[0].path).toBe(
        path.join(root, 'payload/changed.bin')
      )
    } finally {
      await engine?.close()
      await rm(root, { recursive: true, force: true })
    }
  }
)
