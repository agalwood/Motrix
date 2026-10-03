import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { Aria2RawStatus } from '@core/engine/aria2/types'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  type Aria2Handle,
  bundledAria2Exists,
  canBindLoopbackTcp,
  connectAdapter,
  spawnAria2ForTest,
} from '../../test-utils/aria2'
import { createTorrent } from './create-torrent'

// End-to-end oracle for the create-torrent feature (#459): the metainfo we
// build must be accepted by a real aria2, hash-identify the SAME info hash,
// and recognize the already-present source data (checksum passes, no
// re-download) — the exact loop "create → add → seed" users will run.
describe.skipIf(!bundledAria2Exists() || !canBindLoopbackTcp())(
  'create-torrent roundtrip with real aria2',
  () => {
    let directory: string
    let handle: Aria2Handle
    let wired: Awaited<ReturnType<typeof connectAdapter>>

    beforeEach(async () => {
      directory = await mkdtemp(
        path.join(tmpdir(), 'motrix-create-torrent-aria2-')
      )
      handle = await spawnAria2ForTest({ baseDir: directory })
      wired = await connectAdapter(handle)
    })

    afterEach(async () => {
      wired.disconnect()
      await handle.kill()
      await rm(directory, { recursive: true, force: true })
    })

    it('adds and hash-checks the created metainfo against existing data', async () => {
      const payload = 'aria2 create-torrent integration payload\n'
      const sourceFile = path.join(directory, 'payload.bin')
      await writeFile(sourceFile, payload)

      const result = await createTorrent({
        sourcePath: sourceFile,
        pieceLength: 16 * 1024,
      })
      expect(result.totalSize).toBe(payload.length)

      const gid = await wired.adapter.addTorrent({
        metadata: result.bytes,
        saveDir: directory,
        checkIntegrity: true,
        seedRatio: 0,
        seedTime: 0,
      })
      expect(gid).toMatch(/^[0-9a-fA-F]{16}$/)

      // Poll until the checksum pass settles. With the data already on
      // disk, aria2 finishes hashing almost immediately; completedLength
      // reaching totalSize proves the data was accepted, not re-downloaded.
      const deadline = Date.now() + 15_000
      let raw: Aria2RawStatus | null = null
      while (Date.now() < deadline) {
        const current = (await wired.rpc.tellStatus(gid)) as Aria2RawStatus
        if (
          current.completedLength === current.totalLength &&
          ['active', 'complete', 'seeding', 'waiting'].includes(current.status)
        ) {
          raw = current
          break
        }
        await new Promise((resolve) => setTimeout(resolve, 100))
      }
      expect(raw).not.toBeNull()
      expect(raw!.infoHash).toBe(result.infoHash)
      expect(raw!.totalLength).toBe(String(payload.length))

      // The source file must be untouched by the hash-check.
      expect(await readFile(sourceFile, 'utf8')).toBe(payload)
    })

    it('adds a multi-file folder torrent and recognizes all files', async () => {
      const folder = path.join(directory, 'bundle')
      await mkdir(folder)
      await writeFile(path.join(folder, 'a.txt'), 'alpha\n')
      await writeFile(path.join(folder, 'b.txt'), 'beta\n')

      const result = await createTorrent({
        sourcePath: folder,
        pieceLength: 16 * 1024,
      })
      expect(result.fileCount).toBe(2)

      const gid = await wired.adapter.addTorrent({
        metadata: result.bytes,
        saveDir: directory,
        checkIntegrity: true,
        seedRatio: 0,
        seedTime: 0,
      })
      const deadline = Date.now() + 15_000
      let raw: Aria2RawStatus | null = null
      while (Date.now() < deadline) {
        const current = (await wired.rpc.tellStatus(gid)) as Aria2RawStatus
        if (
          current.completedLength === current.totalLength &&
          ['active', 'complete', 'seeding', 'waiting'].includes(current.status)
        ) {
          raw = current
          break
        }
        await new Promise((resolve) => setTimeout(resolve, 100))
      }
      expect(raw).not.toBeNull()
      expect(raw!.infoHash).toBe(result.infoHash)
      expect(Number(raw!.totalLength)).toBe(11)
      expect((await stat(path.join(folder, 'a.txt'))).isFile()).toBe(true)
    })
  }
)
