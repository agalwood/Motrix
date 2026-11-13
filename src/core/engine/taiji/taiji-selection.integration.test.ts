import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { encode, parseTorrent } from '@motrix/torrent'
import { TaskType } from '@shared/types/task'
import { startMetadataPeer } from '@test-utils/metadata-peer'
import { bundled, listen, start } from '@test-utils/taiji'
import { expect, it } from 'vitest'

it
  .skipIf(!process.env.MOTRIX_TAIJI_BIN && !existsSync(bundled))
  .each([true, false])(
  'keeps one magnet task through selection, restart and completion (aligned files: %s)',
  async (aligned) => {
    const directory = await mkdtemp(path.join(tmpdir(), 'motrix-selection-'))
    const firstSize = aligned ? 16384 : 8192
    const secondSize = 32768 - firstSize
    const payload = Buffer.concat([
      Buffer.alloc(firstSize, 11),
      Buffer.alloc(secondSize, 29),
    ])
    const info = Buffer.from(
      encode({
        name: 'original',
        'piece length': 16384,
        pieces: Buffer.concat(
          [0, 1].map((index) =>
            createHash('sha1')
              .update(payload.subarray(index * 16384, (index + 1) * 16384))
              .digest()
          )
        ),
        files: [
          { length: firstSize, path: ['first.bin'] },
          { length: secondSize, path: ['second.bin'] },
        ],
      })
    )
    const peer = await startMetadataPeer(info, payload)
    const compact = Buffer.from([127, 0, 0, 1, peer.port >> 8, peer.port & 255])
    const tracker = createServer((_request, response) =>
      response.end(encode({ interval: 3600, peers: compact }))
    )
    let engine: Awaited<ReturnType<typeof start>> | undefined
    try {
      const port = await listen(tracker)
      engine = await start(directory)
      const gid = await engine.adapter.fetchMagnetMetadata({
        uri: `magnet:?xt=urn:btih:${peer.hash}&tr=${encodeURIComponent(`http://127.0.0.1:${port}/announce`)}`,
        saveDir: path.join(directory, 'metadata'),
        engineTaskId: '0123456789abcdef',
      })
      await expect
        .poll(async () => (await engine!.rpc.tellStatus(gid)).status, {
          timeout: 8000,
        })
        .toBe('paused')
      const metadata = await engine.adapter.getTorrentMetadata(gid)
      expect(metadata.awaitingSelection).toBe(true)
      expect((await engine.rpc.tellStatus(gid)).numPieces).toBe('2')
      expect((await engine.adapter.getTaskStatus(gid))?.type).toBe(TaskType.Bt)
      expect(
        parseTorrent(Buffer.from(metadata.data, 'base64')).identity
      ).toEqual({ kind: 'v1', sha1: peer.hash })
      await engine.adapter.resumeAll()
      await expect(engine.adapter.resumeTask(gid)).rejects.toThrow(
        'awaiting confirmation'
      )
      expect((await engine.rpc.tellStatus(gid)).status).toBe('paused')
      expect(peer.payloadRequests()).toEqual([])
      const fetched = peer.requests()
      await engine.close()
      engine = await start(directory)
      await engine.adapter.resumeAll()
      expect((await engine.rpc.tellStatus(gid)).status).toBe('paused')
      expect(peer.requests()).toBe(fetched)
      expect(peer.payloadRequests()).toEqual([])
      await expect(
        engine.rpc.confirmTorrentSelection(gid, {
          dir: directory,
          'select-file': '3',
        })
      ).rejects.toThrow()
      expect(
        (await engine.adapter.getTorrentMetadata(gid)).awaitingSelection
      ).toBe(true)
      const selection = {
        saveDir: path.join(directory, 'selected'),
        selectedFiles: [1],
        outputFilePaths: [
          { fileIndex: 0, relativePath: 'unused.bin' },
          { fileIndex: 1, relativePath: 'renamed.bin' },
        ],
      }
      await engine.adapter.confirmTorrentSelection(gid, selection)
      await expect
        .poll(async () => (await engine!.rpc.tellStatus(gid)).completedLength, {
          timeout: 8000,
        })
        .toBe(String(secondSize))
      expect(
        await readFile(path.join(selection.saveDir, 'renamed.bin'))
      ).toEqual(payload.subarray(firstSize))
      if (aligned)
        expect(existsSync(path.join(selection.saveDir, 'unused.bin'))).toBe(
          false
        )
      expect(new Set(peer.payloadRequests())).toEqual(
        new Set(aligned ? [1] : [0, 1])
      )
      const completed = await engine.adapter.getTaskStatus(gid)
      expect(completed?.totalBytes).toBe(secondSize)
      expect(completed?.progress).toBe(1)
      await engine.adapter.confirmTorrentSelection(gid, selection)
      const all = [
        ...(await engine.rpc.tellActive()),
        ...(await engine.rpc.tellWaiting(0, 100)),
        ...(await engine.rpc.tellStopped(0, 100)),
      ]
      expect(all.map((task) => task.gid)).toEqual([gid])
    } finally {
      await engine?.close()
      tracker.closeAllConnections()
      await new Promise<void>((resolve) => tracker.close(() => resolve()))
      await peer.close()
      await rm(directory, { recursive: true, force: true })
    }
  },
  20000
)
