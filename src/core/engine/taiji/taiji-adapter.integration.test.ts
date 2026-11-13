import { createHash } from 'node:crypto'
import { once } from 'node:events'
import { existsSync } from 'node:fs'
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { encode } from '@motrix/torrent'
import { TaskStatus } from '@shared/types/task'
import { bundled, listen, start } from '@test-utils/taiji'
import Database from 'better-sqlite3'
import { describe, expect, it } from 'vitest'
import { TaijiStartupGuard } from './taiji-startup-guard'

describe.skipIf(!process.env.MOTRIX_TAIJI_BIN && !existsSync(bundled))(
  'TaijiAdapter (real native daemon)',
  () => {
    it('persists a paused HTTP task, resumes it after restart, and delivers native completion events', async () => {
      const directory = await mkdtemp(path.join(tmpdir(), 'motrix-taiji-http-'))
      const payload = Buffer.alloc(128 * 1024, 42)
      const requests: Array<{ cookie?: string; auth?: string }> = []
      const server = createServer((request, response) => {
        requests.push({
          cookie: request.headers.cookie,
          auth: request.headers.authorization,
        })
        response.writeHead(200, {
          'Content-Length': payload.length,
          'Content-Type': 'application/octet-stream',
        })
        response.end(payload)
      })
      let handle: Awaited<ReturnType<typeof start>> | undefined
      try {
        const port = await listen(server)
        handle = await start(directory)
        expect(handle.adapter.getFeatureReport().version).toMatch(/^taiji\//)
        const methods = await handle.rpc.listMethods()
        expect(methods).toContain('taiji.addUri')
        expect(methods).not.toContain('aria2.addUri')
        const gid = await handle.adapter.createDownload({
          uris: [`http://127.0.0.1:${port}/payload`],
          saveDir: directory,
          filename: 'payload.bin',
          cookies: [
            {
              name: 'session',
              value: 'paused',
              domain: '127.0.0.1',
              hostOnly: true,
            },
          ],
          pause: true,
          connections: 1,
        })
        expect((await handle.adapter.getTaskStatus(gid))?.status).toBe(
          TaskStatus.Paused
        )
        expect(requests).toHaveLength(0)
        await handle.rpc.saveSession()
        await handle.close()
        handle = await start(directory)
        expect((await handle.adapter.getTaskStatus(gid))?.status).toBe(
          TaskStatus.Paused
        )
        const completed: string[] = []
        handle.adapter.onDownloadComplete((id) => completed.push(id))
        await handle.adapter.resumeTask(gid)
        for (let attempt = 0; attempt < 100; attempt++) {
          if (
            (await handle.adapter.getTaskStatus(gid))?.status ===
              TaskStatus.Completed &&
            completed.includes(gid)
          )
            break
          await delay(50)
        }
        expect((await handle.adapter.getTaskStatus(gid))?.status).toBe(
          TaskStatus.Completed
        )
        expect(completed).toEqual([gid])
        expect(await readFile(path.join(directory, 'payload.bin'))).toEqual(
          payload
        )
        expect(requests.length).toBeGreaterThan(0)
        expect(
          requests.every((request) => request.cookie === 'session=paused')
        ).toBe(true)
        const nativeDb = new Database(path.join(directory, 'taiji.sqlite3'))
        try {
          nativeDb.exec(
            "CREATE TRIGGER reject_result_delete BEFORE DELETE ON http_task BEGIN SELECT RAISE(ABORT, 'test-delete-denied'); END"
          )
          await expect(
            handle.adapter.removeDownloadResult(gid)
          ).rejects.toThrow('test-delete-denied')
          expect((await handle.adapter.getTaskStatus(gid))?.status).toBe(
            TaskStatus.Completed
          )
          nativeDb.exec('DROP TRIGGER reject_result_delete')
          await handle.adapter.removeDownloadResult(gid)
          expect(
            nativeDb
              .prepare('SELECT count(*) AS count FROM http_task WHERE gid = ?')
              .get(gid)
          ).toEqual({ count: 0 })
        } finally {
          nativeDb.close()
        }
        await handle.close()
        handle = await start(directory)
        expect(await handle.adapter.getTaskStatus(gid)).toBeNull()
      } finally {
        await handle?.close()
        server.closeAllConnections()
        await new Promise<void>((resolve) => server.close(() => resolve()))
        await rm(directory, { recursive: true, force: true })
      }
    }, 30_000)

    it('uses the native cookie method and preserves paused torrent identity through polling', async () => {
      const directory = await mkdtemp(path.join(tmpdir(), 'motrix-taiji-rpc-'))
      let cookie: string | undefined
      const server = createServer((request, response) => {
        cookie = request.headers.cookie
        response.writeHead(cookie === 'session=fixture' ? 200 : 403, {
          'Content-Length': '2',
        })
        response.end('ok')
      })
      let handle: Awaited<ReturnType<typeof start>> | undefined
      try {
        const port = await listen(server)
        handle = await start(directory)
        const gid = await handle.adapter.createDownload({
          uris: [`http://127.0.0.1:${port}/cookie`],
          saveDir: directory,
          filename: 'cookie.txt',
          cookies: [
            {
              name: 'session',
              value: 'fixture',
              domain: '127.0.0.1',
              hostOnly: true,
              path: '/',
            },
          ],
          connections: 1,
        })
        for (let attempt = 0; attempt < 100; attempt++) {
          if (
            (await handle.adapter.getTaskStatus(gid))?.status ===
            TaskStatus.Completed
          )
            break
          await delay(50)
        }
        expect(await readFile(path.join(directory, 'cookie.txt'), 'utf8')).toBe(
          'ok'
        )
        expect(cookie).toBe('session=fixture')
        const torrentGid = await handle.adapter.addTorrent({
          metadata: await readFile(
            path.resolve('scripts/poc/fixtures/sample.torrent')
          ),
          saveDir: directory,
          pause: true,
        })
        const [waiting] = await handle.rpc.multicall([
          { method: 'aria2.tellWaiting', params: [0, 100, ['gid', 'status']] },
        ])
        expect(waiting).toContainEqual({ gid: torrentGid, status: 'paused' })
        expect(handle.adapter.getCapabilities().bt).toBe(true)
      } finally {
        await handle?.close()
        server.closeAllConnections()
        await new Promise<void>((resolve) => server.close(() => resolve()))
        await rm(directory, { recursive: true, force: true })
      }
    }, 30_000)
    it.each([false, true])(
      'verifies existing payloads admitted paused before entering seeding (multi-file: %s)',
      async (multiFile) => {
        const directory = await mkdtemp(
          path.join(tmpdir(), 'motrix-taiji-seed-')
        )
        const payload = Buffer.alloc(16384, 37)
        const metadata = encode({
          info: {
            name: 'seed.bin',
            ...(multiFile
              ? { files: [{ path: ['payload.bin'], length: payload.length }] }
              : { length: payload.length }),
            'piece length': payload.length,
            pieces: createHash('sha1').update(payload).digest(),
          },
        })
        let handle: Awaited<ReturnType<typeof start>> | undefined
        try {
          const output = multiFile
            ? path.join(directory, 'collection', 'disc.bin')
            : path.join(directory, 'seed.bin')
          await mkdir(path.dirname(output), { recursive: true })
          await writeFile(output, payload)
          handle = await start(directory)
          const gid = await handle.adapter.addTorrent({
            metadata,
            saveDir: directory,
            ...(multiFile
              ? {
                  outputRoot: directory,
                  outputFilePaths: [
                    { fileIndex: 0, relativePath: 'collection/disc.bin' },
                  ],
                }
              : {}),
            pause: true,
            checkIntegrity: true,
            seedRatio: 0,
            seedTime: 0,
          })
          await expect
            .poll(
              async () => (await handle!.adapter.getTaskStatus(gid))?.status
            )
            .toBe(TaskStatus.Paused)
          await handle.adapter.resumeTask(gid)
          await expect
            .poll(
              async () => (await handle!.adapter.getTaskStatus(gid))?.status
            )
            .toBe(TaskStatus.Seeding)
          expect(
            (await handle.adapter.getTaskStatus(gid))?.downloadedBytes
          ).toBe(payload.length)
          expect(await readFile(output)).toEqual(payload)
        } finally {
          await handle?.close()
          await rm(directory, { recursive: true, force: true })
        }
      },
      30_000
    )
    it('keeps recovered transfers frozen until host authorization and purges completed ownership first', async () => {
      const directory = await mkdtemp(path.join(tmpdir(), 'motrix-taiji-hold-'))
      let requests = 0
      const server = createServer((_request, response) => {
        requests++
        response.writeHead(200, { 'Content-Length': '1048576' })
        response.write(Buffer.alloc(4096))
      })
      let handle: Awaited<ReturnType<typeof start>> | undefined
      try {
        const port = await listen(server)
        handle = await start(directory)
        const gid = await handle.adapter.createDownload({
          gid: '0000000000001234',
          uris: [`http://127.0.0.1:${port}/hold`],
          saveDir: directory,
          filename: 'hold.bin',
          connections: 1,
        })
        expect(gid).toBe('0000000000001234')
        for (let i = 0; i < 100 && requests === 0; i++) await delay(20)
        expect(requests).toBeGreaterThan(0)
        await handle.close()
        const before = requests
        handle = await start(directory, true)
        await delay(150)
        expect(requests).toBe(before)
        const held = JSON.parse(
          (await handle.rpc.getGlobalOption())['motrix-startup-tasks']
        )
        expect(held).toContainEqual([gid, true])
        const guard = new TaijiStartupGuard({
          completedGids: () => new Set([gid]),
          rpc: handle.rpc,
          removeResult: (id) => handle!.adapter.removeDownloadResult(id),
        })
        await (await guard.prepare([])).reconcile(() => false)
        await delay(150)
        expect(requests).toBe(before)
        expect(await handle.adapter.getTaskStatus(gid)).toBeNull()
      } finally {
        await handle?.close()
        server.closeAllConnections()
        await new Promise<void>((resolve) => server.close(() => resolve()))
        await rm(directory, { recursive: true, force: true })
      }
    }, 30000)

    it('preserves custom BT output paths and caller GIDs across restart without changing the info hash', async () => {
      const directory = await mkdtemp(
        path.join(tmpdir(), 'motrix-taiji-mapping-')
      )
      let handle: Awaited<ReturnType<typeof start>> | undefined
      try {
        await copyFile(
          path.resolve('scripts/poc/fixtures/sample-data/test.bin'),
          path.join(directory, 'renamed.bin')
        )
        handle = await start(directory)
        const gid = await handle.adapter.addTorrent({
          gid: '0000000000005678',
          metadata: await readFile(
            path.resolve('scripts/poc/fixtures/sample.torrent')
          ),
          saveDir: path.join(directory, 'metadata.state'),
          outputRoot: directory,
          outputFilePaths: [{ fileIndex: 0, relativePath: 'renamed.bin' }],
          pause: true,
        })
        expect(gid).toBe('0000000000005678')
        const before = await handle.rpc.tellStatus(gid)
        expect(before.files[0].path).toBe(path.join(directory, 'renamed.bin'))
        await handle.rpc.saveSession()
        await handle.close()
        handle = await start(directory, true)
        const after = await handle.rpc.tellStatus(gid)
        expect(after.infoHash).toBe(before.infoHash)
        expect(after.files[0].path).toBe(before.files[0].path)
        expect(await readFile(path.join(directory, 'renamed.bin'))).toEqual(
          await readFile(
            path.resolve('scripts/poc/fixtures/sample-data/test.bin')
          )
        )
      } finally {
        await handle?.close()
        await rm(directory, { recursive: true, force: true })
      }
    }, 30000)
    it('exits when the owner pipe closes, including an ungraceful host exit', async () => {
      const directory = await mkdtemp(
        path.join(tmpdir(), 'motrix-taiji-parent-')
      )
      let handle: Awaited<ReturnType<typeof start>> | undefined
      try {
        handle = await start(directory, true, true)
        const exited = once(handle.child, 'exit', {
          signal: AbortSignal.timeout(3000),
        })
        handle.child.stdin?.end()
        const [code] = await exited
        expect(code).toBe(0)
      } finally {
        await handle?.close()
        await rm(directory, { recursive: true, force: true })
      }
    }, 10000)
    it('downloads torrent URL metadata without starting the payload', async () => {
      const directory = await mkdtemp(
        path.join(tmpdir(), 'motrix-taiji-torrent-url-')
      )
      const metadata = await readFile(
        path.resolve('scripts/poc/fixtures/sample.torrent')
      )
      const server = createServer((_request, response) => {
        response.writeHead(200, { 'Content-Length': metadata.length })
        response.end(metadata)
      })
      let handle: Awaited<ReturnType<typeof start>> | undefined
      try {
        const port = await listen(server)
        handle = await start(directory)
        const gid = await handle.rpc.addUri(
          [`http://127.0.0.1:${port}/sample.torrent`],
          {
            gid: '0000000000000061',
            dir: directory,
            'bt-metadata-only': 'true',
            'follow-torrent': 'false',
          }
        )
        for (let i = 0; i < 100; i++) {
          if (
            (await handle.adapter.getTaskStatus(gid))?.status ===
            TaskStatus.Completed
          )
            break
          await delay(25)
        }
        expect((await handle.adapter.getTaskStatus(gid))?.status).toBe(
          TaskStatus.Completed
        )
        expect(await readFile(path.join(directory, `${gid}.torrent`))).toEqual(
          metadata
        )
        expect(existsSync(path.join(directory, 'test.bin'))).toBe(false)
      } finally {
        await handle?.close()
        server.closeAllConnections()
        await new Promise<void>((resolve) => server.close(() => resolve()))
        await rm(directory, { recursive: true, force: true })
      }
    }, 15000)
    it('retains authenticated request context and retries the same failed task after restart', async () => {
      const directory = await mkdtemp(
        path.join(tmpdir(), 'motrix-taiji-retry-')
      )
      let failing = true
      const observed: unknown[] = []
      const payload = Buffer.from('retained request payload')
      const server = createServer((request, response) => {
        observed.push({
          failing,
          auth: Boolean(request.headers.authorization),
          cookie: request.headers.cookie === 'session=retained',
          agent: request.headers['user-agent'],
        })
        if (failing) {
          response.writeHead(503, { 'Content-Length': 0 })
          response.end()
          return
        }
        if (
          request.headers.authorization !== 'Bearer test-only' ||
          request.headers.cookie !== 'session=retained' ||
          request.headers['user-agent'] !== 'motrix-retained-test'
        ) {
          response.writeHead(403, { 'Content-Length': 0 })
          response.end()
          return
        }
        const match = /^bytes=(\d+)-(\d*)$/.exec(request.headers.range ?? '')
        const begin = match ? Number(match[1]) : 0
        const end = match?.[2] ? Number(match[2]) : payload.length - 1
        response.writeHead(match ? 206 : 200, {
          'Content-Length': end - begin + 1,
          'Accept-Ranges': 'bytes',
          ETag: '"retained"',
          ...(match
            ? { 'Content-Range': `bytes ${begin}-${end}/${payload.length}` }
            : {}),
        })
        response.end(payload.subarray(begin, end + 1))
      })
      let handle: Awaited<ReturnType<typeof start>> | undefined
      try {
        const port = await listen(server)
        handle = await start(directory)
        const uri = `http://127.0.0.1:${port}/retry.bin`
        const gid = await handle.adapter.createDownload({
          uris: [uri],
          saveDir: directory,
          filename: 'retry.bin',
          retainRequestContext: true,
          headers: { Authorization: 'Bearer test-only' },
          userAgent: 'motrix-retained-test',
          cookies: [
            {
              name: 'session',
              value: 'retained',
              domain: '127.0.0.1',
              hostOnly: true,
            },
          ],
          extraEngineOptions: { 'max-tries': '1', 'retry-wait': '0' },
        })
        for (let i = 0; i < 200; i++) {
          if (
            (await handle.adapter.getTaskStatus(gid))?.status ===
            TaskStatus.Error
          )
            break
          await delay(25)
        }
        expect((await handle.adapter.getTaskStatus(gid))?.status).toBe(
          TaskStatus.Error
        )
        await handle.close()
        handle = await start(directory, true)
        const input = {
          engineTaskId: gid,
          uri,
          outputPath: path.join(directory, 'retry.bin'),
        }
        expect(
          await handle.adapter.canRetryDirectTask({
            ...input,
            uri: `${uri}?changed`,
          })
        ).toBe(false)
        expect(
          await handle.adapter.canRetryDirectTask({
            ...input,
            outputPath: path.join(directory, 'stale-host-name.bin'),
          })
        ).toBe(true)
        expect(await handle.adapter.canRetryDirectTask(input)).toBe(true)
        failing = false
        await handle.adapter.retryDirectTask(input)
        for (let i = 0; i < 200; i++) {
          if (
            (await handle.adapter.getTaskStatus(gid))?.status ===
            TaskStatus.Completed
          )
            break
          await delay(25)
        }
        expect(
          await handle.rpc.tellStatus(gid),
          JSON.stringify(observed)
        ).toMatchObject({ status: 'complete' })
        expect(await readFile(input.outputPath)).toEqual(payload)
      } finally {
        await handle?.close()
        server.closeAllConnections()
        await new Promise<void>((resolve) => server.close(() => resolve()))
        await rm(directory, { recursive: true, force: true })
      }
    }, 20000)
    it('maps file selection around BEP47 padding while preserving public file indices', async () => {
      const directory = await mkdtemp(
        path.join(tmpdir(), 'motrix-taiji-pad-selection-')
      )
      let handle: Awaited<ReturnType<typeof start>> | undefined
      try {
        const first = Buffer.concat([Buffer.alloc(4, 1), Buffer.alloc(16380)])
        const last = Buffer.alloc(4, 2)
        const metadata = encode({
          announce: 'http://127.0.0.1:9/announce',
          info: {
            name: 'pad-sample',
            'piece length': 16384,
            pieces: Buffer.concat([
              createHash('sha1').update(first).digest(),
              createHash('sha1').update(last).digest(),
            ]),
            files: [
              { length: 4, path: ['a.bin'] },
              { length: 16380, path: ['.pad', '16380'], attr: 'p' },
              { length: 4, path: ['b.bin'] },
            ],
          },
        })
        handle = await start(directory)
        const gid = await handle.adapter.addTorrent({
          metadata,
          saveDir: directory,
          selectedFiles: [3],
          pause: true,
        })
        expect(
          (await handle.adapter.getTaskFiles(gid)).map((file) => [
            file.index,
            file.selected,
          ])
        ).toEqual([
          [0, false],
          [1, false],
          [2, true],
        ])
        await handle.adapter.changeOption(gid, { 'select-file': '1' })
        expect(
          (await handle.adapter.getTaskFiles(gid)).map((file) => file.selected)
        ).toEqual([true, false, false])
      } finally {
        await handle?.close()
        await rm(directory, { recursive: true, force: true })
      }
    }, 15000)
    it('uses the current host proxy route after restarting a retained request', async () => {
      const directory = await mkdtemp(
        path.join(tmpdir(), 'motrix-taiji-proxy-retry-')
      )
      const first = createServer((_request, response) => {
        response.writeHead(503, { 'Content-Length': 0 })
        response.end()
      })
      let usedCurrent = false
      const second = createServer((request, response) => {
        usedCurrent =
          request.headers['proxy-authorization'] ===
          `Basic ${Buffer.from('new-user:new-pass').toString('base64')}`
        response.writeHead(usedCurrent ? 200 : 407, { 'Content-Length': 2 })
        response.end('ok')
      })
      let handle: Awaited<ReturnType<typeof start>> | undefined
      try {
        const oldPort = await listen(first)
        const newPort = await listen(second)
        handle = await start(directory)
        await handle.rpc.changeGlobalOption({
          'all-proxy': `http://127.0.0.1:${oldPort}`,
        })
        const uri = 'http://example.invalid/proxy.bin'
        const gid = await handle.adapter.createDownload({
          uris: [uri],
          saveDir: directory,
          filename: 'proxy.bin',
          retainRequestContext: true,
        })
        for (let i = 0; i < 200; i++) {
          if (
            (await handle.adapter.getTaskStatus(gid))?.status ===
            TaskStatus.Error
          )
            break
          await delay(25)
        }
        expect((await handle.adapter.getTaskStatus(gid))?.status).toBe(
          TaskStatus.Error
        )
        await handle.close()
        first.closeAllConnections()
        await new Promise<void>((resolve) => first.close(() => resolve()))
        handle = await start(directory, true)
        await handle.rpc.changeGlobalOption({
          'all-proxy': `http://127.0.0.1:${newPort}`,
          'all-proxy-user': 'new-user',
          'all-proxy-passwd': 'new-pass',
        })
        await handle.adapter.retryDirectTask({
          engineTaskId: gid,
          uri,
          outputPath: path.join(directory, 'proxy.bin'),
        })
        for (let i = 0; i < 200; i++) {
          if (
            (await handle.adapter.getTaskStatus(gid))?.status ===
            TaskStatus.Completed
          )
            break
          await delay(25)
        }
        expect((await handle.adapter.getTaskStatus(gid))?.status).toBe(
          TaskStatus.Completed
        )
        expect(usedCurrent).toBe(true)
      } finally {
        await handle?.close()
        first.closeAllConnections()
        second.closeAllConnections()
        await Promise.all([
          new Promise<void>((resolve) => first.close(() => resolve())),
          new Promise<void>((resolve) => second.close(() => resolve())),
        ])
        await rm(directory, { recursive: true, force: true })
      }
    }, 20000)
    it('keeps an explicit empty cookie store isolated from ambient cookies', async () => {
      const directory = await mkdtemp(
        path.join(tmpdir(), 'motrix-taiji-cookie-scope-')
      )
      let received: string | undefined
      const server = createServer((request, response) => {
        received = request.headers.cookie
        response.writeHead(200, { 'Content-Length': 2 })
        response.end('ok')
      })
      let handle: Awaited<ReturnType<typeof start>> | undefined
      try {
        const port = await listen(server)
        handle = await start(directory)
        const jar = path.join(directory, 'cookies.txt')
        await writeFile(
          jar,
          '# Netscape HTTP Cookie File\n127.0.0.1\tFALSE\t/\tFALSE\t0\tsession\tambient\n'
        )
        await handle.rpc.changeGlobalOption({ 'load-cookies': jar })
        const ambientGid = await handle.adapter.createDownload({
          uris: [`http://127.0.0.1:${port}/ambient`],
          saveDir: directory,
          filename: 'ambient.txt',
        })
        for (let i = 0; i < 100; i++) {
          if (
            (await handle.adapter.getTaskStatus(ambientGid))?.status ===
            TaskStatus.Completed
          )
            break
          await delay(25)
        }
        expect(received).toBe('session=ambient')
        received = undefined
        const gid = await handle.adapter.createDownload({
          uris: [`http://127.0.0.1:${port}/empty`],
          saveDir: directory,
          filename: 'empty.txt',
          cookies: [],
          headers: { Cookie: 'manual=forbidden' },
        })
        for (let i = 0; i < 100; i++) {
          if (
            (await handle.adapter.getTaskStatus(gid))?.status ===
            TaskStatus.Completed
          )
            break
          await delay(25)
        }
        expect((await handle.adapter.getTaskStatus(gid))?.status).toBe(
          TaskStatus.Completed
        )
        expect(received).toBeUndefined()
      } finally {
        await handle?.close()
        server.closeAllConnections()
        await new Promise<void>((resolve) => server.close(() => resolve()))
        await rm(directory, { recursive: true, force: true })
      }
    }, 15000)
  }
)
