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

  it('keeps a paused HTTP task selectable without requiring request settings', async () => {
    const { source } = await fixture(
      'https://example.test/video.mp4\n gid=0123456789abcdef\n pause=true\n out=下载视频.mp4\n'
    )
    const scan = await scanLegacySource(source, () => false)
    expect(scan.candidates[0].item).toMatchObject({
      type: 'http',
      name: '下载视频.mp4',
      selectable: true,
      reason: 'verification-required',
    })
    expect(scan.candidates[0].item.requestOptions).toBeUndefined()
  })

  it('accepts repeated v1 request headers for inactive import without exposing their values', async () => {
    const { source } = await fixture(
      'https://example.test/video.mp4\t\n gid=0123456789abcdef\n pause=true\n header=Authorization: Bearer private-token\n header=Cookie: private-cookie\n referer=https://private.test/source\n no-netrc=true\n user-agent=aria2/1.36.0\n out=下载视频.mp4\n'
    )
    const scan = await scanLegacySource(source, () => false)
    expect(scan.candidates[0].item).toMatchObject({
      type: 'http',
      name: '下载视频.mp4',
      selectable: true,
      reason: 'request-settings-required',
      requestOptions: ['header', 'referer'],
    })
    expect(JSON.stringify(scan.candidates.map(({ item }) => item))).not.toMatch(
      /private-token|private-cookie|private\.test/
    )
  })

  it('blocks HTTP mirrors that cannot be reconfigured through the fresh-download form', async () => {
    const { source } = await fixture(
      'https://example.test/file.zip\thttps://mirror.test/file.zip\n header=private\n'
    )
    const scan = await scanLegacySource(source, () => false)
    expect(scan.candidates[0].item).toMatchObject({
      type: 'http',
      selectable: false,
      reason: 'mirrors-unsupported',
      requestOptions: ['header'],
    })
  })

  it('preserves existing URI-only HTTP mirror import behavior', async () => {
    const { source } = await fixture(
      'https://example.test/file.zip\thttps://mirror.test/file.zip\n'
    )
    const scan = await scanLegacySource(source, () => false)
    expect(scan.candidates[0].item).toMatchObject({
      type: 'http',
      selectable: true,
      reason: 'verification-required',
    })
  })

  it('requires new settings for inherited proxy and credentials without exposing them', async () => {
    const { root, sourceRoot, source } = await fixture()
    await writeFile(
      path.join(sourceRoot, 'system.json'),
      JSON.stringify({
        dir: path.join(root, 'downloads'),
        'http-user': 'private-user',
        'http-passwd': 'private-pass',
        'all-proxy': 'http://private-proxy.test:8080',
      })
    )
    const scan = await scanLegacySource(source, () => false)
    expect(scan.candidates[0].item).toMatchObject({
      type: 'http',
      selectable: true,
      reason: 'request-settings-required',
      requestOptions: expect.arrayContaining([
        'http-user',
        'http-passwd',
        'all-proxy',
      ]),
    })
    expect(JSON.stringify(scan.candidates.map(({ item }) => item))).not.toMatch(
      /private-user|private-pass|private-proxy/
    )
  })

  it('ignores empty session and inherited request settings', async () => {
    const { root, sourceRoot, source } = await fixture(
      'https://example.test/file.zip\n header=\n referer= \n all-proxy=\n'
    )
    await writeFile(
      path.join(sourceRoot, 'system.json'),
      JSON.stringify({
        dir: path.join(root, 'downloads'),
        header: ['', ' '],
        referer: '',
        'all-proxy': null,
        'http-user': [],
      })
    )
    const scan = await scanLegacySource(source, () => false)
    expect(scan.candidates[0].item).toMatchObject({
      selectable: true,
      reason: 'verification-required',
    })
    expect(scan.candidates[0].item.requestOptions).toBeUndefined()
  })

  it.each([false, 'false'])(
    'requires new settings for inherited no-netrc=%s',
    async (value) => {
      const { root, sourceRoot, source } = await fixture()
      await writeFile(
        path.join(sourceRoot, 'system.json'),
        JSON.stringify({ dir: path.join(root, 'downloads'), 'no-netrc': value })
      )
      const scan = await scanLegacySource(source, () => false)
      expect(scan.candidates[0].item).toMatchObject({
        selectable: true,
        reason: 'request-settings-required',
        requestOptions: ['no-netrc'],
      })
    }
  )

  it.each([
    'on-download-complete=private-command',
    'input-file=private-path',
    'rpc-secret=private-secret',
    'unknown-option=',
  ])(
    'keeps unsafe HTTP option %s disabled while retaining its type',
    async (option) => {
      const { source } = await fixture(
        `https://example.test/file.zip\n header=private-header\n ${option}\n`
      )
      const scan = await scanLegacySource(source, () => false)
      expect(scan.candidates[0].item).toMatchObject({
        type: 'http',
        selectable: false,
        reason: 'unsupported-options',
        unsupportedOptions: [option.split('=')[0]],
      })
      expect(JSON.stringify(scan.candidates[0].item)).not.toContain('private')
    }
  )

  it.each([
    ['https://user:pass@example.test/a', '', 'invalid-record'],
    ['https://example.test/a\tftp://mirror.test/a', '', 'invalid-record'],
    ['https://example.test/a', ' out=../unsafe\n', 'unsafe-path'],
    ['https://example.test/a', ' dir=relative\n', 'unsafe-path'],
    ['https://example.test/a', ' gid=invalid\n', 'invalid-record'],
  ])(
    'still validates request-dependent task %s%s',
    async (uri, options, reason) => {
      const { source } = await fixture(`${uri}\n header=private\n${options}`)
      const scan = await scanLegacySource(source, () => false)
      expect(scan.candidates[0].item).toMatchObject({
        selectable: false,
        reason,
      })
    }
  )

  it.each([
    [
      'magnet:?xt=urn:btih:0123456789abcdef0123456789abcdef01234567&dn=bundle',
      'magnet',
    ],
    ['/outside/metadata.torrent', 'bt'],
    ['metadata.torrent', 'bt'],
  ])(
    'keeps request-dependent %s blocked without reading metadata',
    async (uri, type) => {
      const { source } = await fixture(`${uri}\n header=private\n`)
      const scan = await scanLegacySource(source, () => false)
      expect(scan.candidates[0].item).toMatchObject({
        type,
        selectable: false,
        reason: 'unsupported-options',
        requestOptions: ['header'],
        unsupportedOptions: ['header'],
      })
      expect(scan.candidates[0].torrent).toBeNull()
      expect(scan.files.map(({ relativePath }) => relativePath).sort()).toEqual(
        ['download.session', 'system.json', 'user.json']
      )
    }
  )

  it('does not choose an arbitrary winner among conflicting entries with one old GID', async () => {
    const { source } = await fixture(
      'https://example.test/a.zip\n gid=0123456789abcdef\n out=a.zip\nhttps://example.test/b.zip\n gid=0123456789abcdef\n out=b.zip\n'
    )
    const scan = await scanLegacySource(source, () => false)
    expect(scan.candidates).toHaveLength(2)
    expect(scan.candidates.every(({ item }) => !item.selectable)).toBe(true)
  })

  it('keeps output identity stable when request settings are added to a task without a GID', async () => {
    const session = 'https://example.test/file.zip\n out=file.zip\n'
    const { sourceRoot, source } = await fixture(session)
    const original = await scanLegacySource(source, () => false)
    await writeFile(
      path.join(sourceRoot, 'download.session'),
      `${session} header=private\n`
    )
    const changed = await scanLegacySource(source, () => false)
    expect(changed.candidates[0].item.itemId).toBe(
      original.candidates[0].item.itemId
    )
    expect(changed.candidates[0].outputPath).toBe(
      original.candidates[0].outputPath
    )
    expect(changed.candidates[0].item.reason).toBe('request-settings-required')
  })

  it('rejects duplicate task identities when only their request values differ', async () => {
    const { source } = await fixture(
      'https://example.test/file.zip\n header=first-private\nhttps://example.test/file.zip\n header=second-private\n'
    )
    const scan = await scanLegacySource(source, () => false)
    expect(scan.candidates).toHaveLength(2)
    expect(
      scan.candidates.every(
        ({ item }) => !item.selectable && item.reason === 'invalid-record'
      )
    ).toBe(true)
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
