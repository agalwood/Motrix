// Issue #2187 through the real engine: an HTTP download interrupted by a
// network drop errors, Motrix evicts it from the engine (removeDownloadResult,
// as shouldEvictFromEngine does), and the retry re-adds it under a NEW gid.
// With sqlite3 persistence there is no <file>.aria2 on disk, so the retry can
// only resume if the engine kept the checkpoint and can say so.

import { createHash, randomBytes } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  type Aria2Handle,
  bundledAria2Exists,
  canBindLoopbackTcp,
  connectAdapter,
  spawnAria2ForTest,
} from '@test-utils/aria2'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  createEngineCheckpointProbe,
  DirectRecoveryPlanner,
} from './direct-recovery-planner'

const SIZE = 8 * 1024 * 1024
const CHUNK = 64 * 1024

describe.skipIf(!bundledAria2Exists() || !canBindLoopbackTcp())(
  'retry after a network drop resumes from the engine checkpoint',
  () => {
    const payload = randomBytes(SIZE)
    const digest = createHash('sha256').update(payload).digest('hex')
    const ranges: string[] = []
    let root: string
    let server: Server | undefined
    let port = 0
    let handle: Aria2Handle
    let wired: Awaited<ReturnType<typeof connectAdapter>>

    // Throttled (~2 MiB/s) so the drop lands mid-download; honors Range.
    function listen(): Promise<void> {
      server = createServer((req, res) => {
        ranges.push(req.headers.range ?? 'none')
        const match = /bytes=(\d+)-/.exec(req.headers.range ?? '')
        const start = match ? Number(match[1]) : 0
        const headers = {
          'Accept-Ranges': 'bytes',
          ETag: '"v1"',
          'Content-Length': String(SIZE - start),
        }
        if (match) {
          res.writeHead(206, {
            ...headers,
            'Content-Range': `bytes ${start}-${SIZE - 1}/${SIZE}`,
          })
        } else {
          res.writeHead(200, headers)
        }
        if (req.method === 'HEAD') return res.end()
        let pos = start
        const tick = setInterval(() => {
          if (pos >= SIZE) {
            clearInterval(tick)
            res.end()
            return
          }
          const chunk = payload.subarray(pos, Math.min(pos + CHUNK, SIZE))
          pos += chunk.length
          res.write(chunk)
        }, 30)
        res.on('close', () => clearInterval(tick))
      })
      return new Promise((resolve) =>
        server?.listen(port, '127.0.0.1', () => {
          const address = server?.address()
          if (address && typeof address !== 'string') port = address.port
          resolve()
        })
      )
    }

    async function drop(): Promise<void> {
      server?.closeAllConnections()
      await new Promise<void>((resolve) => server?.close(() => resolve()))
      server = undefined
    }

    async function until<T>(
      read: () => Promise<T | false>,
      label: string
    ): Promise<T> {
      const deadline = Date.now() + 30_000
      while (Date.now() < deadline) {
        const value = await read()
        if (value !== false) return value
        await new Promise((resolve) => setTimeout(resolve, 100))
      }
      throw new Error(`timed out waiting for ${label}`)
    }

    beforeAll(async () => {
      root = await mkdtemp(path.join(tmpdir(), 'motrix-checkpoint-resume-'))
      await listen()
      handle = await spawnAria2ForTest({
        baseDir: root,
        extraArgs: [
          '--enable-sqlite3-persistence=true',
          `--sqlite3-db-path=${path.join(root, 'aria2.db')}`,
          '--force-save=true',
          '--continue=false',
          '--max-tries=1',
          '--retry-wait=0',
          '--connect-timeout=2',
          '--timeout=2',
          '--split=1',
          '--max-connection-per-server=1',
          '--file-allocation=none',
        ],
      })
      wired = await connectAdapter(handle)
    }, 30_000)

    afterAll(async () => {
      wired?.disconnect()
      await handle?.kill()
      if (server) await drop()
      if (root) await rm(root, { recursive: true, force: true })
    })

    it('keeps, reports and resumes the checkpoint under a new gid', async () => {
      const { adapter, rpc } = wired
      const uri = `http://127.0.0.1:${port}/file.bin`
      const filename = 'file.bin.motrix'
      const diskPath = path.join(root, filename)

      await adapter.createDownload({
        uris: [uri],
        saveDir: root,
        filename,
        gid: 'aaaaaaaaaaaaaaaa',
      })
      await until(async () => {
        const s = await rpc.tellStatus('aaaaaaaaaaaaaaaa', ['completedLength'])
        return Number(s.completedLength) > 2 * 1024 * 1024
      }, 'first 2 MiB')

      await drop()
      const saved = await until(async () => {
        const s = await rpc.tellStatus('aaaaaaaaaaaaaaaa', [
          'status',
          'completedLength',
        ])
        return s.status === 'error' && Number(s.completedLength)
      }, 'error after the drop')
      await adapter.removeDownloadResult('aaaaaaaaaaaaaaaa')

      // The engine still holds the checkpoint and says so; the planner
      // therefore offers a checkpoint resume instead of checkpoint-missing.
      await expect(adapter.getCheckpointStatus(diskPath)).resolves.toBe(
        'present'
      )
      const plan = await new DirectRecoveryPlanner(undefined, undefined, () =>
        createEngineCheckpointProbe(adapter)
      ).plan({
        primary: { diskPath },
        finalPath: path.join(root, 'file.bin'),
      })
      expect(plan).toMatchObject({ kind: 'checkpoint' })

      await listen()
      const resumeFrom = ranges.length
      await adapter.createDownload({
        uris: [uri],
        saveDir: root,
        filename,
        gid: 'bbbbbbbbbbbbbbbb',
        resumePolicy: 'checkpoint',
      })
      await until(async () => {
        const s = await rpc.tellStatus('bbbbbbbbbbbbbbbb', ['status'])
        if (s.status === 'error') throw new Error('retry errored')
        return s.status === 'complete'
      }, 'retry to complete')

      const resumed = ranges
        .slice(resumeFrom)
        .map((range) => /bytes=(\d+)-/.exec(range)?.[1])
        .filter((start): start is string => start !== undefined)
        .map(Number)
      // Resumed from the saved progress, not restarted from byte 0.
      expect(Math.max(...resumed)).toBeGreaterThan(0)
      expect(Math.max(...resumed)).toBeLessThanOrEqual(saved)
      const file = await readFile(diskPath)
      expect(createHash('sha256').update(file).digest('hex')).toBe(digest)
    }, 60_000)
  }
)
