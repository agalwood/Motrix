// @vitest-environment node

import { PassThrough, Readable } from 'node:stream'
import {
  MAX_TORRENT_BASE64_SIZE,
  MAX_TORRENT_RPC_BODY_LIMIT_BYTES,
} from '@shared/lib/torrent-meta'
import { Commands } from '@shared/protocol/commands'
import { Queries } from '@shared/protocol/queries'
import Fastify, { type FastifyInstance } from 'fastify'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApp, RPC_BODY_LIMIT_BYTES } from './app'
import { registerTorrentCommandRoutes } from './torrent-command-routes'

function torrentBody(base64 = 'YQ==') {
  return {
    args: [
      {
        type: 'bt',
        payload: { kind: 'torrent-base64', base64 },
        selectedFiles: [0],
        saveDir: '/downloads',
      },
    ],
  }
}

const createUrl = `/rpc/command/${encodeURIComponent(Commands.CreateTask)}`
const jsonHeaders = { 'content-type': 'application/json' }

describe('torrent RPC request budgets', () => {
  let app: FastifyInstance
  afterEach(async () => {
    await app?.close()
  })

  it.each([Commands.CreateTask, Commands.AddTorrentTask])(
    'accepts large torrents at the exact %s route, including encoded colons',
    async (channel) => {
      const handler = vi.fn(async () => ({ ok: true }))
      app = await createApp({ commandHandlers: { [channel]: handler } })
      const base64 = 'A'.repeat(3 * 1024 * 1024)
      const payload =
        channel === Commands.CreateTask
          ? torrentBody(base64)
          : { args: [{ base64, selectedFiles: [0], saveDir: '/downloads' }] }
      for (const route of [
        channel,
        encodeURIComponent(channel),
        encodeURIComponent(channel).replace('%3A', '%3a'),
      ]) {
        const res = await app.inject({
          method: 'POST',
          url: `/rpc/command/${route}`,
          payload,
        })
        expect(res.statusCode).toBe(200)
      }
      expect(handler).toHaveBeenCalledTimes(3)
      const res = await app.inject({
        method: 'POST',
        url: `/rpc/command/${channel}Other`,
        payload,
      })
      expect(res.statusCode).toBe(413)
    }
  )

  it('accepts the parser Base64 limit plus its envelope and rejects overflow before dispatch', async () => {
    const handler = vi.fn(async () => ({ ok: true }))
    app = await createApp({
      torrentBodyLimitBytes: MAX_TORRENT_RPC_BODY_LIMIT_BYTES,
      commandHandlers: { [Commands.CreateTask]: handler },
    })
    for (const extra of [0, 4]) {
      const res = await app.inject({
        method: 'POST',
        url: createUrl,
        payload: torrentBody('A'.repeat(MAX_TORRENT_BASE64_SIZE + extra)),
      })
      expect(res.statusCode).toBe(extra === 0 ? 200 : 413)
    }
    expect(handler).toHaveBeenCalledOnce()
  })

  it.each([
    { mib: 8, chunked: false },
    { mib: 8, chunked: true },
    { mib: 16, chunked: false },
    { mib: 64, chunked: true },
  ])(
    'enforces the inclusive $mib MiB wire limit (chunked: $chunked)',
    async ({ mib, chunked }) => {
      // Padding exercises the whole wire budget independently of the 50 MiB
      // Base64 constraint. Stream chunks keep the unknown-length path covered.
      const handler = vi.fn(async () => ({ ok: true }))
      app = await createApp({
        torrentBodyLimitBytes: mib === 8 ? undefined : mib * 1024 * 1024,
        commandHandlers: { [Commands.CreateTask]: handler },
      })
      const json = JSON.stringify(torrentBody())
      for (const extra of [0, 1]) {
        const padding = mib * 1024 * 1024 - Buffer.byteLength(json) + extra
        function* chunks() {
          yield json
          for (let left = padding; left > 0; left -= 64 * 1024) {
            yield ' '.repeat(Math.min(left, 64 * 1024))
          }
        }
        const res = await app.inject({
          method: 'POST',
          url: createUrl,
          headers: jsonHeaders,
          payload: chunked
            ? Readable.from(chunks())
            : json + ' '.repeat(padding),
        })
        expect(res.statusCode).toBe(extra === 0 ? 200 : 413)
      }
      expect(handler).toHaveBeenCalledOnce()
    }
  )

  it.each([
    { type: 'http', uris: ['https://example.com/file'] },
    { type: 'bt', payload: { kind: 'magnet', uri: 'magnet:?xt=test' } },
  ])(
    'retains 2 MiB for $type requests on CreateTask, counting UTF-8 bytes',
    async (request) => {
      const handler = vi.fn(async () => ({ ok: true }))
      app = await createApp({
        commandHandlers: { [Commands.CreateTask]: handler },
      })
      const payload = JSON.stringify({
        args: [{ ...request, saveDir: '种'.repeat(800_000) }],
      })
      expect(payload.length).toBeLessThan(RPC_BODY_LIMIT_BYTES)
      const res = await app.inject({
        method: 'POST',
        url: createUrl,
        headers: jsonHeaders,
        payload: Readable.from([payload]),
      })
      expect(res.statusCode).toBe(413)
      expect(handler).not.toHaveBeenCalled()
    }
  )

  it('counts whitespace in ordinary CreateTask requests with no Content-Length', async () => {
    app = await createApp({
      commandHandlers: { [Commands.CreateTask]: async () => ({ ok: true }) },
    })
    const json = JSON.stringify({ args: [{ type: 'http' }] })
    for (const extra of [0, 1]) {
      const res = await app.inject({
        method: 'POST',
        url: createUrl,
        headers: jsonHeaders,
        payload: Readable.from([
          json,
          ' '.repeat(RPC_BODY_LIMIT_BYTES - json.length + extra),
        ]),
      })
      expect(res.statusCode).toBe(extra === 0 ? 200 : 413)
    }
  })

  it('keeps generic commands, queries and bridge calls at 2 MiB', async () => {
    app = await createApp()
    for (const url of [
      `/rpc/command/${Commands.UpdateSettings}`,
      `/rpc/query/${Queries.ListTasks}`,
      '/rpc/command/bridge:submit',
    ]) {
      const res = await app.inject({
        method: 'POST',
        url,
        payload: torrentBody('A'.repeat(RPC_BODY_LIMIT_BYTES)),
      })
      expect(res.statusCode).toBe(413)
    }
  })

  it('checks operator authentication before reading a large torrent body', async () => {
    const handler = vi.fn(async () => ({ ok: true }))
    app = await createApp({
      commandHandlers: { [Commands.CreateTask]: handler },
      operatorAuth: { operatorToken: 'test-operator' },
    })
    const payload = torrentBody('A'.repeat(3 * 1024 * 1024))
    const denied = await app.inject({ method: 'POST', url: createUrl, payload })
    expect(denied.statusCode).toBe(401)
    const allowed = await app.inject({
      method: 'POST',
      url: createUrl,
      payload,
      headers: { authorization: 'Bearer test-operator' },
    })
    expect(allowed.statusCode).toBe(200)
    expect(handler).toHaveBeenCalledOnce()
  })

  it('bounds large requests across both torrent routes and releases slots after completion', async () => {
    let finish!: () => void
    const pending = new Promise<void>((resolve) => {
      finish = resolve
    })
    const handler = vi.fn(async () => {
      await pending
      return { ok: true }
    })
    app = await createApp({
      commandHandlers: {
        [Commands.CreateTask]: handler,
        [Commands.AddTorrentTask]: handler,
        [Commands.PauseTasks]: async () => ({ ok: true }),
      },
    })
    const payload = torrentBody('A'.repeat(3 * 1024 * 1024))
    const first = app
      .inject({ method: 'POST', url: createUrl, payload })
      .then((res) => res)
    const second = app
      .inject({
        method: 'POST',
        url: `/rpc/command/${Commands.AddTorrentTask}`,
        payload: { args: [{ base64: 'A'.repeat(3 * 1024 * 1024) }] },
      })
      .then((res) => res)
    try {
      await vi.waitFor(() => expect(handler).toHaveBeenCalledTimes(2))
      const busy = await app.inject({ method: 'POST', url: createUrl, payload })
      expect(busy.statusCode).toBe(429)
      const small = await app.inject({
        method: 'POST',
        url: `/rpc/command/${Commands.PauseTasks}`,
        payload: { args: [[]] },
      })
      expect(small.statusCode).toBe(200)
    } finally {
      finish()
      await Promise.all([first, second])
    }
    expect(
      (await app.inject({ method: 'POST', url: createUrl, payload })).statusCode
    ).toBe(200)
  })

  it('releases admission slots when a client aborts before its body finishes', async () => {
    let bodyStarted!: () => void
    app = Fastify({ bodyLimit: RPC_BODY_LIMIT_BYTES })
    app.addHook('preParsing', (_request, _reply, payload, done) => {
      bodyStarted()
      done(null, payload)
    })
    const dispatch = vi.fn(async () => ({ ok: true }))
    await registerTorrentCommandRoutes(app, dispatch, 8 * 1024 * 1024)
    for (let index = 0; index < 3; index++) {
      const started = new Promise<void>((resolve) => {
        bodyStarted = resolve
      })
      const controller = new AbortController()
      const payload = new PassThrough()
      const pending = app
        .inject({
          method: 'POST',
          url: createUrl,
          headers: jsonHeaders,
          payload,
          signal: controller.signal,
        })
        .catch(() => undefined)
      await started
      controller.abort()
      payload.destroy()
      await pending
    }
    expect(dispatch).not.toHaveBeenCalled()
    const res = await app.inject({
      method: 'POST',
      url: createUrl,
      payload: torrentBody('A'.repeat(3 * 1024 * 1024)),
    })
    expect(res.statusCode).toBe(200)
  })

  it('releases unknown-length slots on parse failure, unsupported media, and missing handlers', async () => {
    app = await createApp()
    for (let index = 0; index < 3; index++) {
      for (const [payload, headers, status] of [
        ['{', jsonHeaders, 400],
        ['{}', { 'content-type': 'text/plain' }, 415],
        [JSON.stringify(torrentBody()), jsonHeaders, 404],
      ] as const) {
        const res = await app.inject({
          method: 'POST',
          url: createUrl,
          headers,
          payload: Readable.from([payload]),
        })
        expect(res.statusCode).toBe(status)
      }
    }
  })
})
