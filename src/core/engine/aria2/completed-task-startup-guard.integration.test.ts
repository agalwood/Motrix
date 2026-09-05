// @vitest-environment node
import { access, mkdtemp, rm, unlink } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { MotrixDatabase } from '@core/session/motrix-database'
import { SessionManager } from '@core/session/session-manager'
import { CompletedEngineTaskCleanup } from '@core/task/completed-engine-task-cleanup'
import { TaskManager } from '@core/task/task-manager'
import { TaskStatus } from '@shared/types/task'
import {
  type Aria2Handle,
  bundledAria2Exists,
  canBindLoopbackTcp,
  connectAdapter,
  spawnAria2ForTest,
} from '@test-utils/aria2'
import { describe, expect, it, vi } from 'vitest'
import { CompletedTaskStartupGuard } from './completed-task-startup-guard'

describe.skipIf(!bundledAria2Exists() || !canBindLoopbackTcp())(
  'completed RPC lifecycle with real aria2',
  () => {
    it.each([false, true])(
      'blocks old completed rows before requests, preserves run intent and accepts fresh work (sqlite=%s)',
      async (sqlite) => {
        const root = await mkdtemp(
          path.join(tmpdir(), 'motrix-completed-real-')
        )
        const counts = new Map<string, number>()
        const server = createServer((req, res) => {
          const route = req.url ?? '/'
          counts.set(route, (counts.get(route) ?? 0) + 1)
          if (route.startsWith('/slow')) {
            res.writeHead(200, { 'content-length': 1000000 })
            res.write(Buffer.alloc(128))
          } else res.end('completed fixture')
        })
        let handle: Aria2Handle | undefined
        let wired!: Awaited<ReturnType<typeof connectAdapter>>
        let database: MotrixDatabase | undefined
        try {
          await new Promise<void>((resolve) =>
            server.listen(0, '127.0.0.1', resolve)
          )
          const address = server.address()
          if (!address || typeof address === 'string')
            throw new Error('missing fixture port')
          const base = `http://127.0.0.1:${address.port}`
          const session = path.join(root, 'aria2.session')
          const args = [
            `--save-session=${session}`,
            '--force-save=true',
            '--pause=false',
            ...(sqlite
              ? [
                  '--enable-sqlite3-persistence=true',
                  `--sqlite3-db-path=${root}/aria2.db`,
                ]
              : []),
          ]
          handle = await spawnAria2ForTest({ baseDir: root, extraArgs: args })
          wired = await connectAdapter(handle)
          const done = await wired.rpc.addUri([`${base}/done.bin`])
          await vi.waitFor(
            async () =>
              expect((await wired.rpc.tellStatus(done)).status).toBe(
                'complete'
              ),
            { timeout: 10000 }
          )
          const run = await wired.rpc.addUri([`${base}/slow-running.bin`])
          const paused = await wired.rpc.addUri([`${base}/slow-paused.bin`], {
            pause: 'true',
          })
          await vi.waitFor(
            async () =>
              expect((await wired.rpc.tellStatus(run)).status).toBe('active'),
            { timeout: 10000 }
          )
          await wired.rpc.saveSession()
          wired.disconnect()
          await handle.kill()
          await unlink(path.join(root, 'done.bin'))
          const requestsBefore = counts.get('/done.bin')
          const restartArgs = sqlite
            ? args
            : [...args, `--input-file=${session}`]
          const guard = new CompletedTaskStartupGuard({
            completedGids: () => new Set([done]),
            get rpc() {
              return wired.rpc
            },
            removeResult: (gid) => wired.adapter.removeDownloadResult(gid),
          })
          const prepared = await guard.prepare(restartArgs)
          expect(prepared).not.toBeNull()
          handle = await spawnAria2ForTest({
            baseDir: root,
            extraArgs: prepared!.args,
          })
          wired = await connectAdapter(handle)
          expect((await wired.rpc.tellStatus(done)).status).toBe('paused')
          await prepared!.reconcile(() => false)
          await vi.waitFor(
            async () =>
              expect((await wired.rpc.tellStatus(run)).status).toBe('active'),
            { timeout: 10000 }
          )
          expect((await wired.rpc.tellStatus(paused)).status).toBe('paused')
          expect(counts.get('/done.bin')).toBe(requestsBefore)
          await expect(
            access(path.join(root, 'done.bin'))
          ).rejects.toMatchObject({ code: 'ENOENT' })

          const fresh = await wired.rpc.addUri([`${base}/fresh.bin`])
          await vi.waitFor(
            async () =>
              expect((await wired.rpc.tellStatus(fresh)).status).toBe(
                'complete'
              ),
            { timeout: 10000 }
          )
          const taskManager = new TaskManager()
          database = new MotrixDatabase(path.join(root, 'motrix.db'))
          database.init()
          const sessionManager = new SessionManager(
            taskManager,
            wired.rpc,
            database,
            wired.adapter
          )
          const persist = vi.fn(
            sessionManager.persistTaskWithOccurrence.bind(sessionManager)
          )
          const cleanup = new CompletedEngineTaskCleanup({
            taskManager,
            adapter: wired.adapter,
            mintTaskId: () => 'fresh-task',
            persist,
            adopt: async (_task, write) => write(),
            publish: () => {},
            dispatch: async () => {},
            runTaskMutation: async (_ids, operation) => operation(),
            log: { warn: vi.fn() },
          })
          await cleanup.observe((await wired.adapter.getTaskStatus(fresh))!)
          expect(taskManager.getById('fresh-task')?.status).toBe(
            TaskStatus.Completed
          )
          expect(persist).toHaveBeenCalledOnce()
          expect(database.getTask('fresh-task')).toMatchObject({
            task: {
              aggStatus: TaskStatus.Completed,
              totalBytes: 17,
              downloadedBytes: 17,
            },
            instances: [
              { gid: fresh, status: TaskStatus.Completed, downloadedBytes: 17 },
            ],
          })
          expect(sessionManager.getCompletedDirectEngineTaskIds()).toEqual(
            new Set([fresh])
          )
          await expect(wired.rpc.tellStatus(fresh)).rejects.toThrow(
            /not found/i
          )
          await cleanup.stopAndDrain()
          await wired.rpc.saveSession()
          wired.disconnect()
          await handle.kill()
          await unlink(path.join(root, 'fresh.bin'))
          handle = await spawnAria2ForTest({
            baseDir: root,
            extraArgs: restartArgs,
          })
          wired = await connectAdapter(handle)
          await expect(wired.rpc.tellStatus(fresh)).rejects.toThrow(
            /not found/i
          )
          expect(counts.get('/fresh.bin')).toBe(1)
          await expect(
            access(path.join(root, 'fresh.bin'))
          ).rejects.toMatchObject({ code: 'ENOENT' })
          wired.disconnect()
        } finally {
          wired?.disconnect()
          await handle?.kill()
          database?.close()
          server.closeAllConnections()
          await new Promise<void>((resolve) => server.close(() => resolve()))
          await rm(root, { recursive: true, force: true })
        }
      },
      45000
    )
  }
)
