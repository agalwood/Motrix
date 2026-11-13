import { createHash } from 'node:crypto'
import { createSocket } from 'node:dgram'
import { once } from 'node:events'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { createServer as createHttpServer } from 'node:http'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { encode, parseTorrent } from '@motrix/torrent'
import { startMetadataPeer } from '@test-utils/metadata-peer'
import { bundled, listen, start } from '@test-utils/taiji'
import { describe, expect, it } from 'vitest'

describe.skipIf(!process.env.MOTRIX_TAIJI_BIN && !existsSync(bundled))(
  'native magnet discovery',
  () => {
    it.each([
      'global-before',
      'global-after',
      'task-option',
      'task-after',
    ] as const)(
      'fetches metadata using %s trackers without starting payload download',
      async (mode) => {
        const directory = await mkdtemp(path.join(tmpdir(), 'motrix-magnet-'))
        const info = Buffer.from(
          encode({
            name: 'metadata-fixture.bin',
            length: 16384,
            'piece length': 16384,
            pieces: createHash('sha1').update(Buffer.alloc(16384)).digest(),
          })
        )
        const peer = await startMetadataPeer(info)
        const compact = Buffer.from([127, 0, 0, 1, 0, 0])
        compact.writeUInt16BE(peer.port, 4)
        let announces = 0
        const tracker = createHttpServer((_request, response) => {
          announces++
          response.end(encode({ interval: 3600, peers: compact }))
        })
        const blackhole = createSocket('udp4')
        let engine: Awaited<ReturnType<typeof start>> | undefined
        try {
          const trackerPort = await listen(tracker)
          blackhole.bind(0, '127.0.0.1')
          await once(blackhole, 'listening')
          const url = `http://127.0.0.1:${trackerPort}/announce`
          engine = await start(directory)
          if (mode === 'global-before')
            await engine.rpc.changeGlobalOption({ 'bt-tracker': url })
          if (mode === 'global-after' || mode === 'task-after') {
            await engine.rpc.changeGlobalOption({
              'enable-dht': 'true',
              'dht-entry-point': `127.0.0.1:${blackhole.address().port}`,
            })
          }
          const metadataDirectory = path.join(directory, 'missing', 'metadata')
          const started = Date.now()
          const gid = await engine.rpc.addUri(
            [`magnet:?xt=urn:btih:${peer.hash}`],
            {
              dir: metadataDirectory,
              'bt-metadata-only': 'true',
              'follow-torrent': 'false',
              ...(mode === 'task-option' ? { 'bt-tracker': url } : {}),
            }
          )
          if (mode === 'global-after' || mode === 'task-after') {
            await expect
              .poll(async () => (await engine!.rpc.tellStatus(gid)).status)
              .toBe('active')
            if (mode === 'task-after')
              await engine.rpc.changeOption(gid, { 'bt-tracker': url })
            else await engine.rpc.changeGlobalOption({ 'bt-tracker': url })
          }
          await expect
            .poll(async () => (await engine!.rpc.tellStatus(gid)).status, {
              timeout: 8000,
            })
            .toBe('complete')
          expect(Date.now() - started).toBeLessThan(8000)
          expect(announces).toBeGreaterThan(0)
          expect(peer.requests()).toBeGreaterThan(0)
          const saved = await readFile(
            path.join(metadataDirectory, `${peer.hash}.torrent`)
          )
          expect(parseTorrent(saved).identity).toEqual({
            kind: 'v1',
            sha1: peer.hash,
          })
          expect(
            existsSync(path.join(metadataDirectory, 'metadata-fixture.bin'))
          ).toBe(false)
        } finally {
          await engine?.close()
          blackhole.close()
          tracker.closeAllConnections()
          await new Promise<void>((resolve) => tracker.close(() => resolve()))
          await peer.close()
          await rm(directory, { recursive: true, force: true })
        }
      },
      20000
    )
  }
)
