import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import { FsStorageCapabilityHost, FsStorageError } from './fs-storage'

function makeHost(root: string) {
  return new FsStorageCapabilityHost({ pluginStorageRoot: root })
}

describe('FsStorageCapabilityHost', () => {
  let root: string
  let host: FsStorageCapabilityHost

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'fs-storage-'))
    host = makeHost(root)
  })

  // -------------------------------------------------------------------------
  // 1. Write then read round-trip (utf8)
  // -------------------------------------------------------------------------

  it('writes and reads a utf8 string round-trip', async () => {
    await host.write('hello.txt', 'world')
    const result = await host.read('hello.txt')
    expect(result).toBe('world')
  })

  // -------------------------------------------------------------------------
  // 2. Binary write/read round-trip
  // -------------------------------------------------------------------------

  it('writes and reads binary data', async () => {
    const data = new Uint8Array([1, 2, 3, 255])
    await host.write('blob.bin', data, { encoding: 'binary' })
    const back = await host.read('blob.bin', { encoding: 'binary' })
    expect(back).toBeInstanceOf(Uint8Array)
    expect(Array.from(back as Uint8Array)).toEqual([1, 2, 3, 255])
  })

  // -------------------------------------------------------------------------
  // 3. Write without overwrite on existing target
  // -------------------------------------------------------------------------

  it('rejects overwrite:false when target already exists', async () => {
    await host.write('existing.txt', 'original')
    await expect(
      host.write('existing.txt', 'new', { overwrite: false })
    ).rejects.toMatchObject({ code: 'plugin.fs.overwrite_required' })
  })

  // -------------------------------------------------------------------------
  // 4. Write with overwrite=true (default) silently overwrites
  // -------------------------------------------------------------------------

  it('overwrites silently with overwrite:true (default)', async () => {
    await host.write('file.txt', 'first')
    await host.write('file.txt', 'second')
    expect(await host.read('file.txt')).toBe('second')
  })

  // -------------------------------------------------------------------------
  // 5. mkdir recursive creates nested path
  // -------------------------------------------------------------------------

  it('mkdir recursive creates nested directories', async () => {
    await host.mkdir('a/b/c')
    expect(await host.exists('a')).toBe(true)
    expect(await host.exists('a/b')).toBe(true)
    expect(await host.exists('a/b/c')).toBe(true)
  })

  // -------------------------------------------------------------------------
  // 6. delete returns correct boolean
  // -------------------------------------------------------------------------

  it('delete returns {deleted:true} for existing file', async () => {
    await host.write('todelete.txt', 'bye')
    expect(await host.delete('todelete.txt')).toEqual({ deleted: true })
  })

  it('delete returns {deleted:false} for missing file', async () => {
    expect(await host.delete('nonexistent.txt')).toEqual({ deleted: false })
  })

  // -------------------------------------------------------------------------
  // 7. rename within sandbox
  // -------------------------------------------------------------------------

  it('renames a file within the sandbox', async () => {
    await host.write('src.txt', 'content')
    await host.rename('src.txt', 'dst.txt')
    expect(await host.exists('src.txt')).toBe(false)
    expect(await host.read('dst.txt')).toBe('content')
  })

  // -------------------------------------------------------------------------
  // 8. Path traversal rejected
  // -------------------------------------------------------------------------

  it('rejects path traversal with path_outside_sandbox', async () => {
    await expect(host.read('../escape.txt')).rejects.toMatchObject({
      code: 'plugin.fs.path_outside_sandbox',
    })
  })

  // -------------------------------------------------------------------------
  // 9. Atomic write — no tmp file left behind after success
  // -------------------------------------------------------------------------

  it('leaves only the target file after a successful write', async () => {
    await host.write('atomic.txt', 'data')
    const entries = fs.readdirSync(root)
    expect(entries).toEqual(['atomic.txt'])
  })

  // -------------------------------------------------------------------------
  // 10a. stat on missing rejects not_found
  // -------------------------------------------------------------------------

  it('stat on missing path rejects with not_found', async () => {
    await expect(host.stat('missing.txt')).rejects.toMatchObject({
      code: 'plugin.fs.not_found',
    })
  })

  // -------------------------------------------------------------------------
  // 10b. stat on file returns correct shape
  // -------------------------------------------------------------------------

  it('stat on file returns size and isFile:true', async () => {
    await host.write('statme.txt', 'hello')
    const s = await host.stat('statme.txt')
    expect(s.isFile).toBe(true)
    expect(s.isDirectory).toBe(false)
    expect(s.size).toBeGreaterThan(0)
    expect(typeof s.mtimeMs).toBe('number')
  })

  // -------------------------------------------------------------------------
  // 11. read on missing rejects not_found
  // -------------------------------------------------------------------------

  it('read on missing path rejects with not_found', async () => {
    await expect(host.read('nope.txt')).rejects.toMatchObject({
      code: 'plugin.fs.not_found',
    })
  })

  // -------------------------------------------------------------------------
  // Extra: FsStorageError is instance of Error
  // -------------------------------------------------------------------------

  it('FsStorageError is an Error subclass', () => {
    const e = new FsStorageError('plugin.fs.not_found', 'test')
    expect(e).toBeInstanceOf(Error)
    expect(e.code).toBe('plugin.fs.not_found')
  })
})
