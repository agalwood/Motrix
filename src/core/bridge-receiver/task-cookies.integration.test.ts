import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { handleCreateTask } from '@core/task/create-task-handler'
import { TaskManager } from '@core/task/task-manager'
import type { DownloadSubmitParams } from '@motrix/mdxp'
import { ErrorCode } from '@shared/errors'
import { DEFAULT_ENGINE_SETTINGS } from '@shared/schemas/engine-settings'
import { DEFAULT_PROXY_SETTINGS } from '@shared/schemas/proxy-settings'
import {
  type Aria2Handle,
  bundledAria2Exists,
  canBindLoopbackTcp,
  connectAdapter,
  spawnAria2ForTest,
} from '@test-utils/aria2'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { DirectPipeline } from './pipelines/direct-pipeline'
import { SubmitDownloadAdapter } from './submit-download-adapter'

describe.skipIf(!bundledAria2Exists() || !canBindLoopbackTcp())(
  'browser task cookies through the bundled engine',
  () => {
    let root: string
    let server: Server
    let base: string
    let handle: Aria2Handle
    let wired: Awaited<ReturnType<typeof connectAdapter>>
    const received = new Map<string, string | undefined>()

    beforeAll(async () => {
      root = await mkdtemp(path.join(tmpdir(), 'motrix-browser-cookies-'))
      server = createServer((req, res) => {
        received.set(req.url ?? '/', req.headers.cookie)
        res.end(
          req.headers.cookie?.includes('sid=account-') ? 'REAL_FILE' : 'NO_AUTH'
        )
      })
      await new Promise<void>((resolve) =>
        server.listen(0, '127.0.0.1', resolve)
      )
      const address = server.address()
      if (!address || typeof address === 'string')
        throw new Error('missing address')
      base = `http://127.0.0.1:${address.port}`
      handle = await spawnAria2ForTest({ baseDir: root })
      wired = await connectAdapter(handle)
      await wired.rpc.changeGlobalOption({
        'enable-dht': 'false',
        'max-concurrent-downloads': '8',
      })
    }, 30_000)

    afterAll(async () => {
      wired?.disconnect()
      await handle?.kill()
      server?.closeAllConnections()
      if (server)
        await new Promise<void>((resolve) => server.close(() => resolve()))
      if (root) await rm(root, { recursive: true, force: true })
    })

    it('downloads as separate browser accounts and keeps cookies out of task records', async () => {
      const tasks = new TaskManager()
      const gids = new Map<string, string>()
      type Deps = Parameters<typeof handleCreateTask>[1]
      const deps = {
        adapter: wired.adapter,
        settingsManager: {
          getApp: () => ({ defaultSaveDir: root }),
          getEngine: () => DEFAULT_ENGINE_SETTINGS,
          getProxy: () => DEFAULT_PROXY_SETTINGS,
        },
        finalNamePicker: { pick: async (_dir: string, name: string) => name },
        torrentMetaStore: {},
        taskManager: tasks,
        activityRecorder: { recordSubmitted: vi.fn() },
        eventBus: { emit: vi.fn() },
        publishTaskUpdate: vi.fn(),
      } as unknown as Deps
      const pipeline = new DirectPipeline({
        createTask: async (request, _unused, options) => {
          const result = await handleCreateTask(request, deps, options)
          gids.set(result.taskId, result.gid)
          return result
        },
        removeTask: async () => {},
      })
      let serial = 0
      const adapter = new SubmitDownloadAdapter({
        defaultSaveDir: root,
        pickName: async (_dir, name) => name,
        mintTaskId: () => `browser-cookie-${++serial}`,
      })
      await Promise.all(
        ['account-A', 'account-B', null].map(async (account, index) => {
          // Start at the typed core boundary so the fixture can use a
          // loopback URL without MDXP's public-hostname restriction.
          const input: DownloadSubmitParams = {
            source: {
              pageUrl: base,
              pageTitle: 'Fixture',
              detectedAt: Date.now(),
            },
            selection: {
              kind: 'direct',
              primary: {
                url: `${base}/file-${index}`,
                headers: { Cookie: 'sid=RAW_HEADER_MUST_NOT_WIN' },
                cookies: account
                  ? [
                      {
                        name: 'sid',
                        value: account,
                        domain: '127.0.0.1',
                        path: '/',
                        secure: false,
                        httpOnly: false,
                        sameSite: 'unspecified',
                        expiresAt: Date.now() + 60000,
                      },
                    ]
                  : [],
                refererPolicy: 'strict-origin-when-cross-origin',
              },
            },
            meta: {
              suggestedFilename: `file-${index}.bin`,
              qualityLabel: 'original',
            },
          }
          const adapted = await adapter.adapt(input, {
            extensionId: 'fixture',
            browser: 'chromium',
          })
          if (adapted.kind !== 'direct') throw new Error('expected direct')
          const { taskId } = await pipeline.dispatch(adapted)
          const gid = gids.get(taskId)
          if (!gid) throw new Error('missing engine id')
          await vi.waitFor(
            async () => {
              expect((await wired.rpc.tellStatus(gid)).status).toBe('complete')
            },
            { timeout: 10_000, interval: 50 }
          )
          const task = tasks.getById(taskId)
          if (!task) throw new Error('missing task')
          expect(await readFile(task.diskPath, 'utf8')).toBe(
            account ? 'REAL_FILE' : 'NO_AUTH'
          )
          expect(received.get(`/file-${index}`)).toBe(
            account ? `sid=${account};` : undefined
          )
          expect(task.instances[0]?.payload).toMatchObject({
            directReplay: {
              replayability: 'requires-credentials',
              requestModifiers: expect.arrayContaining(['cookies']),
            },
          })
        })
      )
      const records = JSON.stringify(tasks.getAll())
      for (const secret of [
        'account-A',
        'account-B',
        'RAW_HEADER_MUST_NOT_WIN',
      ]) {
        expect(records).not.toContain(secret)
      }
    }, 20_000)

    it('restores a task cookie from the engine database after restart', async () => {
      const restartDir = path.join(root, 'restart-cookie')
      const databasePath = path.join(restartDir, 'aria2.db')
      const sessionPath = path.join(restartDir, 'aria2.session')
      await mkdir(restartDir, { recursive: true })
      const persistenceArgs = [
        '--enable-sqlite3-persistence=true',
        `--sqlite3-db-path=${databasePath}`,
        '--sqlite3-history-limit=-1',
        '--force-save=true',
        `--save-session=${sessionPath}`,
        '--save-session-interval=1',
      ]

      const first = await spawnAria2ForTest({
        baseDir: restartDir,
        extraArgs: persistenceArgs,
      })
      const firstWired = await connectAdapter(first)
      let gid: string
      try {
        gid = await firstWired.adapter.createDownload({
          uris: [`${base}/restart-cookie`],
          saveDir: restartDir,
          filename: 'restart-cookie.bin',
          cookies: [
            {
              name: 'sid',
              value: 'account-restart',
              domain: '127.0.0.1',
              path: '/',
              expiresAt: Date.now() + 300_000,
            },
          ],
          extraEngineOptions: { pause: 'true' },
        })
        await vi.waitFor(
          async () => {
            expect((await firstWired.rpc.tellStatus(gid)).status).toBe('paused')
          },
          { timeout: 10_000, interval: 50 }
        )
      } finally {
        firstWired.disconnect()
        await first.kill()
      }

      received.delete('/restart-cookie')
      const second = await spawnAria2ForTest({
        baseDir: restartDir,
        extraArgs: [...persistenceArgs, '--pause=true'],
      })
      const secondWired = await connectAdapter(second)
      try {
        await vi.waitFor(
          async () => {
            expect((await secondWired.rpc.tellStatus(gid)).status).toBe(
              'paused'
            )
          },
          { timeout: 10_000, interval: 50 }
        )
        await secondWired.rpc.unpause(gid)
        await vi.waitFor(
          async () => {
            expect((await secondWired.rpc.tellStatus(gid)).status).toBe(
              'complete'
            )
          },
          { timeout: 10_000, interval: 50 }
        )
        expect(
          await readFile(path.join(restartDir, 'restart-cookie.bin'), 'utf8')
        ).toBe('REAL_FILE')
        expect(received.get('/restart-cookie')).toBe('sid=account-restart;')
      } finally {
        secondWired.disconnect()
        await second.kill()
      }
    }, 30_000)

    it.runIf(process.env.MOTRIX_LEGACY_ARIA2_TEST_BIN)(
      'rejects an older real engine without submitting an unauthenticated task',
      async () => {
        const legacy = await spawnAria2ForTest({
          baseDir: root,
          binaryPath: process.env.MOTRIX_LEGACY_ARIA2_TEST_BIN,
        })
        const legacyWired = await connectAdapter(legacy)
        try {
          await expect(
            legacyWired.adapter.createDownload({
              uris: [`${base}/legacy`],
              saveDir: root,
              cookies: [],
            })
          ).rejects.toMatchObject({ code: ErrorCode.EngineFeatureUnavailable })
          expect(await legacyWired.rpc.tellActive()).toEqual([])
          expect(await legacyWired.rpc.tellWaiting(0, 100)).toEqual([])
          expect(received.has('/legacy')).toBe(false)
        } finally {
          legacyWired.disconnect()
          await legacy.kill()
        }
      }
    )
  }
)
