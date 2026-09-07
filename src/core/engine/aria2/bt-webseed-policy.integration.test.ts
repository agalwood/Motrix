// @vitest-environment node

import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, open, rm, stat } from 'node:fs/promises'
import http from 'node:http'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  createBtStoragePlan,
  parseBtFileLayout,
} from '@core/task/bt-storage-layout'
import {
  type Aria2Handle,
  bundledAria2Exists,
  canBindLoopbackTcp,
  connectAdapter,
  spawnAria2ForTest,
} from '@test-utils/aria2'
import { afterEach, describe, expect, it } from 'vitest'
import type { Aria2RawStatus } from './types'

const PIECE_LENGTH = 256 * 1024
const PAYLOAD_LENGTH = 128 * 1024 * 1024
const PAYLOAD_BYTE = 97

function bencodedString(value: string | Buffer): Buffer {
  const bytes = typeof value === 'string' ? Buffer.from(value) : value
  return Buffer.concat([Buffer.from(`${bytes.length}:`), bytes])
}

function createWebSeedTorrent(baseUrl: string): Buffer {
  const pieceHash = createHash('sha1')
    .update(Buffer.alloc(PIECE_LENGTH, PAYLOAD_BYTE))
    .digest()
  const pieces = Buffer.concat(
    Array.from({ length: PAYLOAD_LENGTH / PIECE_LENGTH }, () => pieceHash)
  )
  return Buffer.concat([
    Buffer.from('d8:announce'),
    bencodedString(`${baseUrl}/announce`),
    Buffer.from(`4:infod6:lengthi${PAYLOAD_LENGTH}e4:name`),
    bencodedString('fixture.bin'),
    Buffer.from(`12:piece lengthi${PIECE_LENGTH}e6:pieces`),
    bencodedString(pieces),
    Buffer.from('e8:url-listl'),
    bencodedString(`${baseUrl}/missing-a`),
    bencodedString(`${baseUrl}/missing-b`),
    bencodedString(`${baseUrl}/healthy`),
    Buffer.from('ee'),
  ])
}

describe.skipIf(!bundledAria2Exists() || !canBindLoopbackTcp())(
  'BitTorrent Web Seed failure isolation (real aria2)',
  () => {
    let baseDir: string | undefined
    let handle: Aria2Handle | undefined
    let disconnect: (() => void) | undefined
    let server: http.Server | undefined
    const replyTimers = new Set<ReturnType<typeof setTimeout>>()

    afterEach(async () => {
      disconnect?.()
      await handle?.kill()
      for (const timer of replyTimers) clearTimeout(timer)
      replyTimers.clear()
      if (server) {
        server.closeAllConnections()
        await new Promise<void>((resolve, reject) => {
          server?.close((error) => (error ? reject(error) : resolve()))
        })
      }
      if (baseDir) await rm(baseDir, { recursive: true, force: true })
      baseDir = undefined
      handle = undefined
      disconnect = undefined
      server = undefined
    })

    it.each([false, true])(
      'isolates a failed Web Seed with the BT adapter policy: %s',
      async (useAdapter) => {
        baseDir = await mkdtemp(path.join(tmpdir(), 'motrix-bt-webseed-'))
        let missingResponses = 0
        const healthyReplies: Array<() => void> = []
        let healthyReleased = false
        let releaseScheduled = false
        server = http.createServer((request, response) => {
          if (request.url === '/announce') {
            response.end('d8:intervali60e5:peers0:e')
            return
          }
          if (request.url?.startsWith('/missing')) {
            missingResponses++
            response.writeHead(404, { 'content-length': 0 })
            response.end()
            if (missingResponses >= 10 && !releaseScheduled) {
              releaseScheduled = true
              // Two missing URLs ensure enough concurrent 404s even when
              // aria2 shuffles the Web Seeds. Let it consume the fatal
              // threshold before any healthy source contributes bytes.
              // The raw-RPC control below proves
              // that this fixture still reproduces the original failure.
              replyTimers.add(
                setTimeout(() => {
                  healthyReleased = true
                  for (const reply of healthyReplies.splice(0)) reply()
                }, 500)
              )
            }
            return
          }
          const range = /^bytes=(\d+)-(\d*)$/.exec(request.headers.range ?? '')
          if (request.url !== '/healthy' || !range) {
            response.writeHead(400)
            response.end()
            return
          }
          const start = Number(range[1])
          const end = range[2] ? Number(range[2]) : PAYLOAD_LENGTH - 1
          const reply = () => {
            if (response.destroyed) return
            response.writeHead(206, {
              'content-length': end - start + 1,
              'content-range': `bytes ${start}-${end}/${PAYLOAD_LENGTH}`,
            })
            response.end(Buffer.alloc(end - start + 1, PAYLOAD_BYTE))
          }
          if (healthyReleased) reply()
          else healthyReplies.push(reply)
        })
        await new Promise<void>((resolve, reject) => {
          server?.once('error', reject)
          server?.listen(0, '127.0.0.1', resolve)
        })
        const address = server.address()
        if (!address || typeof address === 'string') {
          throw new Error('Missing fixture server address')
        }
        const baseUrl = `http://127.0.0.1:${address.port}`
        handle = await spawnAria2ForTest({
          baseDir,
          extraArgs: [
            '--max-file-not-found=10',
            '--split=16',
            '--max-connection-per-server=64',
            '--min-split-size=4M',
            '--file-allocation=none',
            '--seed-time=0',
            '--bt-enable-lpd=false',
            '--enable-dht6=false',
            '--all-proxy=',
            '--http-proxy=',
            '--https-proxy=',
            '--no-proxy=*',
            '--enable-sqlite3-persistence=true',
            `--sqlite3-db-path=${path.join(baseDir, 'aria2.db')}`,
          ],
        })
        const wired = await connectAdapter(handle)
        disconnect = wired.disconnect
        const metadata = createWebSeedTorrent(baseUrl)
        const plan = createBtStoragePlan(
          'webseed-policy',
          baseDir,
          await parseBtFileLayout(metadata)
        )
        const saveDir = plan.layout.workspacePath
        await mkdir(saveDir, { recursive: true })
        const gid = useAdapter
          ? await wired.adapter.addTorrent({
              metadata,
              saveDir,
              selectedFiles: [1],
              outputFilePaths: plan.outputFilePaths,
              // A stale task override must not re-enable the fatal policy.
              extraEngineOptions: { 'max-file-not-found': '10' },
            })
          : await wired.rpc.addTorrent(metadata.toString('base64'), [], {
              dir: saveDir,
              'index-out': ['1=p'],
            })

        let terminal: Aria2RawStatus | undefined
        await expect
          .poll(
            async () => {
              terminal = await wired.rpc.tellStatus(gid)
              return terminal.status
            },
            { timeout: 12_000, interval: 100 }
          )
          .toMatch(/^(complete|error)$/)
        expect(missingResponses).toBeGreaterThanOrEqual(10)
        expect((await wired.rpc.getGlobalOption())['max-file-not-found']).toBe(
          '10'
        )

        if (!useAdapter) {
          expect(terminal).toMatchObject({
            status: 'error',
            errorCode: '4',
            errorMessage: 'Reached max-file-not-found count=10',
            completedLength: '0',
          })
          return
        }
        expect(terminal).toMatchObject({
          status: 'complete',
          completedLength: String(PAYLOAD_LENGTH),
          infoHash: (await parseBtFileLayout(metadata)).infoHash,
        })
        const payloadPath = path.join(saveDir, 'p')
        expect((await stat(payloadPath)).size).toBe(PAYLOAD_LENGTH)
        const file = await open(payloadPath, 'r')
        try {
          const prefix = Buffer.alloc(64)
          await file.read(prefix, 0, prefix.length, 0)
          expect(prefix).toEqual(Buffer.alloc(prefix.length, PAYLOAD_BYTE))
        } finally {
          await file.close()
        }

        const httpGid = await wired.adapter.createDownload({
          uris: [`${baseUrl}/missing`],
          saveDir: baseDir,
          pause: true,
        })
        expect((await wired.rpc.getOption(httpGid))['max-file-not-found']).toBe(
          '10'
        )
      },
      20_000
    )
  }
)
