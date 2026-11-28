import {
  chmod,
  mkdir,
  mkdtemp,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { openFnosFile } from './open-file'

const cleanup: (() => Promise<unknown>)[] = []
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close()
})

async function fixture() {
  const root = await realpath(await mkdtemp('/tmp/motrix-open-file-'))
  cleanup.push(() => rm(root, { recursive: true, force: true }))
  const parent = path.join(root, 'downloads')
  await mkdir(parent)
  const file = path.join(parent, 'sample.torrent')
  await writeFile(file, 'authorized fixture')
  return { root, parent, file }
}

describe.skipIf(process.platform !== 'linux')(
  'fnOS descriptor-relative reads',
  () => {
    it('traverses execute-only ancestors without requiring directory listing access', async () => {
      const { parent, file } = await fixture()
      await chmod(parent, 0o100)
      cleanup.push(() => chmod(parent, 0o700))
      const handle = await openFnosFile(file, async (candidate) => candidate)
      cleanup.push(() => handle.close())
      expect(await handle.readFile('utf8')).toBe('authorized fixture')
    })

    it('rejects an ancestor replaced with a symbolic link', async () => {
      const { parent, file } = await fixture()
      await rename(parent, `${parent}-moved`)
      await symlink(`${parent}-moved`, parent)
      await expect(
        openFnosFile(file, async (candidate) => candidate)
      ).rejects.toThrow()
    })

    it('rejects a file moved during the second authorization', async () => {
      const { root, parent, file } = await fixture()
      await expect(
        openFnosFile(file, async (candidate) => {
          await rename(parent, path.join(root, 'moved'))
          await mkdir(parent)
          await writeFile(file, 'replacement fixture')
          return candidate
        })
      ).rejects.toThrow('File changed during authorization')
    })

    it('closes the file when authorization is revoked after opening', async () => {
      const { file } = await fixture()
      await expect(
        openFnosFile(file, async () => {
          throw new Error('grant revoked')
        })
      ).rejects.toThrow('grant revoked')
    })

    it('rejects non-regular files before returning a reader', async () => {
      const { parent } = await fixture()
      await expect(
        openFnosFile(parent, async (candidate) => candidate)
      ).rejects.toThrow()
    })
  }
)
