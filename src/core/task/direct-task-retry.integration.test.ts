import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { MotrixDatabase } from '@core/session/motrix-database'
import { SessionManager } from '@core/session/session-manager'
import { DEFAULT_ENGINE_SETTINGS } from '@shared/schemas/engine-settings'
import { DEFAULT_PROXY_SETTINGS } from '@shared/schemas/proxy-settings'
import { type DownloadTask, TaskStatus } from '@shared/types/task'
import {
  bundledAria2Exists,
  canBindLoopbackTcp,
  connectAdapter,
  spawnAria2ForTest,
} from '@test-utils/aria2'
import { directTaskUpdatePublication } from '@test-utils/task-update'
import { beforeAll, describe, expect, it, vi } from 'vitest'
import { type ReAddTaskDeps, reAddTask } from './actions/re-add-task'
import { handleCreateTask } from './create-task-handler'
import { createGetTaskHttpRetryAvailabilityHandler } from './direct-task-retry'
import { mergeEngineTask } from './merge-engine-task'
import { shouldEvictFromEngine } from './should-evict-from-engine'
import { TaskManager } from './task-manager'

const requireNativeHttpRetry =
  process.env.MOTRIX_REQUIRE_HTTP_RETRY_TEST === '1'
const nativeRetryEnvironmentAvailable =
  bundledAria2Exists() && canBindLoopbackTcp()

describe.skipIf(!requireNativeHttpRetry && !nativeRetryEnvironmentAvailable)(
  'native authenticated HTTP continuation',
  () => {
    beforeAll(() => {
      if (!nativeRetryEnvironmentAvailable)
        throw new Error(
          'Native HTTP retry tests require the target engine and loopback TCP access'
        )
    })
    it.for([
      { empty: false, restart: false },
      { empty: true, restart: false },
      { empty: false, restart: true },
      { empty: true, restart: true },
    ])(
      'keeps the original task and partial bytes: %j',
      { timeout: 30000 },
      async ({ empty, restart }, context) => {
        const root = await mkdtemp(
          path.join(tmpdir(), 'motrix-http-continuation-')
        )
        const saveDir = path.join(root, 'downloads')
        await mkdir(saveDir)
        const payload = Buffer.alloc(4 * 1024 * 1024, 0x6d)
        let interrupted = true
        const requests: Array<{ range?: string; cookie?: string }> = []
        const server = createServer((req, res) => {
          requests.push({
            range: req.headers.range,
            cookie: req.headers.cookie,
          })
          const range = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range ?? '')
          const offset = Number(range?.[1] ?? 0)
          const end = range?.[2] ? Number(range[2]) : payload.length - 1
          const body = payload.subarray(offset, end + 1)
          res.writeHead(range ? 206 : 200, {
            'content-length': body.length,
            'accept-ranges': 'bytes',
            etag: '"unchanged-fixture"',
            ...(range
              ? { 'content-range': `bytes ${offset}-${end}/${payload.length}` }
              : {}),
          })
          if (interrupted) {
            res.write(body.subarray(0, 512 * 1024))
            setTimeout(() => res.destroy(), 100)
          } else res.end(body)
        })
        await new Promise<void>((resolve) =>
          server.listen(0, '127.0.0.1', resolve)
        )
        const address = server.address()
        if (!address || typeof address === 'string')
          throw new Error('missing address')
        const uri = `http://127.0.0.1:${address.port}/fixture.bin`
        const extraArgs = [
          '--enable-sqlite3-persistence=true',
          `--sqlite3-db-path=${path.join(root, 'aria2.db')}`,
          '--force-save=true',
          '--max-tries=1',
          '--file-allocation=none',
          '--split=1',
          '--max-connection-per-server=1',
        ]
        let handle = await spawnAria2ForTest({ baseDir: root, extraArgs })
        let wired = await connectAdapter(handle)
        let database: MotrixDatabase | undefined
        try {
          if (
            !(await wired.rpc.listMethods()).includes(
              'aria2.retryHttpDownloadV1'
            )
          ) {
            if (requireNativeHttpRetry)
              throw new Error('Native HTTP retry engine required')
            context.skip()
            return
          }
          let tasks = new TaskManager()
          database = new MotrixDatabase(path.join(root, 'motrix.db'))
          database.init()
          let session = new SessionManager(
            tasks,
            wired.rpc,
            database,
            wired.adapter
          )
          const deps = {
            adapter: wired.adapter,
            settingsManager: {
              getApp: () => ({ defaultSaveDir: saveDir }),
              getEngine: () => DEFAULT_ENGINE_SETTINGS,
              getProxy: () => DEFAULT_PROXY_SETTINGS,
            },
            finalNamePicker: {
              pick: async (_dir: string, name: string) => name,
            },
            torrentMetaStore: {},
            taskManager: tasks,
            activityRecorder: { recordSubmitted: vi.fn() },
            eventBus: { emit: vi.fn() },
            publishTaskUpdate: vi.fn(),
            persistTask: (task: DownloadTask) => session.persistTask(task),
          } as unknown as Parameters<typeof handleCreateTask>[1]
          const created = await handleCreateTask(
            {
              type: 'http',
              uris: [uri],
              saveDir,
              filename: 'fixture.bin',
              headers: [{ name: 'Referer', value: uri }],
            },
            deps,
            {
              source: 'bridge',
              cookies: empty
                ? []
                : [
                    {
                      name: 'sid',
                      value: 'synthetic-session',
                      domain: '127.0.0.1',
                      path: '/',
                    },
                  ],
            }
          )
          await vi.waitFor(
            async () =>
              expect((await wired.rpc.tellStatus(created.gid)).status).toBe(
                'error'
              ),
            { timeout: 10000, interval: 30 }
          )
          const original = tasks.getById(created.taskId)!
          const failed = await wired.rpc.tellStatus(created.gid)
          expect(Number(failed.completedLength)).toBeGreaterThan(0)
          tasks.set(original.id, {
            ...original,
            status: TaskStatus.Error,
            downloadedBytes: Number(failed.completedLength),
            totalBytes: Number(failed.totalLength),
            instances: original.instances.map((instance) => ({
              ...instance,
              status: TaskStatus.Error,
            })),
          })
          await session.persistTask(tasks.getById(original.id)!)
          // Exercise the same terminal cleanup policy as the desktop poll loop.
          if (
            shouldEvictFromEngine(
              original.status,
              TaskStatus.Error,
              original.type,
              original
            )
          ) {
            await wired.adapter.removeDownloadResult(created.gid)
          }
          const before = await readFile(original.diskPath)
          const mark = requests.length
          if (restart) {
            wired.disconnect()
            await handle.kill()
            handle = await spawnAria2ForTest({ baseDir: root, extraArgs })
            wired = await connectAdapter(handle)
            tasks = new TaskManager()
            session = new SessionManager(
              tasks,
              wired.rpc,
              database,
              wired.adapter
            )
            await session.restore()
            expect((await wired.rpc.tellStatus(created.gid)).status).toBe(
              'paused'
            )
            const restored = tasks.getById(original.id)!
            expect(restored.status).toBe(TaskStatus.Error)
            const engineTask = await wired.adapter.getTaskStatus(created.gid)
            expect(engineTask).not.toBeNull()
            expect(mergeEngineTask(restored, engineTask!)).toBe(restored)
            expect(requests.length).toBe(mark)
          }
          interrupted = false
          const persisted = vi.fn((task: DownloadTask) =>
            session.persistTask(task)
          )
          const retryDeps = {
            adapter: wired.adapter,
            taskManager: tasks,
            eventBus: deps.eventBus,
            torrentMetaStore: deps.torrentMetaStore,
            persistTask: persisted,
            runTaskMutation: async <T>(
              _ids: readonly string[],
              operation: () => Promise<T>
            ) => operation(),
            log: {
              info: vi.fn(),
              warn: vi.fn(),
              error: vi.fn(),
              debug: vi.fn(),
            },
            ...directTaskUpdatePublication({
              taskManager: tasks,
              eventBus: deps.eventBus,
            }),
          } as unknown as ReAddTaskDeps
          expect(
            await createGetTaskHttpRetryAvailabilityHandler(
              tasks,
              wired.adapter
            )([original.id])
          ).toEqual([original.id])
          await reAddTask(original.id, retryDeps)
          await vi.waitFor(
            async () =>
              expect((await wired.rpc.tellStatus(created.gid)).status).toBe(
                'complete'
              ),
            { timeout: 10000, interval: 30 }
          )
          expect(tasks.getAll()).toHaveLength(1)
          expect(tasks.getById(original.id)).toMatchObject({
            id: original.id,
            engineTaskId: created.gid,
            diskPath: original.diskPath,
            downloadedBytes: Number(failed.completedLength),
          })
          expect(persisted).toHaveBeenCalled()
          const downloaded = await readFile(original.diskPath)
          // Compare every byte natively. Deep object equality walks millions of
          // Buffer properties and can exhaust the test deadline on Intel CI.
          expect(downloaded.equals(payload)).toBe(true)
          expect(downloaded.subarray(0, before.length).equals(before)).toBe(
            true
          )
          expect(
            requests
              .slice(mark)
              .some((request) => /^bytes=[1-9]\d*-/.test(request.range ?? ''))
          ).toBe(true)
          expect(
            requests
              .slice(mark)
              .every((request) =>
                empty
                  ? request.cookie === undefined
                  : request.cookie === 'sid=synthetic-session;'
              )
          ).toBe(true)
          expect(JSON.stringify(tasks.getAll())).not.toContain(
            'synthetic-session'
          )
        } finally {
          wired.disconnect()
          await handle.kill()
          database?.close()
          server.closeAllConnections()
          await new Promise<void>((resolve) => server.close(() => resolve()))
          await rm(root, { recursive: true, force: true })
        }
      }
    )
  }
)
