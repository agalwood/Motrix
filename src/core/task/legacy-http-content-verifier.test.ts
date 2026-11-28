// @vitest-environment node
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { AppError, ErrorCode } from '@shared/errors'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  DirectResourceValidatorService,
  type LegacyHttpContentVerificationInput,
} from './direct-resource-validator'

const URI = 'https://files.example/download?token=private'
const ETAG = '"release-v1"'
const data = new TextEncoder().encode('the old partly downloaded content')
const failure = (key = 'httpVerificationFailed') => ({
  code: ErrorCode.InvalidSelection,
  message: `legacyImport.errors.${key}`,
})

function requestedRange(init?: RequestInit): {
  offset: number
  length: number
} {
  const range = new Headers(init?.headers).get('range') ?? ''
  const match = /^bytes=(\d+)-(\d+)$/.exec(range)
  if (!match) throw new Error('Expected a byte range')
  const offset = Number(match[1])
  return { offset, length: Number(match[2]) - offset + 1 }
}

function rangeResponse(
  bytes: Uint8Array,
  offset: number,
  length: number,
  overrides: Record<string, string> = {},
  body: BodyInit = bytes.slice(offset, offset + length)
) {
  return new Response(body, {
    status: 206,
    headers: {
      ETag: ETAG,
      'Content-Length': String(length),
      'Content-Range': `bytes ${offset}-${offset + length - 1}/${bytes.length}`,
      ...overrides,
    },
  })
}

function input(
  overrides: Partial<LegacyHttpContentVerificationInput> = {}
): LegacyHttpContentVerificationInput {
  return {
    uri: URI,
    totalBytes: data.length,
    ranges: [{ offset: 2, length: 9 }],
    read: vi.fn(async (offset, length) => data.slice(offset, offset + length)),
    ...overrides,
  }
}

function matchingFetch(bytes = data) {
  return vi.fn(async (_uri: string | URL, init?: RequestInit) => {
    const { offset, length } = requestedRange(init)
    return rangeResponse(bytes, offset, length)
  })
}

let server: Server | undefined

afterEach(async () => {
  const current = server
  server = undefined
  if (current?.listening) {
    current.closeAllConnections()
    await new Promise<void>((resolve, reject) => {
      current.close((error) => (error ? reject(error) : resolve()))
    })
  }
})

describe('legacy HTTP completed content verification', () => {
  it('streams every noncontiguous completed range through real HTTP using bounded requests', async () => {
    const chunkBytes = 1024 * 1024
    const bytes = Uint8Array.from(
      { length: chunkBytes + 128 },
      (_, index) => index % 251
    )
    const requests: { range: string; ifMatch?: string; encoding?: string }[] =
      []
    server = createServer((request, response) => {
      const range = String(request.headers.range)
      const match = /^bytes=(\d+)-(\d+)$/.exec(range)
      if (!match) {
        response.writeHead(400).end()
        return
      }
      const offset = Number(match[1])
      const end = Number(match[2])
      requests.push({
        range,
        ifMatch: request.headers['if-match'],
        encoding: request.headers['accept-encoding'],
      })
      response.writeHead(206, {
        ETag: ETAG,
        'Content-Length': String(end - offset + 1),
        'Content-Range': `bytes ${offset}-${end}/${bytes.length}`,
      })
      response.end(bytes.subarray(offset, end + 1))
    })
    await new Promise<void>((resolve, reject) => {
      server?.once('error', reject)
      server?.listen(0, '127.0.0.1', resolve)
    })
    const read = vi.fn(async (offset: number, length: number) =>
      bytes.slice(offset, offset + length)
    )
    const service = new DirectResourceValidatorService(
      undefined,
      3_000,
      () => 123
    )
    const result = await service.verifyLegacyContent(
      input({
        uri: `http://127.0.0.1:${(server.address() as AddressInfo).port}/file`,
        totalBytes: bytes.length,
        ranges: [
          { offset: 3, length: chunkBytes + 5 },
          { offset: chunkBytes + 50, length: 17 },
        ],
        read,
      })
    )
    expect(result).toEqual({
      validator: {
        kind: 'strong-etag',
        value: ETAG,
        contentLength: bytes.length,
        capturedAt: 123,
      },
      requestHeaders: { 'If-Match': ETAG, 'Accept-Encoding': 'identity' },
    })
    expect(read.mock.calls).toEqual([
      [3, chunkBytes],
      [chunkBytes + 3, 5],
      [chunkBytes + 50, 17],
    ])
    expect(requests).toEqual([
      { range: 'bytes=0-0', encoding: 'identity' },
      {
        range: `bytes=3-${chunkBytes + 2}`,
        ifMatch: ETAG,
        encoding: 'identity',
      },
      {
        range: `bytes=${chunkBytes + 3}-${chunkBytes + 7}`,
        ifMatch: ETAG,
        encoding: 'identity',
      },
      {
        range: `bytes=${chunkBytes + 50}-${chunkBytes + 66}`,
        ifMatch: ETAG,
        encoding: 'identity',
      },
    ])
  })

  it('requires a validated one-byte response even with no completed bytes', async () => {
    const fetch = matchingFetch()
    const read = vi.fn()
    await new DirectResourceValidatorService(fetch).verifyLegacyContent(
      input({ ranges: [], read })
    )
    expect(fetch).toHaveBeenCalledOnce()
    expect(read).not.toHaveBeenCalled()
  })

  it('rejects changed old bytes even when the new ETag and total size are stable', async () => {
    const service = new DirectResourceValidatorService(matchingFetch())
    await expect(
      service.verifyLegacyContent(
        input({ read: async (_offset, length) => new Uint8Array(length) })
      )
    ).rejects.toMatchObject(failure('httpContentChanged'))
  })

  it.each(['"release-v2"', 'precondition-failed'])(
    'rejects a representation changing during comparison: %s',
    async (change) => {
      const fetch = matchingFetch()
      fetch.mockImplementationOnce(async () => rangeResponse(data, 0, 1))
      fetch.mockImplementationOnce(async (_uri, init) => {
        const { offset, length } = requestedRange(init)
        return change === 'precondition-failed'
          ? new Response(null, { status: 412 })
          : rangeResponse(data, offset, length, { ETag: change })
      })
      await expect(
        new DirectResourceValidatorService(fetch).verifyLegacyContent(input())
      ).rejects.toMatchObject(failure('httpContentChanged'))
    }
  )

  it.each(['', 'W/"release-v1"', '"one", "two"'])(
    'requires one strong ETag and rejects %s',
    async (etag) => {
      const response = rangeResponse(data, 0, 1, { ETag: etag })
      if (!etag) response.headers.delete('etag')
      await expect(
        new DirectResourceValidatorService(
          async () => response
        ).verifyLegacyContent(input())
      ).rejects.toMatchObject(failure('httpValidatorRequired'))
    }
  )

  it.each([200, 416])(
    'rejects unavailable byte ranges (%s)',
    async (status) => {
      await expect(
        new DirectResourceValidatorService(
          async () => new Response(null, { status })
        ).verifyLegacyContent(input())
      ).rejects.toMatchObject(failure('httpRangeUnsupported'))
    }
  )

  it.each<Record<string, string>>([
    { 'Content-Range': `bytes 1-1/${data.length}` },
    { 'Content-Range': `bytes 0-1/${data.length}` },
    { 'Content-Range': 'bytes 0-0/*' },
    { 'Content-Range': `bytes 0-0/${data.length}, bytes 1-1/${data.length}` },
    { 'Content-Length': '2' },
    { 'Content-Length': '1, 1' },
    { 'Content-Encoding': 'gzip' },
  ])(
    'rejects malformed or nonidentity response metadata: %j',
    async (headers) => {
      await expect(
        new DirectResourceValidatorService(async () =>
          rangeResponse(data, 0, 1, headers)
        ).verifyLegacyContent(input())
      ).rejects.toMatchObject(failure())
    }
  )

  it('rejects a changed resource length', async () => {
    await expect(
      new DirectResourceValidatorService(async () =>
        rangeResponse(data, 0, 1, {
          'Content-Range': `bytes 0-0/${data.length + 1}`,
        })
      ).verifyLegacyContent(input())
    ).rejects.toMatchObject(failure('httpContentChanged'))
  })

  it.each(['truncated', 'excess'])(
    'rejects %s response bytes despite valid headers',
    async (kind) => {
      const fetch = matchingFetch()
      fetch.mockImplementationOnce(async () => rangeResponse(data, 0, 1))
      fetch.mockImplementationOnce(async (_uri, init) => {
        const { offset, length } = requestedRange(init)
        return rangeResponse(
          data,
          offset,
          length,
          {},
          data.slice(offset, offset + length + (kind === 'excess' ? 1 : -1))
        )
      })
      await expect(
        new DirectResourceValidatorService(fetch).verifyLegacyContent(input())
      ).rejects.toMatchObject(failure())
    }
  )

  it('detects a mismatch at the last byte of a later completed range', async () => {
    const fetch = matchingFetch()
    const ranges = [
      { offset: 0, length: 3 },
      { offset: 28, length: 5 },
    ]
    await expect(
      new DirectResourceValidatorService(fetch).verifyLegacyContent(
        input({
          ranges,
          read: async (offset, length) => {
            const bytes = data.slice(offset, offset + length)
            if (offset === 28) bytes[length - 1] = (bytes[length - 1] ?? 0) ^ 1
            return bytes
          },
        })
      )
    ).rejects.toMatchObject(failure('httpContentChanged'))
    expect(fetch).toHaveBeenCalledTimes(3)
  })

  it('rejects a missing Content-Length and a short local read', async () => {
    const response = rangeResponse(data, 0, 1)
    response.headers.delete('content-length')
    await expect(
      new DirectResourceValidatorService(
        async () => response
      ).verifyLegacyContent(input())
    ).rejects.toMatchObject(failure())
    await expect(
      new DirectResourceValidatorService(matchingFetch()).verifyLegacyContent(
        input({ read: async () => new Uint8Array(0) })
      )
    ).rejects.toMatchObject(failure())
  })

  it('compares fragmented response chunks without depending on network chunk boundaries', async () => {
    const fetch = matchingFetch()
    fetch.mockImplementationOnce(async () => rangeResponse(data, 0, 1))
    fetch.mockImplementationOnce(async (_uri, init) => {
      const { offset, length } = requestedRange(init)
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          for (let index = offset; index < offset + length; index++) {
            controller.enqueue(data.slice(index, index + 1))
          }
          controller.close()
        },
      })
      return rangeResponse(data, offset, length, {}, body)
    })
    await expect(
      new DirectResourceValidatorService(fetch).verifyLegacyContent(input())
    ).resolves.toHaveProperty('validator.value', ETAG)
  })

  it('aborts a stalled body, cancels it and closes its proxy client', async () => {
    const controller = new AbortController()
    const cancel = vi.fn()
    const close = vi.fn(async () => undefined)
    const body = new ReadableStream<Uint8Array>({ cancel })
    const fetch = vi.fn(async () => {
      queueMicrotask(() => controller.abort())
      return rangeResponse(data, 0, 1, {}, body)
    })
    const service = new DirectResourceValidatorService(
      undefined,
      3_000,
      Date.now,
      async () => ({ fetch, close })
    )
    await expect(
      service.verifyLegacyContent(
        input({
          signal: controller.signal,
          options: { proxy: 'http://proxy.example' },
        })
      )
    ).rejects.toMatchObject(failure())
    expect(cancel).toHaveBeenCalledOnce()
    expect(close).toHaveBeenCalledOnce()
  })

  it('bounds an unresponsive request even when the HTTP client ignores its abort signal', async () => {
    const close = vi.fn(async () => undefined)
    const fetch = vi.fn(() => new Promise<Response>(() => {}))
    const service = new DirectResourceValidatorService(
      undefined,
      15,
      Date.now,
      async () => ({ fetch, close })
    )
    await expect(
      service.verifyLegacyContent(
        input({ options: { proxy: 'http://proxy.example' } })
      )
    ).rejects.toMatchObject(failure())
    expect(close).toHaveBeenCalledOnce()
  })

  it('bounds a response that sends headers but never finishes its body', async () => {
    const cancel = vi.fn()
    const service = new DirectResourceValidatorService(
      async () =>
        rangeResponse(
          data,
          0,
          1,
          {},
          new ReadableStream<Uint8Array>({ cancel })
        ),
      15
    )
    await expect(service.verifyLegacyContent(input())).rejects.toMatchObject(
      failure()
    )
    expect(cancel).toHaveBeenCalledOnce()
  })

  it('bounds cancellation even if an invalid response refuses to finish cancelling', async () => {
    const cancel = vi.fn(() => new Promise<void>(() => {}))
    const response = new Response(new ReadableStream<Uint8Array>({ cancel }), {
      status: 200,
    })
    const service = new DirectResourceValidatorService(async () => response, 15)
    await expect(service.verifyLegacyContent(input())).rejects.toMatchObject(
      failure('httpRangeUnsupported')
    )
    expect(cancel).toHaveBeenCalledOnce()
  })

  it('cancels pending local reads without sending another request', async () => {
    const controller = new AbortController()
    const fetch = matchingFetch()
    const read = vi.fn(() => {
      controller.abort()
      return new Promise<Uint8Array>(() => {})
    })
    await expect(
      new DirectResourceValidatorService(fetch).verifyLegacyContent(
        input({
          read,
          signal: controller.signal,
        })
      )
    ).rejects.toMatchObject(failure())
    expect(fetch).toHaveBeenCalledOnce()
  })

  it('does no network or local reads after an already cancelled request', async () => {
    const fetch = matchingFetch()
    const request = input({ signal: AbortSignal.abort() })
    await expect(
      new DirectResourceValidatorService(fetch).verifyLegacyContent(request)
    ).rejects.toMatchObject(failure())
    expect(fetch).not.toHaveBeenCalled()
    expect(request.read).not.toHaveBeenCalled()
  })

  it('retains original credentials on same-origin requests and pins verification controls', async () => {
    const fetch = matchingFetch()
    await new DirectResourceValidatorService(fetch).verifyLegacyContent(
      input({
        options: {
          headers: {
            Authorization: 'Bearer private',
            Cookie: 'session=private',
            Range: 'bytes=99-100',
            'If-Match': '"untrusted"',
            'If-Range': '"untrusted"',
            'Accept-Encoding': 'gzip',
          },
        },
      })
    )
    const headers = new Headers(fetch.mock.calls[1]?.[1]?.headers)
    expect(headers.get('authorization')).toBe('Bearer private')
    expect(headers.get('cookie')).toBe('session=private')
    expect(headers.get('range')).toBe('bytes=2-10')
    expect(headers.get('if-match')).toBe(ETAG)
    expect(headers.get('if-range')).toBeNull()
    expect(headers.get('accept-encoding')).toBe('identity')
  })

  it('does not forward credentials across redirect origins', async () => {
    const fetch = vi.fn(
      async () =>
        new Response(null, {
          status: 302,
          headers: { Location: 'https://elsewhere.example/file' },
        })
    )
    await expect(
      new DirectResourceValidatorService(fetch).verifyLegacyContent(
        input({
          options: { headers: { Authorization: 'Bearer private' } },
        })
      )
    ).rejects.toMatchObject(failure('httpRedirectUnsupported'))
    expect(fetch).toHaveBeenCalledOnce()
  })

  it.each([300, 301, 302, 303, 307, 308])(
    'rejects an initial %s redirect without requesting its target',
    async (status) => {
      const cancel = vi.fn()
      const fetch = vi.fn(
        async (_uri: string | URL) =>
          new Response(new ReadableStream<Uint8Array>({ cancel }), {
            status,
            headers: { Location: 'https://cdn.example/file' },
          })
      )
      await expect(
        new DirectResourceValidatorService(fetch).verifyLegacyContent(input())
      ).rejects.toMatchObject(failure('httpRedirectUnsupported'))
      expect(fetch).toHaveBeenCalledOnce()
      expect(String(fetch.mock.calls[0]?.[0])).toBe(URI)
      expect(cancel).toHaveBeenCalledOnce()
    }
  )

  it('rejects same-origin redirects because ETags are scoped to each resource', async () => {
    const fetch = vi.fn(
      async () =>
        new Response(null, {
          status: 302,
          headers: { Location: '/other-file', ETag: ETAG },
        })
    )
    await expect(
      new DirectResourceValidatorService(fetch).verifyLegacyContent(input())
    ).rejects.toMatchObject(failure('httpRedirectUnsupported'))
    expect(fetch).toHaveBeenCalledOnce()
  })

  it('rejects a later completed-range redirect even when its ETag has not changed', async () => {
    const fetch = matchingFetch()
    fetch.mockImplementationOnce(async () => rangeResponse(data, 0, 1))
    fetch.mockImplementationOnce(async () => rangeResponse(data, 0, 3))
    fetch.mockImplementationOnce(
      async () =>
        new Response(null, {
          status: 307,
          headers: { Location: 'https://cdn.example/other-file', ETag: ETAG },
        })
    )
    await expect(
      new DirectResourceValidatorService(fetch).verifyLegacyContent(
        input({
          ranges: [
            { offset: 0, length: 3 },
            { offset: 28, length: 5 },
          ],
        })
      )
    ).rejects.toMatchObject(failure('httpRedirectUnsupported'))
    expect(fetch).toHaveBeenCalledTimes(3)
    expect(fetch.mock.calls.every(([uri]) => String(uri) === URI)).toBe(true)
    expect(new Headers(fetch.mock.calls[2]?.[1]?.headers).get('if-match')).toBe(
      ETAG
    )
  })

  it('never silently bypasses an unavailable configured proxy', async () => {
    const fetch = matchingFetch()
    const factory = vi.fn(async () => null)
    await expect(
      new DirectResourceValidatorService(
        fetch,
        100,
        Date.now,
        factory
      ).verifyLegacyContent(
        input({
          options: {
            proxy: 'http://user:private@proxy.example',
            noProxy: 'localhost',
          },
        })
      )
    ).rejects.toMatchObject(failure())
    expect(factory).toHaveBeenCalledWith({
      proxy: 'http://user:private@proxy.example',
      noProxy: 'localhost',
    })
    expect(fetch).not.toHaveBeenCalled()
  })

  it('redacts raw network and file errors, including foreign AppErrors', async () => {
    const secret = 'https://private.example/?token=secret Authorization: secret'
    for (const service of [
      new DirectResourceValidatorService(async () => {
        throw new Error(secret)
      }),
      new DirectResourceValidatorService(matchingFetch()),
    ]) {
      const error = await service
        .verifyLegacyContent(
          input({
            read: async () => {
              throw new AppError(ErrorCode.TaskOpenFailed, secret)
            },
          })
        )
        .catch((caught: unknown) => caught)
      expect(error).toMatchObject(failure())
      expect(error).toHaveProperty('cause', undefined)
      expect(String(error)).not.toContain('secret')
    }
  })

  it.each([
    [{ offset: -1, length: 1 }],
    [{ offset: 0, length: data.length + 1 }],
    [{ offset: data.length, length: 1 }],
    [{ offset: 0, length: Number.NaN }],
  ])(
    'rejects invalid completed ranges before requests: %j',
    async (...ranges) => {
      const fetch = matchingFetch()
      await expect(
        new DirectResourceValidatorService(fetch).verifyLegacyContent(
          input({ ranges })
        )
      ).rejects.toMatchObject(failure())
      expect(fetch).not.toHaveBeenCalled()
    }
  )
})
