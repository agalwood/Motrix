import {
  mkdir,
  mkdtemp,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { createServer } from 'node:http'
import path from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { runAsNasUser } from '../nas/identity'
import { FnosFiles } from './files'

const user = (uid: number) => ({
  platform: 'fnos' as const,
  userId: String(uid),
  username: `user${uid}`,
  administrator: true,
})

const cleanup: (() => Promise<unknown>)[] = []
afterEach(async () => {
  for (const dispose of cleanup.splice(0).reverse()) await dispose()
})

async function fixture() {
  const root = await mkdtemp('/tmp/mtx-files-')
  cleanup.push(() => rm(root, { recursive: true, force: true }))
  const downloads = path.join(root, 'downloads')
  await mkdir(downloads)
  let roots = [downloads]
  let available = true
  const calls: { req: string; data: { uid?: number; path?: string[] } }[] = []
  const api = createServer(async (req, res) => {
    let raw = ''
    for await (const chunk of req) raw += chunk
    const body = JSON.parse(raw)
    calls.push(body)
    expect(req.headers.authorization).toBe('Bearer test-token')
    res.setHeader('content-type', 'application/json')
    res.end(
      JSON.stringify({
        code: available ? 0 : 1,
        data:
          body.req === 'trim.file.getSharedAccessibleFolders'
            ? { paths: roots }
            : body.data.path.map((p: string) => ({
                path: p,
                readable: true,
                writable: body.data.uid === 1000,
                deletable: false,
              })),
      })
    )
  })
  const socket = path.join(root, 'api.sock')
  await new Promise<void>((resolve, reject) => {
    api.once('error', reject)
    api.listen(socket, resolve)
  })
  cleanup.push(
    () =>
      new Promise<void>((resolve, reject) =>
        api.close((error) => (error ? reject(error) : resolve()))
      )
  )
  const files = new FnosFiles({ TRIM_API_TOKEN: 'test-token' }, socket)
  const policy = await files.policy(downloads)
  return {
    root,
    downloads,
    files,
    policy,
    calls,
    revoke: () => {
      roots = []
    },
    offline: () => {
      available = false
    },
  }
}

it('checks the existing parent before creating a new download directory', async () => {
  const { policy, downloads, calls } = await fixture()
  const candidate = path.join(downloads, 'new/child')
  await runAsNasUser(user(1000), () => policy.prepareSaveDir(candidate))
  expect((await stat(candidate)).isDirectory()).toBe(true)
  expect(
    calls
      .filter((call) => call.req.endsWith('checkUserACL'))
      .map((call) => call.data)
  ).toEqual([
    { uid: 1000, path: [await realpath(downloads)] },
    { uid: 1000, path: [await realpath(candidate)] },
  ])
})
it('denies a non-writable user before creating anything and treats delete separately', async () => {
  const { policy, downloads, files } = await fixture()
  const candidate = path.join(downloads, 'denied')
  await expect(
    runAsNasUser(user(2000), () => policy.prepareSaveDir(candidate))
  ).rejects.toThrow('permission denied')
  await expect(stat(candidate)).rejects.toMatchObject({ code: 'ENOENT' })
  await expect(files.check(downloads, 'deletable', user(1000))).rejects.toThrow(
    'permission denied'
  )
})
it('fails closed on no grants or platform failure', async () => {
  const first = await fixture()
  first.revoke()
  await expect(first.policy.prepareSaveDir(first.downloads)).rejects.toThrow(
    'No NAS directories'
  )
  const second = await fixture()
  second.offline()
  await expect(
    second.policy.authorizeDirectory(second.downloads)
  ).rejects.toThrow()
})
it('rejects sibling paths and symlinks leaving an authorized root', async () => {
  const { root, downloads, policy, files } = await fixture()
  const outside = path.join(root, 'private')
  await mkdir(outside)
  await writeFile(path.join(outside, 'secret.torrent'), 'secret')
  await symlink(outside, path.join(downloads, 'link'))
  await expect(
    policy.prepareSaveDir(`${downloads}-sibling/new`)
  ).rejects.toThrow()
  await expect(
    files.authorizeFile(
      path.join(downloads, 'link/secret.torrent'),
      policy,
      user(1000)
    )
  ).rejects.toThrow()
})
