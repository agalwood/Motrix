import {
  mkdir,
  mkdtemp,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises'
import path from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { type NasFileAccess, NasFiles } from './files'
import { type NasIdentity, type NasPlatform, runAsNasUser } from './identity'

const cleanup: string[] = []
afterEach(async () => {
  await Promise.all(
    cleanup.splice(0).map((p) => rm(p, { recursive: true, force: true }))
  )
})

async function fixture(platform: NasPlatform = 'fnos') {
  const root = await realpath(await mkdtemp('/tmp/motrix-nas-files-'))
  cleanup.push(root)
  const downloads = path.join(root, 'downloads')
  await mkdir(downloads)
  const identity: NasIdentity = {
    platform,
    userId: 'account-1',
    username: 'admin',
    administrator: true,
  }
  const access = {
    platform,
    authorizedRoots: vi.fn(async () => [downloads]),
    checkAccess: vi.fn<NasFileAccess['checkAccess']>(async () => true),
  }
  const files = new NasFiles(access)
  return {
    root,
    downloads,
    identity,
    access,
    files,
    policy: await files.policy(downloads),
  }
}

// These are contract adapters, not implementations of the vendors' APIs.
it.each(['fnos', 'synology', 'qnap'] as const)(
  'applies the same containment and account ACL contract for %s',
  async (platform) => {
    const f = await fixture(platform)
    const output = path.join(f.downloads, 'new/nested')
    await runAsNasUser(f.identity, () => f.policy.prepareSaveDir(output))
    expect((await stat(output)).isDirectory()).toBe(true)
    expect(f.access.checkAccess).toHaveBeenCalledWith(
      f.identity,
      f.downloads,
      'writable'
    )
    expect(f.access.checkAccess).toHaveBeenCalledWith(
      f.identity,
      output,
      'writable'
    )
    const outside = path.join(f.root, 'private')
    await mkdir(outside)
    await symlink(outside, path.join(f.downloads, 'escape'))
    await expect(
      runAsNasUser(f.identity, () =>
        f.policy.prepareSaveDir(path.join(f.downloads, 'escape/new'))
      )
    ).rejects.toThrow()
    await expect(stat(path.join(outside, 'new'))).rejects.toMatchObject({
      code: 'ENOENT',
    })
  }
)

it('rejects another platform identity without consulting the vendor ACL', async () => {
  const f = await fixture()
  await expect(
    runAsNasUser({ ...f.identity, platform: 'qnap' }, () =>
      f.policy.prepareSaveDir(f.downloads)
    )
  ).rejects.toThrow('permission denied')
  expect(f.access.checkAccess).not.toHaveBeenCalled()
})

it('uses the explicit caller for both parent and file checks during delegation', async () => {
  const f = await fixture()
  const file = path.join(f.downloads, 'test.torrent')
  await writeFile(file, 'fixture')
  const delegated = { ...f.identity, userId: 'account-2', username: 'delegate' }
  await runAsNasUser(f.identity, () =>
    f.files.authorizeFile(file, f.policy, delegated)
  )
  expect(f.access.checkAccess.mock.calls.length).toBeGreaterThan(1)
  for (const [identity] of f.access.checkAccess.mock.calls)
    expect(identity).toEqual(delegated)
  expect(f.access.checkAccess).toHaveBeenCalledWith(
    delegated,
    f.downloads,
    'readable'
  )
  expect(f.access.checkAccess).toHaveBeenCalledWith(delegated, file, 'readable')
})

it('denies writes before mkdir and reloads grants on every request', async () => {
  const f = await fixture()
  f.access.checkAccess.mockResolvedValue(false)
  const output = path.join(f.downloads, 'denied')
  await expect(
    runAsNasUser(f.identity, () => f.policy.prepareSaveDir(output))
  ).rejects.toThrow('permission denied')
  await expect(stat(output)).rejects.toMatchObject({ code: 'ENOENT' })
  f.access.authorizedRoots.mockResolvedValue([])
  await expect(f.policy.authorizeDirectory(f.downloads)).rejects.toThrow(
    'No NAS directories'
  )
  f.access.authorizedRoots.mockRejectedValue(new Error('platform offline'))
  await expect(f.policy.prepareSaveDir(f.downloads)).rejects.toThrow(
    'platform offline'
  )
})

it('does not recreate a missing mounted root', async () => {
  const f = await fixture()
  await rm(f.downloads, { recursive: true })
  await expect(
    runAsNasUser(f.identity, () =>
      f.policy.prepareSaveDir(path.join(f.downloads, 'new'))
    )
  ).rejects.toThrow()
  await expect(stat(f.downloads)).rejects.toMatchObject({ code: 'ENOENT' })
})
