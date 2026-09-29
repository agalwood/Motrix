// @vitest-environment node
import { createHash } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { migrate } from '@core/session/migrations'
import { TaskManager } from '@core/task/task-manager'
import {
  makeDefaultBtExtension,
  TaskStatus,
  TaskType,
} from '@shared/types/task'
import {
  bundledAria2Exists,
  canBindLoopbackTcp,
  connectAdapter,
  spawnAria2ForTest,
} from '@test-utils/aria2'
import { makeDownloadTask } from '@test-utils/task'
import Database from 'better-sqlite3'
import { describe, expect, it, vi } from 'vitest'
import { TaskTrackerRepository } from './task-tracker-repository'
import { TaskTrackerService } from './task-tracker-service'

type Value = string | number | Buffer | Value[] | { [key: string]: Value }
function encode(value: Value): Buffer {
  if (typeof value === 'number') return Buffer.from(`i${value}e`)
  if (Array.isArray(value))
    return Buffer.concat([
      Buffer.from('l'),
      ...value.map(encode),
      Buffer.from('e'),
    ])
  if (typeof value === 'string' || Buffer.isBuffer(value)) {
    const bytes = Buffer.from(value)
    return Buffer.concat([Buffer.from(`${bytes.length}:`), bytes])
  }
  return Buffer.concat([
    Buffer.from('d'),
    ...Object.keys(value)
      .sort()
      .flatMap((key) => [encode(key), encode(value[key]!)]),
    Buffer.from('e'),
  ])
}
const native = 'http://127.0.0.1:9/native?passkey=kept'
const old = 'udp://127.0.0.1:10/announce'
const fresh = 'http://127.0.0.1:11/announce'
const manual = 'http://127.0.0.1:12/manual?passkey=keep'
const metadata = (isPrivate: boolean) =>
  encode({
    announce: native,
    'announce-list': [[native]],
    info: {
      name: isPrivate ? 'private.bin' : 'public.bin',
      length: 10,
      'piece length': 16384,
      pieces: createHash('sha1').update('0123456789').digest(),
      private: isPrivate ? 1 : 0,
    },
  })

describe.skipIf(!bundledAria2Exists() || !canBindLoopbackTcp())(
  'task Tracker lifecycle with real aria2 and SQLite',
  () => {
    it('replaces only owned supplements, preserves exclusions over re-add, protects private and unknown tasks', async () => {
      const root = await mkdtemp(path.join(tmpdir(), 'motrix-trackers-'))
      const handle = await spawnAria2ForTest({
        baseDir: root,
        extraArgs: [
          '--enable-dht=false',
          '--enable-dht6=false',
          '--bt-enable-lpd=false',
        ],
      })
      const wired = await connectAdapter(handle)
      const db = new Database(':memory:')
      db.pragma('foreign_keys = ON')
      migrate(db)
      const repository = new TaskTrackerRepository(db)
      const tasks = new TaskManager()
      let selected = [old]
      const actions = {
        pauseTask: vi.fn(async () => {
          throw new Error('All test tasks must remain paused')
        }),
        resumeTask: vi.fn(async () => {
          throw new Error('All test tasks must remain paused')
        }),
      }
      const service = new TaskTrackerService({
        adapter: wired.adapter,
        tasks,
        repository,
        selected: () => selected,
        actions,
      })
      wired.adapter.configureBtTrackerPolicy(service.prepareCreation)
      const make = (id: string, gid: string) => {
        db.prepare(
          'INSERT INTO tasks (motrix_id,name,task_type,created_at,updated_at) VALUES (?, ?, ?, 1, 1)'
        ).run(id, id, 'bt')
        const task = makeDownloadTask({
          id,
          engineTaskId: gid,
          status: TaskStatus.Paused,
          type: TaskType.Bt,
          torrentMetaPath: '/fixture.torrent',
          bt: makeDefaultBtExtension(),
        })
        tasks.add(task)
        return task
      }
      try {
        const task = make('public', '1234567890abcdef')
        await wired.adapter.addTorrent({
          gid: task.engineTaskId,
          metadata: metadata(false),
          saveDir: root,
          pause: true,
          extraEngineOptions: { 'bt-tracker': manual },
        })
        expect(await wired.adapter.getTaskBtTracker(task.engineTaskId)).toEqual(
          [manual, old]
        )
        const initial = await service.plan(task.id, task.engineTaskId)
        expect(initial.added).toEqual([])
        selected = [fresh]
        const plan = await service.plan(task.id, task.engineTaskId)
        expect(plan).toMatchObject({
          added: [fresh],
          removed: [old],
          requiresPause: false,
        })
        await service.apply(task.id, task.engineTaskId, plan.fingerprint)
        expect(await wired.adapter.getTaskBtTracker(task.engineTaskId)).toEqual(
          [manual, fresh]
        )
        expect(
          (
            await wired.adapter.getTaskStatus(task.engineTaskId)
          )?.bt?.announceList.flat()
        ).toContain(native)
        await service.edit(task.id, task.engineTaskId, [manual])
        expect(repository.get(task.id)?.excluded).toContain(fresh)
        expect((await service.plan(task.id, task.engineTaskId)).added).toEqual(
          []
        )
        await wired.adapter.forceRemoveTask(task.engineTaskId)
        task.engineTaskId = '2234567890abcdef'
        tasks.set(task.id, task)
        await wired.adapter.addTorrent({
          gid: task.engineTaskId,
          metadata: metadata(false),
          saveDir: root,
          pause: true,
        })
        expect(await wired.adapter.getTaskBtTracker(task.engineTaskId)).toEqual(
          [manual]
        )
        const privateTask = make('private', '3234567890abcdef')
        await wired.adapter.addTorrent({
          gid: privateTask.engineTaskId,
          metadata: metadata(true),
          saveDir: root,
          pause: true,
          isPrivate: false,
          extraEngineOptions: {
            'bt-tracker': fresh,
            'bt-exclude-tracker': native,
            'enable-peer-exchange': 'true',
          },
        })
        expect(
          await wired.adapter.getTaskBtTracker(privateTask.engineTaskId)
        ).toEqual([])
        expect(repository.get('private')?.isPrivate).toBe(true)
        expect(
          (await service.plan('private', privateTask.engineTaskId)).added
        ).toEqual([])
        await service.edit('private', privateTask.engineTaskId, [manual])
        await wired.adapter.forceRemoveTask(privateTask.engineTaskId)
        privateTask.engineTaskId = '5234567890abcdef'
        tasks.set(privateTask.id, privateTask)
        await wired.adapter.addTorrent({
          gid: privateTask.engineTaskId,
          metadata: metadata(true),
          saveDir: root,
          pause: true,
          isPrivate: true,
        })
        expect(
          await wired.adapter.getTaskBtTracker(privateTask.engineTaskId)
        ).toEqual([manual])
        expect(repository.get('private')?.managed).toEqual([])
        expect(
          (await wired.rpc.getOption(privateTask.engineTaskId))[
            'bt-exclude-tracker'
          ]
        ).toBe('')
        expect(
          (await wired.rpc.getOption(privateTask.engineTaskId))[
            'enable-peer-exchange'
          ]
        ).toBe('false')
        const magnet = make('magnet', '4234567890abcdef')
        await wired.adapter.createDownload({
          gid: magnet.engineTaskId,
          uris: [
            'magnet:?xt=urn:btih:abcdef0123456789abcdef0123456789abcdef01',
          ],
          saveDir: root,
          pause: true,
        })
        expect(
          await wired.adapter.getTaskBtTracker(magnet.engineTaskId)
        ).toEqual([])
        expect(
          (await service.plan('magnet', magnet.engineTaskId)).protected
        ).toBe(true)
        expect(actions.pauseTask).not.toHaveBeenCalled()
      } finally {
        await service.stopAndDrain()
        wired.disconnect()
        await handle.kill()
        db.close()
        await rm(root, { recursive: true, force: true })
      }
    }, 30000)
  }
)
