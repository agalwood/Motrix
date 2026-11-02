import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import {
  matchesEntrypoint,
  processStartTime,
  runtimeEnvironment,
} from '../../packaging/fnos/app/lifecycle.mjs'
import {
  lockedDownload,
  prepareFnosProject,
  sha256,
  verifyFnosBinary,
} from '../../scripts/prepare-fnos-project.mjs'

const directories: string[] = []
it('recognizes the actual Node entrypoint instead of a later script argument', () => {
  const entry = '/app/server/index.mjs'
  expect(matchesEntrypoint(['node', entry, ''].join('\0'), entry)).toBe(true)
  expect(
    matchesEntrypoint(
      ['node', '--no-opt', '-r', '/bootstrap.cjs', entry, ''].join('\0'),
      entry
    )
  ).toBe(true)
  expect(
    matchesEntrypoint(['node', '/other.mjs', entry, ''].join('\0'), entry)
  ).toBe(false)
  expect(
    matchesEntrypoint(['node', '-e', 'anything', entry, ''].join('\0'), entry)
  ).toBe(false)
})
afterEach(async () => {
  vi.unstubAllGlobals()
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true }))
  )
})
async function temporary() {
  const directory = await mkdtemp('/tmp/mtx-fpk-test-')
  directories.push(directory)
  return directory
}

it('requires a system download share and keeps private state outside the replaceable application', () => {
  const env = {
    TRIM_APPDEST: '/vol1/@apps/motrix/target',
    TRIM_PKGVAR: '/vol1/@appdata/motrix',
    TRIM_DATA_SHARE_PATHS: '/vol2/downloads',
  }
  const runtime = runtimeEnvironment(env)
  expect(runtime.MOTRIX_DATA_DIR).toBe('/vol1/@appdata/motrix/motrix')
  expect(runtime.MOTRIX_ARIA2_BIN).toBe(
    '/vol1/@apps/motrix/target/server/bin/aria2c'
  )
  expect(runtime.MOTRIX_DEFAULT_SAVE_DIR).toBe('/vol2/downloads')
  expect(() =>
    runtimeEnvironment({ ...env, TRIM_DATA_SHARE_PATHS: '' })
  ).toThrow('unavailable')
  expect(() =>
    runtimeEnvironment({ ...env, TRIM_DATA_SHARE_PATHS: '/one:/two' })
  ).toThrow('unavailable')
})
it('extracts process birth time despite spaces and parentheses in comm, and rejects zombies', () => {
  const fields = ['S', ...Array(18).fill('0'), '482901']
  expect(processStartTime(`123 (node (worker)) ${fields.join(' ')}`)).toBe(
    '482901'
  )
  fields[0] = 'Z'
  expect(processStartTime(`123 (node) ${fields.join(' ')}`)).toBeUndefined()
})
it('rejects a tampered download and does not retain it in the cache', async () => {
  const directory = await temporary()
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('tampered')))
  await expect(
    lockedDownload(
      { url: 'https://example.test/node.tar.xz', sha256: sha256('expected') },
      directory
    )
  ).rejects.toThrow('Checksum mismatch')
  const fetch = vi.fn().mockResolvedValue(new Response('expected'))
  vi.stubGlobal('fetch', fetch)
  const cached = await lockedDownload(
    { url: 'https://example.test/node.tar.xz', sha256: sha256('expected') },
    directory
  )
  expect(await readFile(cached, 'utf8')).toBe('expected')
  await lockedDownload(
    { url: 'https://example.test/node.tar.xz', sha256: sha256('expected') },
    directory
  )
  expect(fetch).toHaveBeenCalledTimes(1)
})
it('detects wrong-architecture and non-executable runtime binaries', async () => {
  const file = path.join(await temporary(), 'node')
  const elf = Buffer.alloc(64)
  Buffer.from([0x7f, 0x45, 0x4c, 0x46, 2, 1]).copy(elf)
  elf.writeUInt16LE(183, 18)
  await writeFile(file, elf, { mode: 0o755 })
  await verifyFnosBinary(file, 'arm64')
  await expect(verifyFnosBinary(file, 'x64')).rejects.toThrow('Invalid')
  await chmod(file, 0o644)
  await expect(verifyFnosBinary(file, 'arm64')).rejects.toThrow('Invalid')
})
it('refuses overlapping output locations before touching the input', async () => {
  const directory = await temporary()
  await writeFile(path.join(directory, 'keep'), 'original')
  await expect(
    prepareFnosProject({
      appDir: directory,
      outputDir: directory,
      arch: 'arm64',
    })
  ).rejects.toThrow('overlap')
  expect(await readFile(path.join(directory, 'keep'), 'utf8')).toBe('original')
})
