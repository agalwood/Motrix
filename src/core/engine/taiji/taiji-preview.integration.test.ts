import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { decode, encode } from '@motrix/torrent'
import { startMetadataPeer } from '@test-utils/metadata-peer'
import { binary, listen, start } from '@test-utils/taiji'
import { startV2MetadataPeer } from '@test-utils/v2-metadata-peer'
import { describe, expect, it } from 'vitest'

const MIB = 1024 * 1024

describe.skipIf(!existsSync(binary))(
  'native preview priority on the peer wire',
  () => {
    it.each(['v1', 'v2', 'hybrid'] as const)(
      'preserves %s preview priority through the same-GID magnet barrier and restart',
      async (format) => {
        const directory = await mkdtemp(path.join(tmpdir(), 'motrix-preview-'))
        const pieceLength = format === 'v1' ? 16384 : 32768
        const payloadLength = 64 * MIB
        const v2 =
          format === 'v1'
            ? undefined
            : await startV2MetadataPeer({
                name: 'movie.mkv',
                pieceLength,
                pieces: payloadLength / pieceLength,
                hybrid: format === 'hybrid',
              })
        const payload = v2?.payload ?? Buffer.alloc(payloadLength, 37)
        const info =
          v2?.info ??
          Buffer.from(
            encode({
              name: 'movie.mkv',
              length: payload.length,
              'piece length': pieceLength,
              pieces: Buffer.concat(
                Array.from({ length: payload.length / pieceLength }, (_, i) =>
                  createHash('sha1')
                    .update(
                      payload.subarray(i * pieceLength, (i + 1) * pieceLength)
                    )
                    .digest()
                )
              ),
            })
          )
        const v1 = v2 ? undefined : await startMetadataPeer(info, payload)
        const port = v2?.port ?? v1!.port
        const requests = () => v2?.payloadRequests ?? v1!.payloadRequests()
        const tracker = createServer((_request, response) =>
          response.end(
            encode({
              interval: 3600,
              peers: Buffer.from([127, 0, 0, 1, port >> 8, port & 255]),
            })
          )
        )
        let engine: Awaited<ReturnType<typeof start>> | undefined
        let stage = 'start'
        try {
          const trackerPort = await listen(tracker)
          const trackerUrl = `http://127.0.0.1:${trackerPort}/announce`
          engine = await start(directory)
          await engine.rpc.changeGlobalOption({
            'max-concurrent-downloads': '1',
          })
          const blocker = await engine.rpc.addUri(
            [
              `magnet:?xt=urn:btih:${'11'.repeat(20)}&tr=${encodeURIComponent(trackerUrl)}`,
            ],
            { dir: path.join(directory, 'blocker') }
          )
          await expect
            .poll(async () => (await engine!.rpc.tellStatus(blocker)).status)
            .toBe('active')
          stage = 'metadata'
          const gid = await engine.adapter.fetchMagnetMetadata({
            uri: `${v2?.magnet ?? `magnet:?xt=urn:btih:${v1!.hash}`}&tr=${encodeURIComponent(trackerUrl)}`,
            saveDir: path.join(directory, 'metadata'),
          })
          await expect
            .poll(async () => (await engine!.rpc.tellStatus(gid)).status, {
              timeout: 10000,
            })
            .toBe('paused')
          expect(
            (await engine.adapter.getTorrentMetadata(gid)).awaitingSelection
          ).toBe(true)
          expect(requests()).toEqual([])
          stage = 'confirm'
          await engine.adapter.confirmTorrentSelection(gid, {
            saveDir: path.join(directory, 'payload'),
            selectedFiles: [0],
            outputFilePaths: [{ fileIndex: 0, relativePath: 'movie.mkv' }],
          })
          expect((await engine.rpc.tellStatus(gid)).status).toBe('waiting')
          expect((await engine.rpc.getOption(gid))['bt-prioritize-piece']).toBe(
            'head=10485760,tail=10485760'
          )
          expect(requests()).toEqual([])
          stage = 'pause-before-restart'
          await engine.adapter.pauseTask(gid)
          await expect
            .poll(async () => (await engine!.rpc.tellStatus(gid)).status)
            .toBe('paused')
          await engine.adapter.removeTask(blocker)
          expect(requests()).toEqual([])
          await engine.close()
          stage = 'restart'
          engine = await start(directory)
          expect((await engine.rpc.getOption(gid))['bt-prioritize-piece']).toBe(
            'head=10485760,tail=10485760'
          )
          expect((await engine.rpc.tellStatus(gid)).gid).toBe(gid)
          stage = 'resume'
          await engine.adapter.resumeTask(gid)
          await expect
            .poll(() => requests().length, {
              // Large v2 fixtures restore leaf-hash batches before payload dispatch.
              timeout: 30000,
              interval: 20,
            })
            .toBeGreaterThanOrEqual(32)
          const first = requests().slice(0, 32)
          expect(
            first.every(
              (piece) =>
                piece * pieceLength < 10 * MIB ||
                (piece + 1) * pieceLength > payload.length - 10 * MIB
            )
          ).toBe(true)
          await engine.adapter.pauseTask(gid)
        } catch (error) {
          throw new Error(
            `${format} preview failed at ${stage}: ${String(error)}; hash requests: ${JSON.stringify(v2?.hashRequests.slice(-6))}; diagnostics: ${engine?.diagnostics()}`,
            { cause: error }
          )
        } finally {
          await engine?.close()
          tracker.closeAllConnections()
          await new Promise<void>((resolve) => tracker.close(() => resolve()))
          await v2?.close()
          await v1?.close()
          await rm(directory, { recursive: true, force: true })
        }
      },
      45000
    )

    it('persists preview options on ordinary paused torrent creation', async () => {
      const directory = await mkdtemp(
        path.join(tmpdir(), 'motrix-preview-add-')
      )
      let engine: Awaited<ReturnType<typeof start>> | undefined
      try {
        engine = await start(directory)
        const info = encode({
          name: 'clip.mkv',
          length: 16384,
          'piece length': 16384,
          pieces: createHash('sha1').update(Buffer.alloc(16384)).digest(),
        })
        const gid = await engine.adapter.addTorrent({
          metadata: encode({ info: decode(info).value }),
          saveDir: directory,
          pause: true,
          prioritizePreviewPieces: true,
        })
        expect((await engine.rpc.getOption(gid))['bt-prioritize-piece']).toBe(
          'head=10485760,tail=10485760'
        )
        await engine.close()
        engine = await start(directory)
        expect((await engine.rpc.tellStatus(gid)).status).toBe('paused')
        expect((await engine.rpc.getOption(gid))['bt-prioritize-piece']).toBe(
          'head=10485760,tail=10485760'
        )
      } finally {
        await engine?.close()
        await rm(directory, { recursive: true, force: true })
      }
    })
  }
)
