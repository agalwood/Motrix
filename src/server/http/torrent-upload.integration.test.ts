// @vitest-environment node

import { createHash } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { Aria2ConfigBuilder } from '@core/engine/aria2/aria2-config-builder'
import { DEFAULT_ENGINE_SETTINGS } from '@core/settings/validators'
import { TorrentParser } from '@core/torrent/torrent-parser'
import { Commands } from '@shared/protocol/commands'
import { taskCreateRequestSchema } from '@shared/schemas/add-task'
import {
  type Aria2Handle,
  bundledAria2Exists,
  canBindLoopbackTcp,
  connectAdapter,
  spawnAria2ForTest,
} from '@test-utils/aria2'
import type { FastifyInstance } from 'fastify'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { parseTorrentBodyLimit } from '../environment'
import { createApp } from './app'

// A valid BEP 3 torrent with a large comment exercises upload transport
// limits without allocating a large payload file or contacting public peers.
function largeTorrent(commentBytes: number): Buffer {
  return Buffer.concat([
    Buffer.from(`d7:comment${commentBytes}:`),
    Buffer.alloc(commentBytes, 'a'),
    Buffer.from(
      '4:infod6:lengthi1e4:name11:fixture.bin12:piece lengthi16384e6:pieces20:'
    ),
    createHash('sha1').update('x').digest(),
    Buffer.from('7:privatei1eee'),
  ])
}

it.skipIf(!canBindLoopbackTcp())(
  'holds admission until a command finishes after its client disconnects',
  async () => {
    let finish!: () => void
    const pending = new Promise<void>((resolve) => {
      finish = resolve
    })
    const handler = vi.fn(async () => {
      await pending
      return { ok: true }
    })
    const app = await createApp({
      commandHandlers: { [Commands.CreateTask]: handler },
    })
    let clientClosed!: () => void
    const closed = new Promise<void>((resolve) => {
      clientClosed = resolve
    })
    app.server.on('request', (request, response) => {
      if (request.headers['x-test-abort']) response.once('close', clientClosed)
    })
    const address = await app.listen({ port: 0, host: '127.0.0.1' })
    const controller = new AbortController()
    const send = (abort = false) =>
      fetch(
        `${address}/rpc/command/${encodeURIComponent(Commands.CreateTask)}`,
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            ...(abort ? { 'x-test-abort': '1' } : {}),
          },
          signal: abort ? controller.signal : undefined,
          body: JSON.stringify({
            args: [
              {
                type: 'bt',
                payload: {
                  kind: 'torrent-base64',
                  base64: 'A'.repeat(3 * 1024 * 1024),
                },
              },
            ],
          }),
        }
      )
    const first = send(true).catch(() => undefined)
    const second = send()
    try {
      await vi.waitFor(() => expect(handler).toHaveBeenCalledTimes(2))
      controller.abort()
      await closed
      const busy = await send()
      expect(busy.status).toBe(429)
      await busy.arrayBuffer()
      finish()
      const response = await second
      await response.arrayBuffer()
      const accepted = await send()
      expect(accepted.status).toBe(200)
      await accepted.arrayBuffer()
    } finally {
      finish()
      await Promise.allSettled([first, second])
      await app.close()
    }
  }
)

describe.skipIf(!bundledAria2Exists() || !canBindLoopbackTcp())(
  'server torrent upload to real aria2',
  () => {
    let baseDir: string
    let handle: Aria2Handle
    let disconnect: (() => void) | undefined
    let app: FastifyInstance

    afterEach(async () => {
      await app?.close()
      disconnect?.()
      await handle?.kill()
      if (baseDir) await rm(baseDir, { recursive: true, force: true })
    })

    it.each([
      { configured: undefined, rawMiB: 3 },
      { configured: '16', rawMiB: 8 },
    ])(
      'submits a $rawMiB MiB torrent with limit $configured',
      async ({ configured, rawMiB }) => {
        baseDir = await mkdtemp(path.join(tmpdir(), 'motrix-torrent-upload-'))
        const limit = parseTorrentBodyLimit(configured)
        const builder = new Aria2ConfigBuilder('', baseDir, {
          rpcMaxRequestSizeBytes: limit,
        })
        const args = builder.buildArgs(
          DEFAULT_ENGINE_SETTINGS,
          false,
          null,
          { download: 0, upload: 0 },
          baseDir
        )
        handle = await spawnAria2ForTest({
          baseDir,
          extraArgs: [
            '--rpc-max-request-size=2M',
            ...args.filter((arg) => arg.startsWith('--rpc-max-request-size=')),
            '--bt-enable-lpd=false',
            '--enable-dht6=false',
          ],
        })
        const wired = await connectAdapter(handle)
        disconnect = wired.disconnect
        const parser = new TorrentParser()
        app = await createApp({
          torrentBodyLimitBytes: limit,
          commandHandlers: {
            [Commands.CreateTask]: async (input: unknown) => {
              const task = taskCreateRequestSchema.parse(input)
              if (task.type !== 'bt' || task.payload.kind !== 'torrent-base64')
                throw new Error('Expected a torrent')
              const meta = await parser.parse(task.payload.base64)
              const gid = await wired.rpc.addTorrent(task.payload.base64, [], {
                dir: baseDir,
                pause: 'true',
              })
              return { gid, infoHash: meta.infoHash }
            },
          },
        })
        const bytes = largeTorrent(rawMiB * 1024 * 1024)
        const response = await app.inject({
          method: 'POST',
          url: `/rpc/command/${encodeURIComponent(Commands.CreateTask)}`,
          payload: {
            args: [
              {
                type: 'bt',
                payload: {
                  kind: 'torrent-base64',
                  base64: bytes.toString('base64'),
                },
                selectedFiles: [0],
                saveDir: baseDir,
              },
            ],
          },
        })
        expect(response.statusCode).toBe(200)
        const result = response.json<{ gid: string; infoHash: string }>()
        const status = await wired.rpc.tellStatus(result.gid)
        expect(status.infoHash).toBe(result.infoHash)
        expect(status.status).toBe('paused')
      },
      20_000
    )
  }
)
