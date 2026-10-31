import { createHash } from 'node:crypto'
import { writeFileSync } from 'node:fs'
// @vitest-environment node
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { encode } from '@motrix/torrent'
import { storageTorrent } from '@test-utils/bt-storage'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { verifyBtFiles } from './bt-file-verifier'

describe('read-only torrent verification', () => {
  let root: string
  beforeEach(async () => {
    root = await realpath(
      await mkdtemp(path.join(tmpdir(), 'motrix-bt-verify-'))
    )
  })
  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it('verifies physical padding files required by the current v1 engine', async () => {
    await writeFile(path.join(root, 'a'), 'a')
    await writeFile(path.join(root, 'b'), 'b')
    await writeFile(path.join(root, 'c'), 'c')
    await mkdir(path.join(root, '.pad'))
    await writeFile(path.join(root, '.pad', '3'), Buffer.alloc(3))
    const pieces = Buffer.concat(
      ['a\0\0\0', 'b\0\0\0', 'c'].map((data) =>
        createHash('sha1').update(data).digest()
      )
    )
    const metadata = encode({
      info: {
        name: 'root',
        'piece length': 4,
        pieces,
        files: [
          { path: ['a'], length: 1 },
          { path: ['.pad', '3'], length: 3, attr: 'p' },
          { path: ['b'], length: 1 },
          { path: ['.pad', '3'], length: 3, attr: 'p' },
          { path: ['c'], length: 1 },
        ],
      },
    })
    expect(await verifyBtFiles({ metadata, payloadPath: root })).toMatchObject({
      complete: true,
      validPieces: 3,
      missingFiles: [],
    })
    expect(await readFile(path.join(root, '.pad', '3'))).toEqual(
      Buffer.alloc(3)
    )
  })

  it.each(['abcdefghij', 'x', ''])(
    'checks a single-file torrent without changing its bytes (%s)',
    async (data) => {
      const payloadPath = path.join(root, 'file')
      await writeFile(payloadPath, data)
      const result = await verifyBtFiles({
        metadata: storageTorrent([{ name: 'original', data }]),
        payloadPath,
      })
      expect(result.complete).toBe(true)
      expect(result.validPieces).toBe(Math.ceil(data.length / 4))
      expect(await readFile(payloadPath, 'utf8')).toBe(data)
    }
  )

  it.each(['abcdefghXj', 'abc', 'abcdefghijEXTRA'])(
    'reports changed or incorrectly sized files without repair (%s)',
    async (actual) => {
      const payloadPath = path.join(root, 'file')
      await writeFile(payloadPath, actual)
      const result = await verifyBtFiles({
        metadata: storageTorrent([{ name: 'file', data: 'abcdefghij' }]),
        payloadPath,
      })
      expect(result.complete).toBe(false)
      expect(await readFile(payloadPath, 'utf8')).toBe(actual)
    }
  )

  it('reports missing data without creating files', async () => {
    const payloadPath = path.join(root, 'file')
    const result = await verifyBtFiles({
      metadata: storageTorrent([{ name: 'file', data: 'abc' }]),
      payloadPath,
    })
    expect(result).toMatchObject({
      complete: false,
      missingFiles: ['file'],
      validPieces: 0,
    })
    await expect(readFile(payloadPath)).rejects.toMatchObject({
      code: 'ENOENT',
    })
  })

  it('checks pieces spanning files, including empty files', async () => {
    const files = [
      { name: 'a', data: 'abc' },
      { name: 'empty', data: '' },
      { name: 'sub/b', data: 'defghi' },
    ]
    await mkdir(path.join(root, 'sub'))
    for (const file of files)
      await writeFile(path.join(root, file.name), file.data)
    expect(
      await verifyBtFiles({
        metadata: storageTorrent(files),
        payloadPath: root,
      })
    ).toMatchObject({ complete: true, totalPieces: 3 })
  })

  it('does not require unrelated unselected pieces', async () => {
    const files = [
      { name: 'a', data: 'abcdefgh' },
      { name: 'b', data: 'ijklmnop' },
    ]
    await writeFile(path.join(root, 'a'), files[0].data)
    expect(
      await verifyBtFiles({
        metadata: storageTorrent(files),
        payloadPath: root,
        selectedFiles: [0],
      })
    ).toMatchObject({ complete: true, totalPieces: 2 })
  })

  it('rejects an oversized unselected file without changing it', async () => {
    const files = [
      { name: 'a', data: 'aaaa' },
      { name: 'b', data: 'bbbb' },
    ]
    await writeFile(path.join(root, 'a'), 'aaaa')
    await writeFile(path.join(root, 'b'), 'unrelated data'.repeat(4))
    const before = await readFile(path.join(root, 'b'))
    expect(
      await verifyBtFiles({
        metadata: storageTorrent(files),
        payloadPath: root,
        selectedFiles: [0],
      })
    ).toMatchObject({ complete: false, invalidFiles: ['bundle/b'] })
    expect(await readFile(path.join(root, 'b'))).toEqual(before)
  })

  it.each(['leaf', 'ancestor'])(
    'rejects an unselected %s symlink',
    async (kind) => {
      const outside = path.join(root, 'outside')
      const payloadPath = path.join(root, 'payload')
      await mkdir(outside)
      await mkdir(payloadPath)
      await writeFile(path.join(payloadPath, 'a'), 'aaaa')
      await writeFile(path.join(outside, 'b'), 'unrelated data')
      const relative = kind === 'leaf' ? 'b' : 'sub/b'
      await symlink(
        kind === 'leaf' ? path.join(outside, 'b') : outside,
        path.join(payloadPath, kind === 'leaf' ? 'b' : 'sub')
      )
      await expect(
        verifyBtFiles({
          metadata: storageTorrent([
            { name: 'a', data: 'aaaa' },
            { name: relative, data: 'bbbb' },
          ]),
          payloadPath,
          selectedFiles: [0],
        })
      ).rejects.toThrow(/unsafe|regular/)
      expect(await readFile(path.join(outside, 'b'), 'utf8')).toBe(
        'unrelated data'
      )
    }
  )

  it('rechecks an unselected file changed while selected pieces were hashed', async () => {
    const files = [
      { name: 'a', data: 'aaaaaaaa' },
      { name: 'b', data: 'bbbb' },
    ]
    for (const file of files)
      await writeFile(path.join(root, file.name), file.data)
    let changed = false
    const result = await verifyBtFiles({
      metadata: storageTorrent(files),
      payloadPath: root,
      selectedFiles: [0],
      onProgress: () => {
        if (!changed) {
          changed = true
          writeFileSync(path.join(root, 'b'), 'changed unselected data')
        }
      },
    })
    expect(result).toMatchObject({
      complete: false,
      invalidFiles: ['bundle/b'],
    })
    expect(await readFile(path.join(root, 'b'), 'utf8')).toBe(
      'changed unselected data'
    )
  })

  it('requires missing adjacent bytes needed by a selected piece', async () => {
    const files = [
      { name: 'a', data: 'abc' },
      { name: 'b', data: 'defgh' },
    ]
    await writeFile(path.join(root, 'a'), files[0].data)
    expect(
      await verifyBtFiles({
        metadata: storageTorrent(files),
        payloadPath: root,
        selectedFiles: [0],
      })
    ).toMatchObject({ complete: false, missingFiles: ['bundle/b'] })
  })

  it.each(['leaf', 'ancestor'])('rejects a symlink at the %s', async (kind) => {
    await mkdir(path.join(root, 'real'))
    await writeFile(path.join(root, 'real', 'file'), 'data')
    if (kind === 'leaf')
      await symlink(path.join(root, 'real', 'file'), path.join(root, 'link'))
    else await symlink(path.join(root, 'real'), path.join(root, 'link'))
    await expect(
      verifyBtFiles({
        metadata: storageTorrent(
          [{ name: kind === 'leaf' ? 'link' : 'link/file', data: 'data' }],
          true
        ),
        payloadPath: root,
      })
    ).rejects.toThrow(/unsafe|regular/)
  })

  it('rejects overlapping metadata paths before opening files', async () => {
    await expect(
      verifyBtFiles({
        metadata: storageTorrent([
          { name: 'a', data: 'a' },
          { name: 'a/b', data: 'b' },
        ]),
        payloadPath: root,
      })
    ).rejects.toThrow(/Overlapping|file\/directory conflict/)
  })

  it('rejects out-of-range selected indices', async () => {
    await expect(
      verifyBtFiles({
        metadata: storageTorrent([{ name: 'a', data: 'a' }]),
        payloadPath: path.join(root, 'a'),
        selectedFiles: [3],
      })
    ).rejects.toThrow('selection')
  })

  it('rejects files changed after their first pieces were checked', async () => {
    const payloadPath = path.join(root, 'a')
    await writeFile(payloadPath, 'abcdefgh')
    let changed = false
    const result = await verifyBtFiles({
      metadata: storageTorrent([{ name: 'a', data: 'abcdefgh' }]),
      payloadPath,
      onProgress: () => {
        if (!changed) {
          changed = true
          writeFileSync(payloadPath, 'abcdEFGH')
        }
      },
    })
    expect(result.complete).toBe(false)
  })

  it('cancels between pieces without modifying data', async () => {
    const controller = new AbortController()
    await writeFile(path.join(root, 'a'), 'abcdefgh')
    await expect(
      verifyBtFiles({
        metadata: storageTorrent([{ name: 'a', data: 'abcdefgh' }]),
        payloadPath: path.join(root, 'a'),
        signal: controller.signal,
        onProgress: () => controller.abort(),
      })
    ).rejects.toMatchObject({ name: 'AbortError' })
    expect(await readFile(path.join(root, 'a'), 'utf8')).toBe('abcdefgh')
  })
})
