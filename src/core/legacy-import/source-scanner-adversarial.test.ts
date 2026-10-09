// @vitest-environment node
import {
  link,
  mkdir,
  mkdtemp,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  authorizeLegacySource,
  readLegacyFile,
  scanLegacySource,
} from './source-scanner'

const roots: string[] = []

async function fixture(
  session = 'https://example.test/file.zip\t\n gid=0123456789abcdef\n out=file.zip\n'
) {
  const root = await mkdtemp(
    path.join(os.tmpdir(), 'legacy-import-adversarial-')
  )
  roots.push(root)
  const sourceRoot = path.join(root, 'legacy')
  await mkdir(sourceRoot)
  await writeFile(
    path.join(sourceRoot, 'user.json'),
    JSON.stringify({ theme: 'auto' })
  )
  await writeFile(
    path.join(sourceRoot, 'system.json'),
    JSON.stringify({ dir: path.join(root, 'downloads') })
  )
  await writeFile(path.join(sourceRoot, 'download.session'), session)
  return { root, sourceRoot, source: await authorizeLegacySource(sourceRoot) }
}

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
  )
})

describe('legacy source adversarial boundaries', () => {
  it('rejects a session replaced with a symlink outside the selected directory', async () => {
    const { root, sourceRoot, source } = await fixture()
    const outside = path.join(root, 'private.session')
    await writeFile(outside, 'https://example.test/private.zip\n')
    await rm(path.join(sourceRoot, 'download.session'))
    await symlink(outside, path.join(sourceRoot, 'download.session'))
    await expect(scanLegacySource(source, () => false)).rejects.toThrow()
  })

  it('rejects a hard-linked session even when its name stays inside the grant', async () => {
    const { root, sourceRoot, source } = await fixture()
    await link(
      path.join(sourceRoot, 'download.session'),
      path.join(root, 'alias.session')
    )
    await expect(scanLegacySource(source, () => false)).rejects.toThrow()
  })

  it('invalidates a source handle when a different directory replaces its path', async () => {
    const { root, sourceRoot, source } = await fixture()
    await rename(sourceRoot, path.join(root, 'original'))
    await mkdir(sourceRoot)
    await writeFile(
      path.join(sourceRoot, 'download.session'),
      'https://example.test/replacement.zip\n'
    )
    await expect(readLegacyFile(source, 'download.session')).rejects.toThrow()
  })

  it.each([
    '../outside.session',
    'nested/../../outside.session',
    '/tmp/outside.session',
    'nested\\..\\outside.session',
  ])('rejects metadata path traversal: %s', async (relative) => {
    const { source } = await fixture()
    await expect(readLegacyFile(source, relative)).rejects.toThrow()
  })

  it('does not follow a symlink in an intermediate metadata directory', async () => {
    const { root, sourceRoot, source } = await fixture()
    const outside = path.join(root, 'outside')
    await mkdir(outside)
    await writeFile(path.join(outside, 'meta.torrent'), 'private')
    await symlink(outside, path.join(sourceRoot, 'metadata'))
    await expect(
      readLegacyFile(source, 'metadata/meta.torrent')
    ).rejects.toThrow()
  })

  it('blocks a task whose old request depended on a header without exposing that value', async () => {
    const { source } = await fixture(
      'https://example.test/file.zip\n header=Authorization: Bearer private-token\n out=file.zip\n'
    )
    const scan = await scanLegacySource(source, () => false)
    expect(scan.candidates[0].item.selectable).toBe(false)
    expect(
      JSON.stringify(scan.candidates.map(({ item }) => item))
    ).not.toContain('private-token')
  })

  it('blocks inherited request credentials instead of treating the task as URI-only', async () => {
    const { root, sourceRoot, source } = await fixture()
    await writeFile(
      path.join(sourceRoot, 'system.json'),
      JSON.stringify({
        dir: path.join(root, 'downloads'),
        'http-user': 'private-user',
        'http-passwd': 'private-pass',
      })
    )
    const scan = await scanLegacySource(source, () => false)
    expect(scan.candidates[0].item.selectable).toBe(false)
    expect(
      JSON.stringify(scan.candidates.map(({ item }) => item))
    ).not.toContain('private-pass')
  })

  it('does not choose an arbitrary winner among conflicting entries with one old GID', async () => {
    const { source } = await fixture(
      'https://example.test/a.zip\n gid=0123456789abcdef\n out=a.zip\nhttps://example.test/b.zip\n gid=0123456789abcdef\n out=b.zip\n'
    )
    const scan = await scanLegacySource(source, () => false)
    expect(scan.candidates).toHaveLength(2)
    expect(scan.candidates.every(({ item }) => !item.selectable)).toBe(true)
  })

  it('keeps the same URL in two output directories as distinct import candidates', async () => {
    const { root, sourceRoot, source } = await fixture()
    await writeFile(
      path.join(sourceRoot, 'download.session'),
      `https://example.test/file.zip\n dir=${root}/first\n out=file.zip\nhttps://example.test/file.zip\n dir=${root}/second\n out=file.zip\n`
    )
    const scan = await scanLegacySource(source, () => false)
    expect(scan.candidates.every(({ item }) => item.selectable)).toBe(true)
    expect(new Set(scan.candidates.map(({ item }) => item.itemId)).size).toBe(2)
  })
})
