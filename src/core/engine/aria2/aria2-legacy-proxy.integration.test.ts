// @vitest-environment node
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import http from 'node:http'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { LegacyProxyOptions } from '@core/engine/engine-adapter'
import { resolveLegacyProxyOptions } from '@core/legacy-import/proxy-context'
import type { LegacyBtRequestSource } from '@shared/schemas/legacy-bt-request'
import { TaskStatus } from '@shared/types/task'
import {
  bundledAria2Exists,
  canBindLoopbackTcp,
  connectAdapter,
  spawnAria2ForTest,
} from '@test-utils/aria2'
import { afterEach, describe, expect, it } from 'vitest'
import { legacyProxyMatches, legacyProxyOptions } from './aria2-legacy-proxy'

const cleanup: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const dispose of cleanup.splice(0).reverse()) await dispose()
})

async function server(handler: http.RequestListener): Promise<string> {
  const instance = http.createServer(handler)
  await new Promise<void>((resolve) => instance.listen(0, '127.0.0.1', resolve))
  cleanup.push(async () => {
    instance.closeAllConnections()
    await new Promise<void>((resolve) => instance.close(() => resolve()))
  })
  const address = instance.address()
  if (!address || typeof address === 'string') throw new Error('No HTTP port')
  return `http://127.0.0.1:${address.port}`
}

function string(value: string | Buffer) {
  const bytes = Buffer.from(value)
  return Buffer.concat([Buffer.from(`${bytes.length}:`), bytes])
}

function torrent(base: string, payload: Buffer) {
  const info = Buffer.concat([
    Buffer.from(`d6:lengthi${payload.length}e4:name`),
    string('fixture.bin'),
    Buffer.from(`12:piece lengthi${payload.length}e6:pieces`),
    string(createHash('sha1').update(payload).digest()),
    Buffer.from('e'),
  ])
  return {
    infoHash: createHash('sha1').update(info).digest('hex'),
    metadata: Buffer.concat([
      Buffer.from('d8:announce'),
      string(`${base}/announce`),
      Buffer.from('4:info'),
      info,
      Buffer.from('8:url-listl'),
      string(`${base}/fixture.bin`),
      Buffer.from('ee'),
    ]),
  }
}

describe.skipIf(!bundledAria2Exists() || !canBindLoopbackTcp())(
  'legacy BT proxies (real aria2)',
  () => {
    it('matches native normalization of every supported scheme and default port', async () => {
      const baseDir = await mkdtemp(
        path.join(tmpdir(), 'motrix-legacy-proxy-schemes-')
      )
      cleanup.push(() => rm(baseDir, { recursive: true, force: true }))
      const handle = await spawnAria2ForTest({ baseDir })
      cleanup.push(() => handle.kill())
      const wired = await connectAdapter(handle)
      cleanup.push(async () => wired.disconnect())
      for (const [endpoint, expected] of [
        ['https://127.0.0.1:8181/', 'http://127.0.0.1:8181/'],
        ['https://127.0.0.1/', 'http://127.0.0.1:443/'],
        ['https://127.0.0.1:443/', 'http://127.0.0.1:443/'],
        ['https://127.0.0.1:80/', 'http://127.0.0.1/'],
        ['ftp://127.0.0.1/', 'http://127.0.0.1:21/'],
        ['ftp://127.0.0.1:21/', 'http://127.0.0.1:21/'],
        ['ftp://127.0.0.1:80/', 'http://127.0.0.1/'],
        ['ftp://127.0.0.1:8181/', 'http://127.0.0.1:8181/'],
        ['http://127.0.0.1:443/', 'http://127.0.0.1:443/'],
      ]) {
        const context: LegacyProxyOptions = {
          allProxy: endpoint,
          httpProxy: '',
          httpsProxy: '',
          ftpProxy: '',
          noProxy: '',
          proxyMethod: 'get',
        }
        const gid = await wired.rpc.addUri(
          ['magnet:?xt=urn:btih:1111111111111111111111111111111111111111'],
          {
            ...legacyProxyOptions(context),
            'all-proxy': endpoint,
            pause: 'true',
          }
        )
        const options = await wired.rpc.getOption(gid)
        expect(options['all-proxy']).toBe(expected)
        expect(legacyProxyMatches(options, context)).toBe(true)
        expect(
          resolveLegacyProxyOptions({ 'all-proxy': [endpoint] }).allProxy
        ).toBe(expected)
        await wired.adapter.forceRemoveTask(gid)
      }
    })
    it.each([
      ['torrent', 'http'],
      ['torrent', 'https'],
      ['torrent', 'ftp'],
      ['magnet', 'http'],
      ['magnet', 'https'],
      ['magnet', 'ftp'],
    ] as const)(
      'routes %s HTTP requests only through the restored %s proxy endpoint',
      async (kind, scheme) => {
        const baseDir = await mkdtemp(
          path.join(tmpdir(), 'motrix-legacy-proxy-')
        )
        cleanup.push(() => rm(baseDir, { recursive: true, force: true }))
        let originRequests = 0
        let globalRequests = 0
        const direct = await server((_request, response) => {
          originRequests++
          response.writeHead(500).end()
        })
        const wrong = await server((_request, response) => {
          globalRequests++
          response.writeHead(500).end()
        })
        const payload = Buffer.alloc(65536, 97)
        const requests: Array<{ url: string; auth: string | undefined }> = []
        const proxy = await server((request, response) => {
          requests.push({
            url: request.url ?? '',
            auth: request.headers['proxy-authorization'],
          })
          const url = new URL(request.url ?? '/', direct)
          if (url.pathname === '/announce') {
            response.end('d8:intervali60e5:peers0:e')
            return
          }
          if (url.pathname !== '/fixture.bin') {
            response.writeHead(404).end()
            return
          }
          const range = /^bytes=(\d+)-(\d*)$/.exec(request.headers.range ?? '')
          const start = range ? Number(range[1]) : 0
          const end = range?.[2] ? Number(range[2]) : payload.length - 1
          response.writeHead(range ? 206 : 200, {
            'content-length': end - start + 1,
            ...(range
              ? { 'content-range': `bytes ${start}-${end}/${payload.length}` }
              : {}),
          })
          response.end(payload.subarray(start, end + 1))
        })
        const { metadata, infoHash } = torrent(direct, payload)
        const reference: LegacyBtRequestSource = {
          version: 1,
          runId: '12345678-1234-4234-8234-123456789012',
          itemKey: 'gid:1234567890abcdef',
          snapshotDigest: 'a'.repeat(64),
          manifestDigest: 'b'.repeat(64),
          infoHash,
          torrentDigest: createHash('sha256').update(metadata).digest('hex'),
        }
        const context = resolveLegacyProxyOptions({
          'all-proxy': [wrong],
          'http-proxy': [
            proxy.replace('http://', `${scheme}://old%40user:raw%2540secret@`),
          ],
        })
        const handle = await spawnAria2ForTest({
          baseDir,
          extraArgs: [
            `--all-proxy=${wrong}`,
            `--http-proxy=${wrong}`,
            '--http-proxy-user=current-user',
            '--http-proxy-passwd=current-secret',
            '--no-proxy=127.0.0.1',
            '--seed-time=0',
            '--bt-enable-lpd=false',
            '--enable-dht6=false',
          ],
        })
        cleanup.push(() => handle.kill())
        const wired = await connectAdapter(handle)
        cleanup.push(async () => wired.disconnect())
        wired.adapter.setLegacyBtRequestResolver(async (_source, hash) => {
          expect(hash).toBe(infoHash)
          return context
        })
        const gid =
          kind === 'torrent'
            ? await wired.adapter.addTorrent({
                metadata,
                saveDir: baseDir,
                legacyBtRequestSource: reference,
              })
            : await wired.adapter.createDownload({
                uris: [
                  `magnet:?xt=urn:btih:${infoHash}&tr=${encodeURIComponent(`${direct}/announce`)}`,
                ],
                saveDir: baseDir,
                legacyBtRequestSource: reference,
              })
        await expect
          .poll(
            () =>
              requests.some((request) =>
                request.url.startsWith(`${direct}/announce`)
              ),
            { timeout: 10000 }
          )
          .toBe(true)
        if (kind === 'torrent') {
          await expect
            .poll(
              async () => (await wired.adapter.getTaskStatus(gid))?.status,
              { timeout: 15000 }
            )
            .toBe(TaskStatus.Completed)
          expect(await readFile(path.join(baseDir, 'fixture.bin'))).toEqual(
            payload
          )
          expect(
            requests.some((request) => request.url === `${direct}/fixture.bin`)
          ).toBe(true)
        }
        expect(
          legacyProxyMatches(await wired.rpc.getOption(gid), context)
        ).toBe(true)
        expect(
          requests.every(
            (request) =>
              request.auth ===
              `Basic ${Buffer.from('old@user:raw%40secret').toString('base64')}`
          )
        ).toBe(true)
        expect(originRequests).toBe(0)
        expect(globalRequests).toBe(0)
      },
      30000
    )
  }
)
