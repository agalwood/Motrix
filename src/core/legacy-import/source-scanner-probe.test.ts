// @vitest-environment node
import {
  link,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  symlink,
  truncate,
  writeFile,
} from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MAX_LEGACY_BYTES } from './session-parser'
import {
  authorizeLegacySource,
  probeLegacySource,
  scanLegacySource,
} from './source-scanner'

vi.mock('node:fs/promises', async (original) => {
  const actual = await original<typeof import('node:fs/promises')>()
  return {
    ...actual,
    lstat: vi.fn(actual.lstat),
    open: vi.fn(actual.open),
    readdir: vi.fn(actual.readdir),
    readFile: vi.fn(actual.readFile),
  }
})

const roots: string[] = []
const metadata = ['user.json', 'system.json', 'download.session'] as const

async function fixture(session: string | Buffer = '') {
  const root = await realpath(
    await mkdtemp(path.join(os.tmpdir(), 'legacy-source-probe-'))
  )
  roots.push(root)
  const profile = path.join(root, 'profile')
  await mkdir(profile)
  await writeFile(path.join(profile, 'user.json'), '{"theme":"auto"}')
  await writeFile(
    path.join(profile, 'system.json'),
    JSON.stringify({ dir: path.join(root, 'downloads') })
  )
  await writeFile(path.join(profile, 'download.session'), session)
  return { root, profile, source: await authorizeLegacySource(profile) }
}

beforeEach(() => vi.clearAllMocks())
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
  )
})

describe('lightweight legacy source probe', () => {
  it('stats only the root and three fixed files without task, PID or content IO', async () => {
    const f = await fixture(
      'https://example.test/a.zip\n out=a.zip\n/file/outside.torrent\n'
    )
    await writeFile(path.join(f.profile, 'engine.pid'), '123')
    await mkdir(path.join(f.profile, 'nested'))
    await writeFile(path.join(f.profile, 'nested', 'download.torrent'), 'bad')
    vi.clearAllMocks()
    await expect(probeLegacySource(f.source)).resolves.toBeUndefined()
    expect(vi.mocked(lstat).mock.calls.map(([filename]) => filename)).toEqual([
      f.profile,
      ...metadata.map((name) => path.join(f.profile, name)),
      f.profile,
    ])
    expect(open).not.toHaveBeenCalled()
    expect(readFile).not.toHaveBeenCalled()
    expect(readdir).not.toHaveBeenCalled()
  })

  it('recognizes an empty session and leaves full scanning able to return no tasks', async () => {
    const f = await fixture()
    await expect(probeLegacySource(f.source)).resolves.toBeUndefined()
    const running = vi.fn(() => false)
    expect((await scanLegacySource(f.source, running)).candidates).toEqual([])
    expect(running).not.toHaveBeenCalled()
  })

  it.each([Buffer.from('\0bad session'), Buffer.alloc(4 * 1024 * 1024)])(
    'defers malformed session parsing, including large files within the safety limit',
    async (session) => {
      const f = await fixture(session)
      await writeFile(path.join(f.profile, 'engine.pid'), '123')
      const running = vi.fn(() => false)
      vi.clearAllMocks()
      await expect(probeLegacySource(f.source)).resolves.toBeUndefined()
      expect(open).not.toHaveBeenCalled()
      expect(running).not.toHaveBeenCalled()
      await expect(scanLegacySource(f.source, running)).rejects.toThrow(
        'legacyImport.invalidSource'
      )
      expect(running).toHaveBeenCalledWith(123)
    }
  )

  it('defers configuration parsing while full scan still rejects invalid configuration', async () => {
    const f = await fixture()
    await writeFile(path.join(f.profile, 'system.json'), '{}')
    vi.clearAllMocks()
    await expect(probeLegacySource(f.source)).resolves.toBeUndefined()
    expect(open).not.toHaveBeenCalled()
    await expect(scanLegacySource(f.source, () => false)).rejects.toThrow(
      'legacyImport.invalidSource'
    )
  })

  it.each(metadata)('rejects a missing required file: %s', async (name) => {
    const f = await fixture()
    await rm(path.join(f.profile, name))
    await expect(probeLegacySource(f.source)).rejects.toThrow(
      'legacyImport.invalidSource'
    )
  })

  it.each(metadata)('rejects a symlinked required file: %s', async (name) => {
    const f = await fixture()
    const outside = path.join(f.root, 'outside')
    await writeFile(outside, '{}')
    await rm(path.join(f.profile, name))
    await symlink(outside, path.join(f.profile, name))
    await expect(probeLegacySource(f.source)).rejects.toThrow(
      'legacyImport.unsafeSource'
    )
  })

  it('rejects hard-linked and oversized metadata without opening it', async () => {
    const f = await fixture()
    const filename = path.join(f.profile, 'download.session')
    const alias = path.join(f.root, 'alias')
    await link(filename, alias)
    await expect(probeLegacySource(f.source)).rejects.toThrow(
      'legacyImport.unsafeSource'
    )
    await rm(alias)
    await truncate(filename, MAX_LEGACY_BYTES + 1)
    vi.clearAllMocks()
    await expect(probeLegacySource(f.source)).rejects.toThrow(
      'legacyImport.unsafeSource'
    )
    expect(open).not.toHaveBeenCalled()
  })

  it('rejects a replacement directory behind an existing grant', async () => {
    const f = await fixture()
    await rename(f.profile, path.join(f.root, 'original'))
    await mkdir(f.profile)
    await expect(probeLegacySource(f.source)).rejects.toThrow(
      'legacyImport.changedSource'
    )
  })
})
