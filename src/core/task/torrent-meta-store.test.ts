import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { TorrentMetaStoreImpl } from './torrent-meta-store'

describe('TorrentMetaStore', () => {
  let baseDir: string
  let store: TorrentMetaStoreImpl

  beforeEach(() => {
    baseDir = mkdtempSync(path.join(tmpdir(), 'metastore-'))
    store = new TorrentMetaStoreImpl(baseDir)
  })

  afterEach(() => {
    rmSync(baseDir, { recursive: true, force: true })
  })

  it('persists and reads torrent bytes by taskId', async () => {
    const bytes = new Uint8Array([0xde, 0xad, 0xbe, 0xef])
    const pathOut = await store.persist('task-1', bytes)
    expect(pathOut).toBe(path.join(baseDir, 'task-1.torrent'))

    const read = await store.read(pathOut)
    expect(Array.from(read)).toEqual([0xde, 0xad, 0xbe, 0xef])
  })

  it('remove deletes the file', async () => {
    const bytes = new Uint8Array([0x01])
    const pathOut = await store.persist('task-2', bytes)
    await store.remove(pathOut)
    expect(() => readFileSync(pathOut)).toThrow()
  })

  it('remove is idempotent (ignores ENOENT)', async () => {
    await expect(
      store.remove(path.join(baseDir, 'nonexistent.torrent'))
    ).resolves.not.toThrow()
  })

  it('read throws on missing file', async () => {
    await expect(
      store.read(path.join(baseDir, 'missing.torrent'))
    ).rejects.toThrow()
  })
})
