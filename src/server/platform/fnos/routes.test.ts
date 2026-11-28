import {
  mkdir,
  mkdtemp,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises'
import path from 'node:path'
import Fastify from 'fastify'
import { afterEach, expect, it } from 'vitest'
import { NasFiles } from '../nas/files'
import { runAsNasGatewayUser } from '../nas/identity'
import { registerFnosRoutes } from './routes'

const cleanup: (() => Promise<unknown>)[] = []
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close()
})

it.skipIf(process.platform !== 'linux')(
  'does not read outside the grant when a torrent ancestor changes after ACL approval',
  async () => {
    const root = await realpath(await mkdtemp('/tmp/motrix-torrent-race-'))
    cleanup.push(() => rm(root, { recursive: true, force: true }))
    const downloads = path.join(root, 'downloads')
    const parent = path.join(downloads, 'selected')
    const outside = path.join(root, 'private')
    await mkdir(parent, { recursive: true })
    await mkdir(outside)
    const candidate = path.join(parent, 'sample.torrent')
    await writeFile(candidate, 'authorized fixture')
    await writeFile(path.join(outside, 'sample.torrent'), 'private fixture')
    let replaced = false
    const files = new NasFiles({
      platform: 'fnos',
      authorizedRoots: async () => [downloads],
      checkAccess: async (_user, file) => {
        if (file === candidate && !replaced) {
          replaced = true
          await rename(parent, `${parent}-original`)
          await symlink(outside, parent)
        }
        return true
      },
    })
    const policy = await files.policy(downloads)
    const app = Fastify()
    cleanup.push(() => app.close())
    app.addHook('preHandler', (_req, _reply, done) =>
      runAsNasGatewayUser(
        {
          platform: 'fnos',
          userId: '1000',
          username: 'operator',
          administrator: true,
        },
        done
      )
    )
    registerFnosRoutes(app, files, policy, () => undefined)
    const response = await app.inject({
      method: 'POST',
      url: '/api/fnos/torrent',
      payload: { path: candidate },
    })
    expect(replaced).toBe(true)
    expect(response.statusCode).toBe(403)
    expect(response.body).not.toContain('private fixture')
  }
)

it.skipIf(process.platform !== 'linux')(
  'returns an authorized torrent through the held file',
  async () => {
    const root = await realpath(await mkdtemp('/tmp/motrix-torrent-read-'))
    cleanup.push(() => rm(root, { recursive: true, force: true }))
    const candidate = path.join(root, 'sample.torrent')
    await writeFile(candidate, 'authorized fixture')
    const files = new NasFiles({
      platform: 'fnos',
      authorizedRoots: async () => [root],
      checkAccess: async () => true,
    })
    const policy = await files.policy(root)
    const app = Fastify()
    cleanup.push(() => app.close())
    app.addHook('preHandler', (_req, _reply, done) =>
      runAsNasGatewayUser(
        {
          platform: 'fnos',
          userId: '1000',
          username: 'operator',
          administrator: true,
        },
        done
      )
    )
    registerFnosRoutes(app, files, policy, () => undefined)
    const response = await app.inject({
      method: 'POST',
      url: '/api/fnos/torrent',
      payload: { path: candidate },
    })
    expect(response.statusCode).toBe(200)
    expect(response.headers['content-type']).toBe('application/x-bittorrent')
    expect(response.body).toBe('authorized fixture')
  }
)
