// @vitest-environment node
import { createHash } from 'node:crypto'
import { once } from 'node:events'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer as createHttpServer } from 'node:http'
import { type AddressInfo, createServer } from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { DEFAULT_ENGINE_SETTINGS } from '@core/settings/validators'
import {
  type Aria2Handle,
  bundledAria2Exists,
  canBindLoopbackTcp,
  connectAdapter,
  spawnAria2ForTest,
} from '@test-utils/aria2'
import Database from 'better-sqlite3'
import { describe, expect, it, vi } from 'vitest'
import { Aria2ConfigBuilder } from './aria2-config-builder'
import { recoverAria2SessionIdentity } from './aria2-session-identity-recovery'

type Encodable = number | string | Uint8Array | { [key: string]: Encodable }
function encode(value: Encodable): Buffer {
  if (typeof value === 'number') return Buffer.from(`i${value}e`)
  if (typeof value === 'string') return encode(Buffer.from(value))
  if (value instanceof Uint8Array)
    return Buffer.concat([Buffer.from(`${value.length}:`), value])
  return Buffer.concat([
    Buffer.from('d'),
    ...Object.keys(value)
      .sort()
      .flatMap((key) => [encode(key), encode(value[key])]),
    Buffer.from('e'),
  ])
}

async function availablePort(): Promise<number> {
  const server = createServer()
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const port = (server.address() as AddressInfo).port
  await new Promise<void>((resolve) => server.close(() => resolve()))
  return port
}

function snapshot(file: string) {
  const db = new Database(file, { readonly: true, fileMustExist: true })
  try {
    return {
      rows: db
        .prepare('SELECT gid, state, serialized FROM task')
        .all() as Array<{ gid: string; state: string; serialized: string }>,
      progress: db
        .prepare('SELECT gid, bitfield FROM task_progress')
        .all() as Array<{ gid: string; bitfield: Buffer }>,
      integrity: db.pragma('integrity_check', { simple: true }),
    }
  } finally {
    db.close()
  }
}

describe.skipIf(!bundledAria2Exists() || !canBindLoopbackTcp())(
  'session recovery with the released aria2 binary',
  () => {
    it.each(['SIGTERM', 'SIGKILL'] as const)(
      'resumes the original payload through two restarts after %s',
      async (signal) => {
        const root = await mkdtemp(
          path.join(tmpdir(), 'motrix-magnet-restart-')
        )
        const seedDir = path.join(root, 'seed')
        const downloadDir = path.join(root, 'downloads')
        await mkdir(seedDir)
        await mkdir(downloadDir)
        const payload = Buffer.alloc(1024 * 1024, 0x61)
        const pieceLength = 16384
        const pieceHash = createHash('sha1')
          .update(payload.subarray(0, pieceLength))
          .digest()
        const info = {
          name: 'payload.bin',
          length: payload.length,
          'piece length': pieceLength,
          pieces: Buffer.concat(
            Array.from(
              { length: payload.length / pieceLength },
              () => pieceHash
            )
          ),
        }
        const infoHash = createHash('sha1').update(encode(info)).digest('hex')
        const seedPort = await availablePort()
        const compactPeer = Buffer.from([
          127,
          0,
          0,
          1,
          seedPort >> 8,
          seedPort & 255,
        ])
        const tracker = createHttpServer((_req, res) => {
          const response = encode({
            interval: 1,
            complete: 1,
            incomplete: 0,
            peers: compactPeer,
          })
          res.writeHead(200, { 'Content-Length': response.length })
          res.end(response)
        })
        tracker.listen(0, '127.0.0.1')
        await once(tracker, 'listening')
        const trackerUrl = `http://127.0.0.1:${(tracker.address() as AddressInfo).port}/announce`
        const torrent = encode({ announce: trackerUrl, info })
        const dbPath = path.join(downloadDir, 'aria2.db')
        const common = [
          '--enable-dht6=false',
          '--bt-enable-lpd=false',
          '--enable-peer-exchange=false',
          '--seed-ratio=0',
          '--bt-exclude-tracker=*',
          `--bt-tracker=${trackerUrl}`,
          '--force-save=true',
        ]
        const args = [
          ...common,
          '--enable-sqlite3-persistence=true',
          `--sqlite3-db-path=${dbPath}`,
          `--save-session=${downloadDir}/aria2.session`,
          '--save-session-interval=1',
          '--auto-save-interval=1',
          '--max-download-limit=64K',
          '--seed-time=0',
          `--listen-port=${await availablePort()}`,
        ]
        let seed: Aria2Handle | undefined
        let download: Aria2Handle | undefined
        let seeder: Awaited<ReturnType<typeof connectAdapter>> | undefined
        let downloader: Awaited<ReturnType<typeof connectAdapter>> | undefined
        try {
          await writeFile(path.join(seedDir, 'payload.bin'), payload)
          seed = await spawnAria2ForTest({
            baseDir: seedDir,
            port: await availablePort(),
            extraArgs: [
              ...common,
              `--listen-port=${seedPort}`,
              '--seed-time=60',
            ],
          })
          seeder = await connectAdapter(seed)
          await seeder.rpc.addTorrent(torrent.toString('base64'), [], {
            'bt-seed-unverified': 'true',
          })
          download = await spawnAria2ForTest({
            baseDir: downloadDir,
            port: await availablePort(),
            extraArgs: args,
          })
          downloader = await connectAdapter(download)
          const metadataGid = await downloader.rpc.addUri([
            `magnet:?xt=urn:btih:${infoHash}&tr=${encodeURIComponent(trackerUrl)}`,
          ])
          let payloadGid = ''
          await vi.waitFor(
            async () => {
              payloadGid =
                (await downloader!.rpc.tellStatus(metadataGid))
                  .followedBy?.[0] ?? ''
              expect(payloadGid).not.toBe('')
            },
            { timeout: 20000, interval: 100 }
          )
          await vi.waitFor(
            async () => {
              expect(
                Number(
                  (await downloader!.rpc.tellStatus(payloadGid)).completedLength
                )
              ).toBeGreaterThanOrEqual(pieceLength)
              expect(
                snapshot(dbPath).progress.some(
                  (row) =>
                    row.gid === payloadGid &&
                    row.bitfield.some((byte) => byte !== 0)
                )
              ).toBe(true)
            },
            { timeout: 20000, interval: 100 }
          )
          if (signal === 'SIGTERM') {
            await downloader.rpc.forcePause(payloadGid)
            await vi.waitFor(async () =>
              expect(
                (await downloader!.rpc.tellStatus(payloadGid)).status
              ).toBe('paused')
            )
          }
          await downloader.rpc.saveSession()
          downloader.disconnect()
          if (signal === 'SIGKILL') {
            const exit = once(download.proc, 'exit')
            download.proc.kill(signal)
            await exit
          } else await download.kill()

          const before = snapshot(dbPath)
          expect(before.integrity).toBe('ok')
          expect(
            before.rows.find((row) => row.gid === payloadGid)?.serialized
          ).toContain(`gid=${metadataGid}`)
          const result = await recoverAria2SessionIdentity(dbPath)
          expect(result?.repairedGids).toEqual([payloadGid])
          expect(result?.retiredMetadataGids).toEqual([metadataGid])
          expect(
            snapshot(dbPath).progress.find((row) => row.gid === payloadGid)
          ).toEqual(before.progress.find((row) => row.gid === payloadGid))

          download = await spawnAria2ForTest({
            baseDir: downloadDir,
            port: await availablePort(),
            extraArgs: args,
          })
          downloader = await connectAdapter(download)
          await vi.waitFor(async () => {
            const task = await downloader!.rpc.tellStatus(payloadGid)
            expect(task.infoHash).toBe(infoHash)
            // Paused local torrents defer file initialization until unpause.
            if (signal === 'SIGKILL')
              expect(task.totalLength).toBe(String(payload.length))
            expect(task.status).toBe(signal === 'SIGTERM' ? 'paused' : 'active')
          })
          const current = [
            ...(await downloader.rpc.tellActive()),
            ...(await downloader.rpc.tellWaiting(0, 100)),
          ]
          expect(current.map((row) => row.gid)).toEqual([payloadGid])
          // A second startup must remain healthy after the unchanged engine saves
          // the repaired local-torrent entry itself.
          if (signal === 'SIGKILL') {
            await downloader.rpc.forcePause(payloadGid)
            await vi.waitFor(async () =>
              expect(
                (await downloader!.rpc.tellStatus(payloadGid)).status
              ).toBe('paused')
            )
          }
          await downloader.rpc.saveSession()
          downloader.disconnect()
          await download.kill()
          expect(await recoverAria2SessionIdentity(dbPath)).toBeNull()
          download = await spawnAria2ForTest({
            baseDir: downloadDir,
            port: await availablePort(),
            extraArgs: args,
          })
          downloader = await connectAdapter(download)
          expect((await downloader.rpc.tellStatus(payloadGid)).status).toBe(
            'paused'
          )
          await downloader.rpc.changeOption(payloadGid, {
            'max-download-limit': '0',
          })
          await downloader.rpc.unpause(payloadGid)
          await vi.waitFor(
            async () => {
              const task = await downloader!.rpc.tellStatus(payloadGid)
              expect(task.completedLength).toBe(String(payload.length))
              expect(task.errorCode ?? '0').toBe('0')
            },
            { timeout: 30000, interval: 100 }
          )
          expect(await readFile(path.join(downloadDir, 'payload.bin'))).toEqual(
            payload
          )
        } finally {
          downloader?.disconnect()
          seeder?.disconnect()
          await download?.kill()
          await seed?.kill()
          tracker.closeAllConnections()
          await new Promise<void>((resolve) => tracker.close(() => resolve()))
          await rm(root, { recursive: true, force: true })
        }
      },
      90000
    )

    it.each([false, true])(
      'clears inherited input-file without requiring a session file (SQLite=%s)',
      async (sqlite3Persistence) => {
        const root = await mkdtemp(path.join(tmpdir(), 'motrix-input-file-'))
        let handle: Aria2Handle | undefined
        try {
          await writeFile(
            path.join(root, 'aria2.conf'),
            `input-file=${root}/missing.session\n`
          )
          const builder = new Aria2ConfigBuilder('unused', root)
          await builder.ensureUserConfig()
          expect(await builder.hasSavedSession()).toBe(false)
          const port = await availablePort()
          const settings = {
            ...DEFAULT_ENGINE_SETTINGS,
            sqlite3Persistence,
            rpcPort: port,
            rpcSecret: 'test_secret',
            dhtEnabled: false,
            listenPort: await availablePort(),
          }
          const args = builder.buildArgs(
            settings,
            true,
            null,
            { download: 0, upload: 0 },
            root,
            false
          )
          expect(args).toContain('--input-file=')
          handle = await spawnAria2ForTest({
            baseDir: root,
            port,
            extraArgs: ['--no-conf=false', ...args],
          })
          const connected = await connectAdapter(handle)
          expect(await connected.rpc.tellActive()).toEqual([])
          connected.disconnect()
        } finally {
          await handle?.kill()
          await rm(root, { recursive: true, force: true })
        }
      }
    )
  }
)
