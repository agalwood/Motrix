import { existsSync } from 'node:fs'
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises'
import path from 'node:path'
import { NativeFinalizeFilesystemAdapter } from '@core/plugin/finalize/filesystem-adapter'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { NasFileRemover } from './file-remover'
import { NasFiles } from './files'
import { runAsNasGatewayUser } from './identity'

const binary =
  process.env.MOTRIX_FINALIZE_FS_TEST_BIN ??
  path.resolve('packages/finalize-fs/target/debug/motrix-finalize-fs')
const cleanup: (() => Promise<unknown>)[] = []
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close()
})

async function fixture() {
  const root = await realpath(await mkdtemp('/tmp/motrix-nas-remove-'))
  cleanup.push(() => rm(root, { recursive: true, force: true }))
  const downloads = path.join(root, 'downloads')
  await mkdir(downloads)
  const file = path.join(downloads, 'payload')
  await writeFile(file, 'download')
  const check = vi.fn(async (_file: string) => true)
  const files = new NasFiles({
    platform: 'fnos',
    authorizedRoots: async () => [downloads],
    checkAccess: async (_user, file) => check(file),
  })
  const policy = await files.policy(downloads)
  const adapter = new NativeFinalizeFilesystemAdapter(binary)
  cleanup.push(() => adapter.dispose())
  const intents = path.join(root, 'intents')
  const remover = new NasFileRemover(files, policy, adapter, intents)
  const run = (fn: () => Promise<void>) =>
    runAsNasGatewayUser(
      {
        platform: 'fnos',
        userId: '1000',
        username: 'alice',
        administrator: true,
      },
      fn
    )
  return {
    root,
    downloads,
    file,
    check,
    files,
    policy,
    adapter,
    intents,
    remover,
    run,
  }
}

describe.runIf(process.platform === 'linux' && existsSync(binary))(
  'NAS held cleanup',
  () => {
    it('removes files and directory trees and clears completed intents', async () => {
      const f = await fixture()
      await f.run(() => f.remover.remove(f.file))
      expect(existsSync(f.file)).toBe(false)
      await mkdir(path.join(f.file, 'nested'), { recursive: true })
      await writeFile(path.join(f.file, 'nested/download'), 'nested')
      await f.run(() => f.remover.remove(f.file))
      expect(existsSync(f.file)).toBe(false)
      expect(await readdir(f.intents)).toEqual([])
    })

    it('preserves an outside file when the parent is replaced during ACL lookup', async () => {
      const f = await fixture()
      const outside = path.join(f.root, 'outside')
      await mkdir(outside)
      await writeFile(path.join(outside, 'payload'), 'outside')
      let swapped = false
      f.check.mockImplementation(async (file) => {
        if (file === f.file && !swapped) {
          swapped = true
          await rename(f.downloads, `${f.downloads}-original`)
          await symlink(outside, f.downloads)
        }
        return true
      })
      await expect(f.run(() => f.remover.remove(f.file))).rejects.toThrow()
      expect(swapped).toBe(true)
      expect(await readFile(path.join(outside, 'payload'), 'utf8')).toBe(
        'outside'
      )
      expect(await readFile(`${f.downloads}-original/payload`, 'utf8')).toBe(
        'download'
      )
    })

    it('rejects a replacement inode at the authorized name', async () => {
      const f = await fixture()
      let swapped = false
      f.check.mockImplementation(async (file) => {
        if (file === f.file && !swapped) {
          swapped = true
          await rename(f.file, `${f.file}-original`)
          await writeFile(f.file, 'replacement')
        }
        return true
      })

      await expect(f.run(() => f.remover.remove(f.file))).rejects.toThrow()
      expect(await readFile(f.file, 'utf8')).toBe('replacement')
      expect(await readFile(`${f.file}-original`, 'utf8')).toBe('download')
    })

    it('retains the intent until a deletion with a failed directory flush is durably acknowledged', async () => {
      const f = await fixture()
      const remove = f.adapter.removeOpened.bind(f.adapter)
      vi.spyOn(f.adapter, 'removeOpened').mockImplementationOnce(
        async (...args) => {
          await remove(...args)
          throw new Error('simulated directory flush failure')
        }
      )
      await expect(f.run(() => f.remover.remove(f.file))).rejects.toThrow(
        'flush failure'
      )
      expect(existsSync(f.file)).toBe(false)
      const sync = vi.spyOn(f.adapter, 'syncRoot')
      sync.mockRejectedValueOnce(new Error('still cannot flush'))
      await expect(f.run(() => f.remover.remove(f.file))).rejects.toThrow(
        'cannot flush'
      )
      expect((await readdir(f.intents)).length).toBe(1)
      await f.run(() => f.remover.remove(f.file))
      expect(sync).toHaveBeenCalledTimes(2)
      expect(await readdir(f.intents)).toEqual([])
    })

    it.each(['retry', 'revoked', 'replacement'] as const)(
      'keeps isolated cleanup recoverable after restart: %s',
      async (outcome) => {
        const f = await fixture()
        let isolated = ''
        vi.spyOn(f.adapter, 'removeOpened').mockImplementationOnce(
          async (_artifact, name) => {
            isolated = path.join(f.downloads, name)
            await rename(f.file, isolated)
            throw new Error('simulated shutdown after isolation')
          }
        )
        await expect(f.run(() => f.remover.remove(f.file))).rejects.toThrow(
          'simulated shutdown'
        )
        expect((await readdir(f.intents)).length).toBe(1)
        const nextAdapter = new NativeFinalizeFilesystemAdapter(binary)
        cleanup.push(() => nextAdapter.dispose())
        const next = new NasFileRemover(
          f.files,
          f.policy,
          nextAdapter,
          f.intents
        )
        if (outcome === 'revoked') f.check.mockResolvedValue(false)
        if (outcome === 'replacement') {
          await rename(isolated, `${isolated}-original`)
          await writeFile(isolated, 'replacement')
        }
        if (outcome === 'retry') {
          await f.run(() => next.remove(f.file))
          expect(existsSync(isolated)).toBe(false)
          expect(await readdir(f.intents)).toEqual([])
        } else {
          await expect(f.run(() => next.remove(f.file))).rejects.toThrow()
          expect(existsSync(isolated)).toBe(true)
          expect((await readdir(f.intents)).length).toBe(1)
        }
      }
    )
  }
)
