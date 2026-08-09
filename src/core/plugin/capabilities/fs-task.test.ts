import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { FsTaskCapabilityHost } from './fs-task'

const CONTENT = 'Hello, plugin fs.task!\nLine two.\nLine three.\n'
const IDLE_MS = 200

function makeHost(
  saveDir: string,
  filePath: string,
  extra?: Partial<ConstructorParameters<typeof FsTaskCapabilityHost>[0]>
) {
  return new FsTaskCapabilityHost({
    saveDir,
    filePath,
    readerIdleMs: IDLE_MS,
    ...extra,
  })
}

describe('FsTaskCapabilityHost', () => {
  let saveDir: string
  let filePath: string
  let host: FsTaskCapabilityHost

  beforeEach(() => {
    saveDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fs-task-'))
    filePath = path.join(saveDir, 'task-file.txt')
    fs.writeFileSync(filePath, CONTENT, 'utf8')
    host = makeHost(saveDir, filePath)
  })

  afterEach(() => {
    host.disposeAllReaders()
    fs.rmSync(saveDir, { recursive: true, force: true })
  })

  // -------------------------------------------------------------------------
  // 1. stat returns only {size, mtime} per spec §4 L1215
  // -------------------------------------------------------------------------

  it('stat returns only {size, mtime}', async () => {
    const s = await host.stat()
    expect(s.size).toBe(Buffer.byteLength(CONTENT, 'utf8'))
    expect(s.mtime).toBeGreaterThan(0)
    // Spec-aligned surface: no isFile, isDirectory, or mtimeMs.
    expect(Object.keys(s).sort()).toEqual(['mtime', 'size'])
  })

  // -------------------------------------------------------------------------
  // 2. exists true when present, false when deleted
  // -------------------------------------------------------------------------

  it('exists returns true when file is present', async () => {
    expect(await host.exists()).toBe(true)
  })

  it('exists returns false when file is deleted', async () => {
    fs.unlinkSync(filePath)
    expect(await host.exists()).toBe(false)
  })

  // -------------------------------------------------------------------------
  // 3. openReader offset=0 reads data, then null at EOF
  // -------------------------------------------------------------------------

  it('openReader reads full content then returns null at EOF', async () => {
    const reader = host.openReader({ offset: 0 })
    const chunks: Uint8Array[] = []
    for (;;) {
      const chunk = await reader.read(1024)
      if (chunk === null) break
      chunks.push(chunk)
    }
    reader.close()
    const total = Buffer.concat(chunks.map((c) => Buffer.from(c))).toString(
      'utf8'
    )
    expect(total).toBe(CONTENT)
  })

  // -------------------------------------------------------------------------
  // 4. openReader with offset partway returns remaining bytes
  // -------------------------------------------------------------------------

  it('openReader with offset reads from that position', async () => {
    const offset = 7 // skip "Hello, "
    const reader = host.openReader({ offset })
    const chunks: Uint8Array[] = []
    for (;;) {
      const chunk = await reader.read(1024)
      if (chunk === null) break
      chunks.push(chunk)
    }
    reader.close()
    const result = Buffer.concat(chunks.map((c) => Buffer.from(c))).toString(
      'utf8'
    )
    expect(result).toBe(CONTENT.slice(offset))
  })

  // -------------------------------------------------------------------------
  // 5. openReader with length cap returns at most length bytes total
  // -------------------------------------------------------------------------

  it('openReader with length cap delivers at most length bytes', async () => {
    const length = 10
    const reader = host.openReader({ offset: 0, length })
    const chunks: Uint8Array[] = []
    for (;;) {
      const chunk = await reader.read(4)
      if (chunk === null) break
      chunks.push(chunk)
    }
    reader.close()
    const total = chunks.reduce((sum, c) => sum + c.byteLength, 0)
    expect(total).toBe(length)
    const text = Buffer.concat(chunks.map((c) => Buffer.from(c))).toString(
      'utf8'
    )
    expect(text).toBe(CONTENT.slice(0, length))
  })

  // -------------------------------------------------------------------------
  // 6. read(maxChunkSize > 16 MB) throws chunk_too_large
  // -------------------------------------------------------------------------

  it('read() with maxChunkSize > 16 MB throws chunk_too_large', async () => {
    const reader = host.openReader({ offset: 0 })
    const bigSize = (16 << 20) + 1
    await expect(reader.read(bigSize)).rejects.toMatchObject({
      code: 'plugin.fs.chunk_too_large',
    })
    reader.close()
  })

  // -------------------------------------------------------------------------
  // 7. Opening 4 readers throws too_many_readers on 4th; close one → succeeds
  // -------------------------------------------------------------------------

  it('throws too_many_readers at the cap; succeeds after closing one', async () => {
    const r1 = host.openReader({ offset: 0 })
    const r2 = host.openReader({ offset: 0 })
    const r3 = host.openReader({ offset: 0 })
    expect(() => host.openReader({ offset: 0 })).toThrow(
      expect.objectContaining({ code: 'plugin.fs.too_many_readers' })
    )
    r1.close()
    // Now cap has room
    const r4 = host.openReader({ offset: 0 })
    expect(r4).toBeDefined()
    r2.close()
    r3.close()
    r4.close()
  })

  // -------------------------------------------------------------------------
  // 8. Idle auto-close: wait readerIdleMs * 2, read() returns null
  // -------------------------------------------------------------------------

  it('reader auto-closes after idle timeout; subsequent read returns null', async () => {
    const reader = host.openReader({ offset: 0 })
    // Wait longer than idle timeout
    await new Promise((r) => setTimeout(r, IDLE_MS * 2))
    const result = await reader.read(64)
    expect(result).toBeNull()
    // close() should be idempotent
    reader.close()
    reader.close()
  })

  // -------------------------------------------------------------------------
  // 9. computeHash('sha256') matches node:crypto direct computation
  // -------------------------------------------------------------------------

  it('computeHash sha256 returns correct 64-char hex digest', async () => {
    const hex = await host.computeHash('sha256')
    // writeFileSync(..., 'utf8') and Buffer.from(CONTENT, 'utf8') produce identical bytes, making this comparison exact
    const expected = createHash('sha256')
      .update(Buffer.from(CONTENT, 'utf8'))
      .digest('hex')
    expect(hex).toBe(expected)
    expect(hex).toHaveLength(64)
  })

  // -------------------------------------------------------------------------
  // 10. rename updates filePath; original gone; new path exists; stat works
  // -------------------------------------------------------------------------

  it('rename updates filePath and moves the file', async () => {
    await host.rename('renamed.txt')
    const newPath = path.join(saveDir, 'renamed.txt')
    expect(host.filePath).toBe(newPath)
    expect(fs.existsSync(filePath)).toBe(false)
    expect(fs.existsSync(newPath)).toBe(true)
    const s = await host.stat()
    expect(s.size).toBe(Buffer.byteLength(CONTENT, 'utf8'))
  })

  // -------------------------------------------------------------------------
  // 11. rename('a/b.txt') rejects with invalid_basename
  // -------------------------------------------------------------------------

  it('rename with path separator rejects as invalid_basename', async () => {
    await expect(host.rename('a/b.txt')).rejects.toMatchObject({
      code: 'plugin.fs.invalid_basename',
    })
  })

  // -------------------------------------------------------------------------
  // 12. rename to existing file rejects with rename_target_exists
  // -------------------------------------------------------------------------

  it('rename to an existing file rejects with rename_target_exists', async () => {
    const existing = path.join(saveDir, 'existing.txt')
    fs.writeFileSync(existing, 'other')
    await expect(host.rename('existing.txt')).rejects.toMatchObject({
      code: 'plugin.fs.rename_target_exists',
    })
  })

  // -------------------------------------------------------------------------
  // 13. disposeAllReaders closes all readers; read() returns null afterward
  // -------------------------------------------------------------------------

  it('disposeAllReaders closes all open readers', async () => {
    const r1 = host.openReader({ offset: 0 })
    const r2 = host.openReader({ offset: 0 })
    // Prime the file handles by reading once
    await r1.read(4)
    await r2.read(4)
    host.disposeAllReaders()
    // After dispose, subsequent reads return null
    const res1 = await r1.read(4)
    const res2 = await r2.read(4)
    expect(res1).toBeNull()
    expect(res2).toBeNull()
    // close() is idempotent
    r1.close()
    r2.close()
  })
})
