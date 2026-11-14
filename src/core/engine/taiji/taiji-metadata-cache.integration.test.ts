import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { encode, parseTorrent } from '@motrix/torrent'
import { startMetadataPeer } from '@test-utils/metadata-peer'
import { bundled, listen, start } from '@test-utils/taiji'
import { expect, it } from 'vitest'

it.skipIf(!process.env.MOTRIX_TAIJI_BIN && !existsSync(bundled))(
  'resolves a new magnet offline from verified persistent cache after removing its earlier task and restarting',
  async () => {
    const directory = await mkdtemp(
      path.join(tmpdir(), 'motrix-persistent-metadata-')
    )
    const info = Buffer.from(
      encode({
        name: 'cached.bin',
        length: 16384,
        'piece length': 16384,
        pieces: createHash('sha1').update(Buffer.alloc(16384, 81)).digest(),
      })
    )
    const peer = await startMetadataPeer(info)
    const compact = Buffer.from([127, 0, 0, 1, peer.port >> 8, peer.port & 255])
    let announces = 0
    const tracker = createServer((_request, response) => {
      announces++
      response.end(encode({ interval: 3600, peers: compact }))
    })
    let engine: Awaited<ReturnType<typeof start>> | undefined
    try {
      const port = await listen(tracker)
      engine = await start(directory)
      const first = await engine.adapter.fetchMagnetMetadata({
        uri: `magnet:?xt=urn:btih:${peer.hash}&tr=${encodeURIComponent(`http://127.0.0.1:${port}/private-passkey/announce`)}`,
        saveDir: path.join(directory, 'first'),
      })
      await expect
        .poll(async () => (await engine!.rpc.tellStatus(first)).status, {
          timeout: 8000,
        })
        .toBe('paused')
      const cold = await engine.adapter.getMagnetResolution(first)
      expect(cold?.cache).toBeNull()
      expect(cold?.milestones.firstHandshakeMs).toEqual(expect.any(Number))
      expect(cold?.milestones.firstInfoBlockMs).toEqual(expect.any(Number))
      expect(cold?.milestones.metadataReadyMs).toEqual(expect.any(Number))
      await engine.adapter.removeTask(first)
      await expect(engine.rpc.tellStatus(first)).rejects.toThrow('not found')
      const oldAnnounces = announces
      const oldRequests = peer.requests()
      await engine.close()
      engine = await start(directory)
      const second = await engine.adapter.fetchMagnetMetadata({
        uri: `magnet:?xt=urn:btih:${peer.hash}`,
        saveDir: path.join(directory, 'second'),
      })
      await expect
        .poll(async () => (await engine!.rpc.tellStatus(second)).status, {
          timeout: 3000,
        })
        .toBe('paused')
      expect(second).not.toBe(first)
      const metadata = await engine.adapter.getTorrentMetadata(second)
      const bytes = Buffer.from(metadata.data, 'base64')
      expect(parseTorrent(bytes).identity).toEqual({
        kind: 'v1',
        sha1: peer.hash,
      })
      expect(bytes.includes(Buffer.from('private-passkey'))).toBe(false)
      const warm = await engine.adapter.getMagnetResolution(second)
      expect(warm?.cache).toBe('persistent')
      expect(warm?.milestones.firstCandidateMs).toBeUndefined()
      expect(warm?.milestones.metadataReadyMs).toEqual(expect.any(Number))
      expect(announces).toBe(oldAnnounces)
      expect(peer.requests()).toBe(oldRequests)
      expect(peer.payloadRequests()).toEqual([])
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
