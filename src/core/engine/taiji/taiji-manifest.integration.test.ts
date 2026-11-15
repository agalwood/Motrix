import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { encode, parseTorrent } from '@motrix/torrent'
import { bundled, listen, start } from '@test-utils/taiji'
import { startV2MetadataPeer } from '@test-utils/v2-metadata-peer'
import { describe, expect, it, vi } from 'vitest'

function requestedInfoHash(url: string | undefined): string {
  const value = url?.match(/[?&]info_hash=([^&]*)/)?.[1] ?? ''
  return Buffer.from(
    value
      .replace(/\+/g, ' ')
      .replace(/%([0-9a-f]{2})/gi, (_whole, hex: string) =>
        String.fromCharCode(Number.parseInt(hex, 16))
      ),
    'latin1'
  ).toString('hex')
}

describe.skipIf(!process.env.MOTRIX_TAIJI_BIN && !existsSync(bundled))(
  'native verified manifests',
  () => {
    it.each([
      { pieceLength: 32768, pieces: 2, hybrid: false },
      { pieceLength: 16384, pieces: 513, hybrid: false },
      { pieceLength: 32768, pieces: 2, hybrid: true },
    ])(
      'shows $pieces pieces of $pieceLength bytes (hybrid=$hybrid) before proofs, then downloads on the same GID',
      async (shape) => {
        const directory = await mkdtemp(
          path.join(tmpdir(), 'motrix-v2-manifest-')
        )
        const peer = await startV2MetadataPeer({ ...shape, proofs: false })
        const compact = Buffer.from([
          127,
          0,
          0,
          1,
          peer.port >> 8,
          peer.port & 255,
        ])
        // Hybrid metadata is exercised over v2 discovery only here. Its v1
        // face already has usable hashes and is covered separately below.
        const tracker = createServer((request, response) =>
          response.end(
            encode({
              interval: 3600,
              peers:
                shape.hybrid && requestedInfoHash(request.url) === peer.infoHash
                  ? Buffer.alloc(0)
                  : compact,
            })
          )
        )
        let engine: Awaited<ReturnType<typeof start>> | undefined
        try {
          const port = await listen(tracker)
          engine = await start(directory)
          const ready: string[] = []
          const unsubscribe = engine.adapter.onTorrentMetadataReady((gid) =>
            ready.push(gid)
          )
          const gid = await engine.adapter.fetchMagnetMetadata({
            uri: `${peer.magnet}&tr=${encodeURIComponent(`http://127.0.0.1:${port}/announce`)}`,
            saveDir: path.join(directory, 'metadata'),
          })
          await expect.poll(() => ready, { timeout: 4000 }).toEqual([gid])
          unsubscribe()
          const result = await engine.adapter.getTorrentMetadata(gid)
          expect(result.awaitingSelection).toBe(true)
          expect(result.manifest.infoHash).toBe(peer.infoHash)
          expect(result.manifest.verificationReady).toBe(false)
          expect(result.manifest.files[0].length).toBe(peer.payload.length)
          expect(
            (await engine.rpc.tellStatus(gid, ['infoHash'])).infoHash
          ).toBe(peer.infoHash)
          expect(peer.hashRequests).toEqual([])
          expect(peer.payloadRequests).toEqual([])
          // Selection metadata and pending proof state survive process restart.
          await engine.close()
          engine = await start(directory)
          expect(
            (await engine.adapter.getTorrentMetadata(gid)).manifest
          ).toEqual(result.manifest)
          const policy = vi.fn(async () => ({ trackers: [], isPrivate: false }))
          engine.adapter.configureBtTrackerPolicy(policy)
          await engine.adapter.confirmTorrentSelection(gid, {
            saveDir: path.join(directory, 'selected'),
            selectedFiles: [0],
            outputFilePaths: [{ fileIndex: 0, relativePath: 'renamed.bin' }],
          })
          expect(policy).toHaveBeenCalledWith(
            expect.objectContaining({ engineGid: gid, verifiedPrivacy: false })
          )
          await expect
            .poll(
              async () => ({
                requested: peer.hashRequests.length > 0,
                state: await engine!.rpc.tellStatus(gid, [
                  'status',
                  'errorMessage',
                ]),
              }),
              { timeout: 15000 }
            )
            .toMatchObject({ requested: true })
            .catch(async (error) => {
              throw new Error(
                JSON.stringify({
                  hybrid: shape.hybrid,
                  payloadRequests: peer.payloadRequests,
                  status: await engine!.rpc.tellStatus(gid),
                  diagnostics: engine!.diagnostics(),
                }),
                { cause: error }
              )
            })
          expect(peer.hashRequests[0].base).toBe(
            Math.log2(shape.pieceLength / 16384)
          )
          expect(peer.payloadRequests).toEqual([])
          peer.enableProofs()
          await expect
            .poll(
              async () => (await engine!.rpc.tellStatus(gid)).completedLength,
              { timeout: 15000 }
            )
            .toBe(String(peer.payload.length))
          expect(
            await readFile(path.join(directory, 'selected/renamed.bin'))
          ).toEqual(peer.payload)
          const complete = await engine.adapter.getTorrentMetadata(gid)
          expect(complete.manifest.verificationReady).toBe(true)
          expect(complete.manifest.files[0].components).toEqual(['payload.bin'])
          expect(
            parseTorrent(Buffer.from(complete.data, 'base64')).identity.kind
          ).toBe(shape.hybrid ? 'hybrid' : 'v2')
          expect(
            (await engine.rpc.tellStatus(gid, ['infoHash'])).infoHash
          ).toBe(peer.infoHash)
        } finally {
          await engine?.close()
          tracker.closeAllConnections()
          await new Promise<void>((resolve) => tracker.close(() => resolve()))
          await peer.close()
          await rm(directory, { recursive: true, force: true })
        }
      },
      45000
    )

    it.each([
      { pieceLength: 32768, pieces: 2 },
      { pieceLength: 16384, pieces: 513 },
    ])(
      'exports authenticated piece layers for explicit metadata-only resolution: $pieceLength/$pieces',
      async (shape) => {
        const directory = await mkdtemp(path.join(tmpdir(), 'taiji-v2-proof-'))
        const peer = await startV2MetadataPeer(shape)
        const compact = Buffer.from([
          127,
          0,
          0,
          1,
          peer.port >> 8,
          peer.port & 255,
        ])
        const tracker = createServer((_request, response) =>
          response.end(encode({ interval: 3600, peers: compact }))
        )
        let engine: Awaited<ReturnType<typeof start>> | undefined
        try {
          const port = await listen(tracker)
          engine = await start(directory)
          const uri = `${peer.magnet}&tr=${encodeURIComponent(`http://127.0.0.1:${port}/announce`)}`
          const preview = await engine.adapter.fetchMagnetMetadata({
            uri,
            saveDir: directory,
          })
          await expect
            .poll(async () => (await engine!.rpc.tellStatus(preview)).status)
            .toBe('paused')
          expect(
            (await engine.adapter.getTorrentMetadata(preview)).manifest
              .verificationReady
          ).toBe(false)
          await engine.adapter.removeTask(preview)
          const gid = await engine.rpc.addUri([uri], {
            dir: directory,
            'bt-metadata-only': 'true',
            'bt-save-metadata': 'true',
          })
          await expect
            .poll(async () => (await engine!.rpc.tellStatus(gid)).status, {
              timeout: 8000,
            })
            .toBe('complete')
          const bytes = await readFile(
            path.join(directory, `${peer.infoHash}.torrent`)
          )
          expect(parseTorrent(bytes).identity).toEqual({
            kind: 'v2',
            sha256: peer.infoHash,
          })
          expect(
            peer.hashRequests.every(
              (request) =>
                request.base === Math.log2(shape.pieceLength / 16384) &&
                request.length <= 512
            )
          ).toBe(true)
          if (shape.pieces > 512)
            expect(peer.hashRequests.length).toBeGreaterThan(1)
          expect(peer.payloadRequests).toEqual([])
        } finally {
          await engine?.close()
          tracker.closeAllConnections()
          await new Promise<void>((resolve) => tracker.close(() => resolve()))
          await peer.close()
          await rm(directory, { recursive: true, force: true })
        }
      },
      15000
    )

    it('downloads hybrid content through verified v1 hashes while v2 proofs remain unavailable', async () => {
      const directory = await mkdtemp(path.join(tmpdir(), 'taiji-hybrid-v1-'))
      const peer = await startV2MetadataPeer({
        pieceLength: 32768,
        pieces: 2,
        hybrid: true,
        proofs: false,
      })
      const compact = Buffer.from([
        127,
        0,
        0,
        1,
        peer.port >> 8,
        peer.port & 255,
      ])
      const tracker = createServer((request, response) =>
        response.end(
          encode({
            interval: 3600,
            peers:
              requestedInfoHash(request.url) === peer.infoHash
                ? compact
                : Buffer.alloc(0),
          })
        )
      )
      let engine: Awaited<ReturnType<typeof start>> | undefined
      try {
        const port = await listen(tracker)
        engine = await start(directory)
        const gid = await engine.adapter.fetchMagnetMetadata({
          uri: `${peer.magnet}&tr=${encodeURIComponent(`http://127.0.0.1:${port}/announce`)}`,
          saveDir: directory,
        })
        await expect
          .poll(async () => (await engine!.rpc.tellStatus(gid)).status, {
            timeout: 5000,
          })
          .toBe('paused')
        expect(peer.payloadRequests).toEqual([])
        await engine.adapter.confirmTorrentSelection(gid, {
          saveDir: path.join(directory, 'selected'),
          selectedFiles: [0],
          outputFilePaths: [{ fileIndex: 0, relativePath: 'hybrid.bin' }],
        })
        await expect
          .poll(
            async () => (await engine!.rpc.tellStatus(gid)).completedLength,
            { timeout: 15000 }
          )
          .toBe(String(peer.payload.length))
        expect(
          await readFile(path.join(directory, 'selected/hybrid.bin'))
        ).toEqual(peer.payload)
        expect(peer.hashRequests).toEqual([])
        const manifest = (await engine.adapter.getTorrentMetadata(gid)).manifest
        expect(manifest.infoHash).toBe(peer.infoHash)
        expect(manifest.verificationReady).toBe(false)
      } finally {
        await engine?.close()
        tracker.closeAllConnections()
        await new Promise<void>((resolve) => tracker.close(() => resolve()))
        await peer.close()
        await rm(directory, { recursive: true, force: true })
      }
    }, 20000)

    it('does not report metadata readiness for an ordinary user pause', async () => {
      const directory = await mkdtemp(
        path.join(tmpdir(), 'taiji-metadata-pause-')
      )
      const tracker = createServer((_request, response) =>
        response.end(encode({ interval: 3600, peers: Buffer.alloc(0) }))
      )
      let engine: Awaited<ReturnType<typeof start>> | undefined
      try {
        const port = await listen(tracker)
        engine = await start(directory)
        const ready: string[] = []
        const unsubscribe = engine.adapter.onTorrentMetadataReady((gid) =>
          ready.push(gid)
        )
        const gid = await engine.adapter.fetchMagnetMetadata({
          uri: `magnet:?xt=urn:btih:${'7'.repeat(40)}&tr=${encodeURIComponent(`http://127.0.0.1:${port}/announce`)}`,
          saveDir: directory,
        })
        await engine.adapter.pauseTask(gid)
        await expect
          .poll(async () => (await engine!.rpc.tellStatus(gid)).status)
          .toBe('paused')
        await expect(engine.adapter.getTorrentMetadata(gid)).rejects.toThrow()
        expect(ready).toEqual([])
        unsubscribe()
      } finally {
        await engine?.close()
        tracker.closeAllConnections()
        await new Promise<void>((resolve) => tracker.close(() => resolve()))
        await rm(directory, { recursive: true, force: true })
      }
    }, 10000)

    it('rejects a corrupted network proof without exporting metadata or requesting payload', async () => {
      const directory = await mkdtemp(path.join(tmpdir(), 'taiji-bad-proof-'))
      const peer = await startV2MetadataPeer({
        pieceLength: 32768,
        pieces: 2,
        corruptProofs: true,
      })
      const compact = Buffer.from([
        127,
        0,
        0,
        1,
        peer.port >> 8,
        peer.port & 255,
      ])
      const tracker = createServer((_request, response) =>
        response.end(encode({ interval: 3600, peers: compact }))
      )
      let engine: Awaited<ReturnType<typeof start>> | undefined
      try {
        const port = await listen(tracker)
        engine = await start(directory)
        const gid = await engine.rpc.addUri(
          [
            `${peer.magnet}&tr=${encodeURIComponent(`http://127.0.0.1:${port}/announce`)}`,
          ],
          {
            dir: directory,
            'bt-metadata-only': 'true',
            'bt-save-metadata': 'true',
          }
        )
        await expect
          .poll(async () => (await engine!.rpc.tellStatus(gid)).status, {
            timeout: 8000,
          })
          .toBe('error')
        expect(peer.hashRequests.length).toBeGreaterThan(0)
        expect(peer.payloadRequests).toEqual([])
        expect(
          existsSync(path.join(directory, `${peer.infoHash}.torrent`))
        ).toBe(false)
      } finally {
        await engine?.close()
        tracker.closeAllConnections()
        await new Promise<void>((resolve) => tracker.close(() => resolve()))
        await peer.close()
        await rm(directory, { recursive: true, force: true })
      }
    }, 15000)

    it('does not discover a known private info-only cache through appended public trackers', async () => {
      const directory = await mkdtemp(
        path.join(tmpdir(), 'taiji-private-manifest-')
      )
      const peer = await startV2MetadataPeer({
        pieceLength: 32768,
        pieces: 2,
        private: true,
      })
      const compact = Buffer.from([
        127,
        0,
        0,
        1,
        peer.port >> 8,
        peer.port & 255,
      ])
      let announces = 0
      const tracker = createServer((_request, response) => {
        announces++
        response.end(encode({ interval: 3600, peers: compact }))
      })
      let engine: Awaited<ReturnType<typeof start>> | undefined
      try {
        const port = await listen(tracker)
        engine = await start(directory)
        const preview = await engine.adapter.fetchMagnetMetadata({
          uri: `${peer.magnet}&tr=${encodeURIComponent(`http://127.0.0.1:${port}/private/announce`)}`,
          saveDir: directory,
        })
        await expect
          .poll(async () => (await engine!.rpc.tellStatus(preview)).status)
          .toBe('paused')
        expect(
          (await engine.adapter.getTorrentMetadata(preview)).manifest.isPrivate
        ).toBe(true)
        await engine.adapter.removeTask(preview)
        await engine.close()
        engine = await start(directory)
        await engine.rpc.changeGlobalOption({
          'bt-tracker': `http://127.0.0.1:${port}/public/announce`,
        })
        const before = announces
        const gid = await engine.rpc.addUri([peer.magnet], {
          dir: directory,
          'bt-metadata-only': 'true',
          'bt-save-metadata': 'true',
        })
        await expect
          .poll(async () => (await engine!.rpc.tellStatus(gid)).status)
          .toBe('error')
        expect(announces).toBe(before)
        expect(peer.payloadRequests).toEqual([])
      } finally {
        await engine?.close()
        tracker.closeAllConnections()
        await new Promise<void>((resolve) => tracker.close(() => resolve()))
        await peer.close()
        await rm(directory, { recursive: true, force: true })
      }
    }, 15000)
  }
)
