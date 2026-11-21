import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { encode } from '@motrix/torrent'
import { TaskStatus } from '@shared/types/task'
import { startMetadataPeer } from '@test-utils/metadata-peer'
import { bundled, listen, start } from '@test-utils/taiji'
import Database from 'better-sqlite3'
import { describe, expect, it } from 'vitest'

async function sourceServer(
  payload: Buffer,
  slow = false,
  fastFirstChunk = false,
  delay = 15
) {
  const requests: Array<{ url: string; range?: string }> = []
  const server = createServer((request, response) => {
    requests.push({ url: request.url ?? '', range: request.headers.range })
    const range = /^bytes=(\d+)-(\d*)$/.exec(request.headers.range ?? '')
    const first = range ? Number(range[1]) : 0
    const last = Math.min(
      range?.[2] ? Number(range[2]) : payload.length - 1,
      payload.length - 1
    )
    response.writeHead(range ? 206 : 200, {
      'Content-Length': last - first + 1,
      'Accept-Ranges': 'bytes',
      ETag: '"same-content"',
      ...(range
        ? { 'Content-Range': `bytes ${first}-${last}/${payload.length}` }
        : {}),
    })
    if (request.method === 'HEAD') return response.end()
    if (
      !slow ||
      (fastFirstChunk &&
        range !== null &&
        first === 0 &&
        last < payload.length - 1)
    )
      return response.end(payload.subarray(first, last + 1))
    let cursor = first
    let timer: ReturnType<typeof setTimeout> | undefined
    const send = () => {
      if (response.destroyed) return
      const end = Math.min(cursor + 65536, last + 1)
      response.write(payload.subarray(cursor, end))
      cursor = end
      if (cursor > last) response.end()
      else timer = setTimeout(send, delay)
    }
    response.on('close', () => clearTimeout(timer))
    send()
  })
  const port = await listen(server)
  return {
    base: `http://127.0.0.1:${port}`,
    requests,
    close: async () => {
      server.closeAllConnections()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    },
  }
}

describe.skipIf(!process.env.MOTRIX_TAIJI_BIN && !existsSync(bundled))(
  'native source ledgers',
  () => {
    it('edits HTTP sources with the same GID and resumes retained data after restart', async () => {
      const directory = await mkdtemp(
        path.join(tmpdir(), 'taiji-http-sources-')
      )
      const payload = Buffer.alloc(16 * 1024 * 1024, 37)
      const server = await sourceServer(payload, true, true, 50)
      let engine: Awaited<ReturnType<typeof start>> | undefined
      try {
        engine = await start(directory)
        const a = `${server.base}/old`,
          b = `${server.base}/new`
        const gid = await engine.adapter.createDownload({
          uris: [a],
          saveDir: directory,
          filename: 'payload.bin',
          connections: 2,
          minSplitSize: 1024 * 1024,
          retainRequestContext: true,
        })
        await expect
          .poll(
            async () =>
              (await engine!.adapter.getTaskStatus(gid))!.downloadedBytes,
            { interval: 10, timeout: 8000 }
          )
          .toBeGreaterThanOrEqual(1024 * 1024)
        // Wait for a durable checkpoint, not merely bytes buffered in memory.
        const database = new Database(path.join(directory, 'taiji.sqlite3'), {
          readonly: true,
        })
        try {
          await expect
            .poll(
              () => {
                const row = database
                  .prepare('SELECT total_done FROM http_task WHERE gid = ?')
                  .get(gid) as { total_done: number }
                return row.total_done
              },
              { interval: 50, timeout: 5000 }
            )
            .toBeGreaterThanOrEqual(4 * 1024 * 1024)
        } finally {
          database.close()
        }
        await engine.adapter.pauseTask(gid)
        await expect
          .poll(async () => (await engine!.rpc.tellStatus(gid)).status)
          .toBe('paused')
        await engine.adapter.replaceTaskSources(gid, [a], [b])
        expect(await engine.adapter.getTaskSources(gid)).toEqual([b])
        await engine.close()
        engine = await start(directory)
        expect(await engine.adapter.getTaskSources(gid)).toEqual([b])
        await engine.adapter.resumeTask(gid)
        await expect
          .poll(
            async () => {
              const task = await engine!.adapter.getTaskStatus(gid)
              if (task?.status === TaskStatus.Error)
                throw new Error(JSON.stringify(task))
              return task?.status
            },
            { timeout: 10000 }
          )
          .toBe(TaskStatus.Completed)
        expect(await readFile(path.join(directory, 'payload.bin'))).toEqual(
          payload
        )
        const resumed = server.requests.filter(
          (request) => request.url === '/new' && request.range !== 'bytes=0-0'
        )
        expect(resumed.length).toBeGreaterThan(0)
        expect(
          resumed.every(
            (request) => request.range && !request.range.startsWith('bytes=0-')
          )
        ).toBe(true)
      } finally {
        await engine?.close()
        await server.close()
        await rm(directory, { recursive: true, force: true })
      }
    }, 25000)

    it('reconnects an active HTTP task without replacing its identity', async () => {
      const directory = await mkdtemp(
        path.join(tmpdir(), 'taiji-live-sources-')
      )
      const payload = Buffer.alloc(4 * 1024 * 1024, 49)
      const server = await sourceServer(payload, true)
      let engine: Awaited<ReturnType<typeof start>> | undefined
      try {
        engine = await start(directory)
        const a = `${server.base}/old`,
          b = `${server.base}/new`
        const gid = await engine.adapter.createDownload({
          uris: [a],
          saveDir: directory,
          filename: 'payload.bin',
          connections: 1,
          retainRequestContext: true,
        })
        await expect
          .poll(
            async () =>
              (await engine!.adapter.getTaskStatus(gid))!.downloadedBytes,
            { interval: 10 }
          )
          .toBeGreaterThan(1024 * 1024)
        await engine.adapter.replaceTaskSources(gid, [a], [b])
        await expect
          .poll(
            async () => (await engine!.adapter.getTaskStatus(gid))?.status,
            { timeout: 10000 }
          )
          .toBe(TaskStatus.Completed)
        expect(await readFile(path.join(directory, 'payload.bin'))).toEqual(
          payload
        )
        expect(server.requests.some((request) => request.url === '/new')).toBe(
          true
        )
      } finally {
        await engine?.close()
        await server.close()
        await rm(directory, { recursive: true, force: true })
      }
    }, 20000)

    it('persists BT webseed edits and replays an empty override without restoring metainfo defaults', async () => {
      const directory = await mkdtemp(path.join(tmpdir(), 'taiji-bt-sources-'))
      const payload = Buffer.alloc(16384, 53)
      const server = await sourceServer(payload)
      const info = {
        name: 'payload.bin',
        length: payload.length,
        'piece length': 16384,
        pieces: createHash('sha1').update(payload).digest(),
      }
      const metadata = encode({ info, 'url-list': [`${server.base}/old`] })
      let engine: Awaited<ReturnType<typeof start>> | undefined
      try {
        engine = await start(directory)
        const gid = await engine.adapter.addTorrent({
          metadata,
          saveDir: directory,
          pause: true,
        })
        const before = await engine.adapter.getTorrentMetadata(gid)
        await engine.adapter.replaceTaskSources(
          gid,
          [`${server.base}/old`],
          [`${server.base}/new`]
        )
        expect((await engine.adapter.getTorrentMetadata(gid)).data).toBe(
          before.data
        )
        expect((await engine.adapter.getTaskStatus(gid))!.uris).toEqual([])
        expect((await engine.adapter.getTaskStatus(gid))!.bt?.webSeeds).toEqual(
          [`${server.base}/new`]
        )
        await engine.close()
        engine = await start(directory)
        expect(await engine.adapter.getTaskSources(gid)).toEqual([
          `${server.base}/new`,
        ])
        await engine.adapter.resumeTask(gid)
        await expect
          .poll(
            async () =>
              (
                await readFile(path.join(directory, 'payload.bin')).catch(
                  () => null
                )
              )?.equals(payload),
            { timeout: 15000 }
          )
          .toBe(true)
        expect(server.requests.every((request) => request.url === '/new')).toBe(
          true
        )
        await engine.adapter.pauseTask(gid)
        await expect
          .poll(async () => (await engine!.rpc.tellStatus(gid)).status)
          .toBe('paused')
        await engine.adapter.forceRemoveTask(gid)
        await engine.adapter.removeDownloadResult(gid)
        const replay = await engine.adapter.addTorrent({
          metadata,
          saveDir: path.join(directory, 'replay'),
          pause: true,
          webSeeds: [],
        })
        expect(await engine.adapter.getTaskSources(replay)).toEqual([])
        expect(
          (await engine.adapter.getTorrentMetadata(replay)).manifest.infoHash
        ).toBe(before.manifest.infoHash)
        await engine.close()
        engine = await start(directory)
        expect(await engine.adapter.getTaskSources(replay)).toEqual([])
      } finally {
        await engine?.close()
        await server.close()
        await rm(directory, { recursive: true, force: true })
      }
    }, 25000)

    it('retains magnet ws sources when metadata becomes a torrent', async () => {
      const directory = await mkdtemp(path.join(tmpdir(), 'taiji-magnet-ws-'))
      const payload = Buffer.alloc(16384, 71)
      const info = Buffer.from(
        encode({
          name: 'payload.bin',
          length: payload.length,
          'piece length': 16384,
          pieces: createHash('sha1').update(payload).digest(),
        })
      )
      const peer = await startMetadataPeer(info)
      const tracker = createServer((_request, response) =>
        response.end(
          encode({
            interval: 3600,
            peers: Buffer.from([127, 0, 0, 1, peer.port >> 8, peer.port & 255]),
          })
        )
      )
      const port = await listen(tracker)
      let engine: Awaited<ReturnType<typeof start>> | undefined
      try {
        engine = await start(directory)
        const source = 'http://127.0.0.1:9/seed'
        const gid = await engine.adapter.fetchMagnetMetadata({
          uri: `magnet:?xt=urn:btih:${peer.hash}&tr=${encodeURIComponent(`http://127.0.0.1:${port}/announce`)}&ws=${encodeURIComponent(source)}`,
          saveDir: directory,
        })
        await expect
          .poll(
            async () =>
              (await engine!.adapter.getTorrentMetadata(gid)).awaitingSelection
          )
          .toBe(true)
        await engine.adapter.confirmTorrentSelection(gid, {
          saveDir: directory,
          selectedFiles: [0],
          outputFilePaths: [{ fileIndex: 0, relativePath: 'payload.bin' }],
        })
        expect(await engine.adapter.getTaskSources(gid)).toContain(source)
      } finally {
        await engine?.close()
        await peer.close()
        tracker.closeAllConnections()
        await new Promise<void>((resolve) => tracker.close(() => resolve()))
        await rm(directory, { recursive: true, force: true })
      }
    }, 15000)
  }
)
