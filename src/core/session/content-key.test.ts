import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { DownloadTask } from '@shared/types/task'
import { TaskKind, TaskType } from '@shared/types/task'
import { makeDownloadTask } from '@test-utils/task'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { computeUriHash, deriveInfoHash } from './content-key'

describe('computeUriHash', () => {
  it('returns null for empty uri list', () => {
    expect(computeUriHash([])).toBeNull()
  })

  it('returns a 16-char hex string for a single uri', () => {
    const result = computeUriHash(['http://example.com/file.zip'])
    expect(result).toMatch(/^[0-9a-f]{16}$/)
  })

  it('is deterministic across reorder', () => {
    const a = computeUriHash([
      'http://a.example.com/f.zip',
      'http://b.example.com/f.zip',
    ])
    const b = computeUriHash([
      'http://b.example.com/f.zip',
      'http://a.example.com/f.zip',
    ])
    expect(a).toBe(b)
  })

  it('differs across distinct uri sets', () => {
    const a = computeUriHash(['http://example.com/file1.zip'])
    const b = computeUriHash(['http://example.com/file2.zip'])
    expect(a).not.toBe(b)
  })
})

function createTask(overrides: Partial<DownloadTask> = {}): DownloadTask {
  return makeDownloadTask({
    id: 't1',
    engineTaskId: 'gid001',
    name: 'test',
    kind: TaskKind.Bt,
    type: TaskType.Bt,
    saveDir: '/tmp',
    filename: 'test',
    ...overrides,
  })
}

describe('deriveInfoHash', () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'motrix-contentkey-'))
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('returns task.infoHash when set', async () => {
    const task = createTask({
      infoHash: 'aaaa1111bbbb2222cccc3333dddd4444eeee5555',
    })
    await expect(deriveInfoHash(task)).resolves.toBe(
      'aaaa1111bbbb2222cccc3333dddd4444eeee5555'
    )
  })

  it('returns null when task has no infoHash and no torrentMetaPath', async () => {
    const task = createTask({ infoHash: null, torrentMetaPath: null })
    await expect(deriveInfoHash(task)).resolves.toBeNull()
  })

  it('returns null when torrentMetaPath does not exist', async () => {
    const task = createTask({
      infoHash: null,
      torrentMetaPath: path.join(tmpDir, 'nope.torrent'),
    })
    await expect(deriveInfoHash(task)).resolves.toBeNull()
  })

  it('parses info_hash from torrentMetaPath bytes when task.infoHash absent', async () => {
    // Minimal valid single-file torrent: info.name=f, piece length=1, pieces=20 bytes, length=1
    const torrentBytes = Buffer.from(
      '64343a696e666f64363a6c656e677468693165343a6e616d65313a6631323a7069656365206c656e677468693165363a70696563657332303a61616161616161616161616161616161616161616565',
      'hex'
    )
    const torrentPath = path.join(tmpDir, 'sample.torrent')
    fs.writeFileSync(torrentPath, torrentBytes)
    const task = createTask({ infoHash: null, torrentMetaPath: torrentPath })

    const result = await deriveInfoHash(task)
    expect(result).toMatch(/^[0-9a-f]{40}$/)
  })

  it('returns null when torrentMetaPath bytes are malformed', async () => {
    const badPath = path.join(tmpDir, 'bad.torrent')
    fs.writeFileSync(badPath, 'not bencoded')
    const task = createTask({ infoHash: null, torrentMetaPath: badPath })

    await expect(deriveInfoHash(task)).resolves.toBeNull()
  })

  it('memoizes by torrentMetaPath so repeat saves do not re-read disk', async () => {
    const torrentBytes = Buffer.from(
      '64343a696e666f64363a6c656e677468693165343a6e616d65313a6631323a7069656365206c656e677468693165363a70696563657332303a61616161616161616161616161616161616161616565',
      'hex'
    )
    const torrentPath = path.join(tmpDir, 'memo.torrent')
    fs.writeFileSync(torrentPath, torrentBytes)
    const task = createTask({ infoHash: null, torrentMetaPath: torrentPath })

    const first = await deriveInfoHash(task)
    expect(first).toMatch(/^[0-9a-f]{40}$/)

    // The .torrent → infoHash mapping is immutable; a later derive must hit
    // the cache, not the disk. Delete the file to prove no second read.
    fs.rmSync(torrentPath)
    await expect(deriveInfoHash(task)).resolves.toBe(first)
  })
})
