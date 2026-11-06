import {
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { request } from 'node:http'
import path from 'node:path'
import {
  makeDownloadTask,
  TaskKind,
  TaskStatus,
  TaskType,
} from '@shared/types/task'
import Fastify from 'fastify'
import { afterEach, describe, expect, it } from 'vitest'
import { registerNasFileRoutes } from './file-routes'
import { NasFiles } from './files'
import { runAsNasGatewayUser } from './identity'

const cleanups: (() => Promise<unknown>)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})
async function fixture(size = 4096) {
  const root = await mkdtemp('/tmp/motrix-nas-read-')
  cleanups.push(() => rm(root, { recursive: true, force: true }))
  const downloads = path.join(root, 'downloads'),
    outside = path.join(root, 'outside')
  await mkdir(downloads)
  await mkdir(outside)
  const file = path.join(downloads, 'payload.bin'),
    payload = Buffer.alloc(size, 0x4d)
  await writeFile(file, payload)
  let allowed = true,
    beforeCheck: ((candidate: string) => Promise<void>) | undefined
  const files = new NasFiles({
    platform: 'synology',
    authorizedRoots: async () => [downloads],
    checkAccess: async (_user, candidate) => {
      await beforeCheck?.(candidate)
      return allowed
    },
  })
  const policy = await files.policy(downloads)
  const task = makeDownloadTask({
    id: 'test-task',
    name: 'payload.bin',
    kind: TaskKind.Direct,
    type: TaskType.Http,
    status: TaskStatus.Completed,
    saveDir: downloads,
    createdAt: 1,
    updatedAt: 1,
    filename: 'payload.bin',
    finalName: 'payload.bin',
    source: 'user',
    sourceMeta: null,
    instances: [],
    fileCount: 1,
    diskPath: file,
    finalPath: file,
  })
  const app = Fastify()
  app.addHook('preHandler', (req, _reply, done) => {
    if (req.headers.cookie === 'synthetic')
      runAsNasGatewayUser(
        {
          platform: 'synology',
          userId: '1700',
          username: 'alice',
          administrator: true,
        },
        done
      )
    else done()
  })
  registerNasFileRoutes(app, {
    files,
    policy,
    getTask: (id) => (id === task.id ? task : undefined),
    webBasePath: '',
    fileManagerUrl: (folder) => `/?folder=${encodeURIComponent(folder)}`,
  })
  cleanups.push(() => app.close())
  return {
    app,
    task,
    root,
    downloads,
    outside,
    file,
    payload,
    deny: () => {
      allowed = false
    },
    onCheck: (callback: typeof beforeCheck) => {
      beforeCheck = callback
    },
  }
}
describe.skipIf(process.platform !== 'linux')(
  'NAS descriptor-backed file routes',
  () => {
    it('serves task-owned bytes and ranges with safe attachment headers, rejecting missing identity', async () => {
      const f = await fixture()
      const denied = await f.app.inject({
        method: 'GET',
        url: '/api/nas/tasks/test-task/file',
      })
      expect(denied.statusCode).toBe(403)
      const result = await f.app.inject({
        method: 'GET',
        url: '/api/nas/tasks/test-task/file',
        headers: { cookie: 'synthetic', range: 'bytes=10-39' },
      })
      expect(result.statusCode).toBe(206)
      expect(result.rawPayload).toEqual(f.payload.subarray(10, 40))
      expect(result.headers['content-range']).toBe('bytes 10-39/4096')
      expect(result.headers['content-disposition']).toContain('attachment;')
      expect(result.headers['x-content-type-options']).toBe('nosniff')
      const head = await f.app.inject({
        method: 'HEAD',
        url: '/api/nas/tasks/test-task/file',
        headers: { cookie: 'synthetic' },
      })
      expect(head.statusCode).toBe(200)
      expect(head.rawPayload.length).toBe(0)
      expect(head.headers['content-length']).toBe('4096')
      expect(
        (
          await f.app.inject({
            method: 'GET',
            url: '/api/nas/tasks/test-task/file',
            headers: { cookie: 'synthetic', range: 'bytes=99999-' },
          })
        ).statusCode
      ).toBe(416)
    })
    it('does not serve an outside symlink swapped in during authorization', async () => {
      const f = await fixture(),
        secret = path.join(f.outside, 'secret')
      await writeFile(secret, 'must not be returned')
      let changed = false
      f.onCheck(async (candidate) => {
        if (candidate !== f.file || changed) return
        changed = true
        await rename(f.file, `${f.file}.old`)
        await symlink(secret, f.file)
      })
      const result = await f.app.inject({
        method: 'GET',
        url: '/api/nas/tasks/test-task/file',
        headers: { cookie: 'synthetic' },
      })
      expect(result.statusCode).toBe(403)
      expect(result.body).not.toContain('must not be returned')
    })
    it('reads only authorized torrent files and rejects unrelated paths and cross-site downloads', async () => {
      const f = await fixture(),
        torrent = path.join(f.downloads, 'fixture.torrent')
      await writeFile(torrent, 'd4:infodee')
      const result = await f.app.inject({
        method: 'POST',
        url: '/api/nas/torrent',
        headers: { cookie: 'synthetic' },
        payload: { path: torrent },
      })
      expect(result.statusCode).toBe(200)
      expect(result.rawPayload).toEqual(await readFile(torrent))
      expect(
        (
          await f.app.inject({
            method: 'POST',
            url: '/api/nas/torrent',
            headers: { cookie: 'synthetic' },
            payload: { path: f.file },
          })
        ).statusCode
      ).toBe(403)
      expect(
        (
          await f.app.inject({
            method: 'GET',
            url: '/api/nas/tasks/test-task/file',
            headers: { cookie: 'synthetic', 'sec-fetch-site': 'cross-site' },
          })
        ).statusCode
      ).toBe(403)
    })
    it('cuts an in-progress response when file permission is withdrawn', async () => {
      const f = await fixture(8 * 1024 * 1024)
      await f.app.listen({ host: '127.0.0.1', port: 0 })
      const address = f.app.server.address()
      if (!address || typeof address === 'string')
        throw new Error('Missing test listener')
      const result = await new Promise<{ bytes: number; complete: boolean }>(
        (resolve, reject) => {
          const req = request(
            {
              hostname: '127.0.0.1',
              port: address.port,
              path: '/api/nas/tasks/test-task/file',
              headers: { cookie: 'synthetic' },
            },
            (res) => {
              let bytes = 0
              res.on('data', (data) => {
                bytes += data.length
                f.deny()
              })
              res.on('aborted', () => resolve({ bytes, complete: false }))
              res.on('error', () => resolve({ bytes, complete: false }))
              res.on('end', () => resolve({ bytes, complete: true }))
            }
          )
          req.on('error', reject)
          req.end()
        }
      )
      expect(result.bytes).toBeGreaterThan(0)
      expect(result.bytes).toBeLessThan(f.payload.length)
      expect(result.complete).toBe(false)
    })
  }
)
