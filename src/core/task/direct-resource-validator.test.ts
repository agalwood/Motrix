import {
  INCOMPLETE_SUFFIX,
  MAX_DEDUP_ATTEMPTS,
} from '@shared/constants/incomplete'
import { EnvHttpProxyAgent, Socks5ProxyAgent } from 'undici'
import { describe, expect, it, vi } from 'vitest'
import {
  DirectResourceValidatorService,
  sanitizeRemoteFilename,
} from './direct-resource-validator'

function fetchSequence(...responses: Response[]) {
  return vi.fn(
    async (_input: string | URL | Request, _init?: unknown) =>
      responses.shift() as Response
  )
}

describe('DirectResourceValidatorService', () => {
  it('distinguishes redirected source URLs whose path tokens both end in stable', async () => {
    const serviceFor = (filename: string) =>
      new DirectResourceValidatorService(
        fetchSequence(
          new Response(null, {
            status: 302,
            headers: { Location: '/artifact' },
          }),
          new Response(null, {
            status: 200,
            headers: {
              'Content-Disposition': `attachment; filename="${filename}"`,
            },
          })
        ),
        100
      )

    await expect(
      Promise.all([
        serviceFor('VSCodeUserSetup-x64-1.103.2.exe').probe(
          'https://update.example/windows/stable'
        ),
        serviceFor('VSCode-darwin-universal-1.103.2.zip').probe(
          'https://update.example/darwin/stable'
        ),
      ])
    ).resolves.toEqual([
      { filename: 'VSCodeUserSetup-x64-1.103.2.exe', validator: null },
      { filename: 'VSCode-darwin-universal-1.103.2.zip', validator: null },
    ])
  })

  it('resolves a redirected Content-Disposition filename without leaking headers cross-origin', async () => {
    const fetchImpl = fetchSequence(
      new Response(null, {
        status: 302,
        headers: {
          Location:
            'https://cdn.example/download/VSCodeUserSetup-x64-1.103.2.exe',
        },
      }),
      new Response(null, {
        status: 200,
        headers: {
          'Content-Disposition':
            "attachment; filename*=UTF-8''..%2F..%2FVSCodeUserSetup-x64-1.103.2.exe",
          'Content-Type': 'application/vnd.microsoft.portable-executable',
        },
      })
    )
    const dispatcher = { close: vi.fn(async () => undefined) }
    const makeDispatcher = vi.fn(async () => dispatcher)
    const service = new DirectResourceValidatorService(
      fetchImpl,
      100,
      Date.now,
      makeDispatcher
    )

    await expect(
      service.probe('https://update.example/latest/win32-x64-user/stable', {
        headers: {
          Authorization: 'Bearer secret',
          'X-Api-Key': 'also-secret',
          'User-Agent': 'Motrix test',
        },
        proxy: 'http://proxy.example:8080',
        noProxy: 'localhost,*.internal',
      })
    ).resolves.toEqual({
      filename: 'VSCodeUserSetup-x64-1.103.2.exe',
      validator: null,
    })

    expect(makeDispatcher).toHaveBeenCalledWith({
      proxy: 'http://proxy.example:8080',
      noProxy: 'localhost,*.internal',
    })
    expect(fetchImpl).toHaveBeenCalledTimes(2)
    expect(String(fetchImpl.mock.calls[0]?.[0])).toBe(
      'https://update.example/latest/win32-x64-user/stable'
    )
    expect(fetchImpl.mock.calls[0]?.[1]).toEqual(
      expect.objectContaining({
        method: 'HEAD',
        headers: {
          'accept-encoding': 'identity',
          authorization: 'Bearer secret',
          'user-agent': 'Motrix test',
          'x-api-key': 'also-secret',
        },
        redirect: 'manual',
        dispatcher,
      })
    )
    expect(fetchImpl.mock.calls[1]?.[1]).toEqual(
      expect.objectContaining({
        headers: {
          'accept-encoding': 'identity',
          'user-agent': 'Motrix test',
        },
      })
    )
    expect(dispatcher.close).toHaveBeenCalledOnce()
  })

  it('falls back to a body-cancelled Range GET and applies Content-Type extension', async () => {
    const ranged = new Response(Uint8Array.of(1), {
      status: 206,
      headers: {
        'Content-Range': 'bytes 0-0/1024',
        'Content-Type': 'application/vnd.microsoft.portable-executable',
      },
    })
    const cancel = vi.spyOn(ranged.body as ReadableStream, 'cancel')
    const fetchImpl = fetchSequence(new Response(null, { status: 405 }), ranged)
    const service = new DirectResourceValidatorService(fetchImpl, 100)

    await expect(
      service.probe('https://update.example/latest/win32-x64-user/stable')
    ).resolves.toEqual({ filename: 'stable.exe', validator: null })

    expect(fetchImpl.mock.calls[1]?.[1]).toEqual(
      expect.objectContaining({
        method: 'GET',
        headers: {
          'accept-encoding': 'identity',
          range: 'bytes=0-0',
        },
      })
    )
    expect(cancel).toHaveBeenCalledOnce()
  })

  it('returns filename and validator from the same successful HEAD', async () => {
    const fetchImpl = fetchSequence(
      new Response(null, {
        status: 200,
        headers: {
          'Content-Disposition': 'attachment; filename="release.zip"',
          ETag: '"release-v1"',
          'Content-Length': '4096',
        },
      })
    )
    const service = new DirectResourceValidatorService(fetchImpl, 100, () => 7)

    await expect(
      service.probe('https://example.com/download.php')
    ).resolves.toEqual({
      filename: 'release.zip',
      validator: {
        kind: 'strong-etag',
        value: '"release-v1"',
        contentLength: 4096,
        capturedAt: 7,
      },
    })
    expect(fetchImpl).toHaveBeenCalledOnce()
  })

  it('does not bypass a proxy that cannot be represented', async () => {
    const fetchImpl = vi.fn()
    const makeDispatcher = vi.fn(async () => {
      throw new Error('unsupported proxy')
    })
    const service = new DirectResourceValidatorService(
      fetchImpl,
      100,
      Date.now,
      makeDispatcher
    )

    await expect(
      service.probe('https://example.com/stable', {
        proxy: 'socks5://proxy.example:1080',
      })
    ).resolves.toBeNull()
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('uses EnvHttpProxyAgent for HTTP proxy+bypass and Socks5ProxyAgent for SOCKS5', async () => {
    const response = () =>
      new Response(null, {
        status: 200,
        headers: {
          'Content-Disposition': 'attachment; filename="release.zip"',
        },
      })
    const httpFetch = fetchSequence(response())
    const socksFetch = fetchSequence(response())

    await new DirectResourceValidatorService(httpFetch, 100).probe(
      'https://example.com/download.php',
      {
        proxy: 'http://proxy.example:8080',
        noProxy: 'localhost,*.internal',
      }
    )
    await new DirectResourceValidatorService(socksFetch, 100).probe(
      'https://example.com/download.php',
      { proxy: 'socks5://proxy.example:1080' }
    )

    const httpInit = httpFetch.mock.calls[0]?.[1] as
      | { dispatcher?: unknown }
      | undefined
    const socksInit = socksFetch.mock.calls[0]?.[1] as
      | { dispatcher?: unknown }
      | undefined
    expect(httpInit?.dispatcher).toBeInstanceOf(EnvHttpProxyAgent)
    expect(socksInit?.dispatcher).toBeInstanceOf(Socks5ProxyAgent)
  })

  it('declines SOCKS5 metadata probing when a bypass list cannot be represented', async () => {
    const fetchImpl = vi.fn()
    const service = new DirectResourceValidatorService(fetchImpl, 100)

    await expect(
      service.probe('https://example.com/download.php', {
        proxy: 'socks5://proxy.example:1080',
        noProxy: 'localhost',
      })
    ).resolves.toBeNull()
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('captures a strong ETag and content length with HEAD', async () => {
    const fetchImpl = fetchSequence(
      new Response(null, {
        status: 200,
        headers: { ETag: '"release-v1"', 'Content-Length': '4096' },
      })
    )
    const service = new DirectResourceValidatorService(fetchImpl, 100, () => 7)

    await expect(service.capture('https://example.com/file')).resolves.toEqual({
      kind: 'strong-etag',
      value: '"release-v1"',
      contentLength: 4096,
      capturedAt: 7,
    })
    expect(fetchImpl).toHaveBeenCalledWith(
      expect.objectContaining({
        href: 'https://example.com/file',
      }),
      expect.objectContaining({
        method: 'HEAD',
        headers: { 'accept-encoding': 'identity' },
        redirect: 'manual',
      })
    )
  })

  it('falls back to Last-Modified only when content length is known', async () => {
    const fetchImpl = fetchSequence(
      new Response(null, {
        status: 200,
        headers: {
          'Last-Modified': 'Tue, 25 Aug 2026 08:00:00 GMT',
          'Content-Length': '12',
        },
      })
    )
    const service = new DirectResourceValidatorService(fetchImpl, 100, () => 8)

    await expect(service.capture('https://example.com/file')).resolves.toEqual({
      kind: 'last-modified',
      value: 'Tue, 25 Aug 2026 08:00:00 GMT',
      contentLength: 12,
      capturedAt: 8,
    })
  })

  it('accepts a matching validator only with a 206 range response', async () => {
    const fetchImpl = fetchSequence(
      new Response(Uint8Array.of(1), {
        status: 206,
        headers: {
          ETag: '"release-v1"',
          'Content-Length': '1',
          'Content-Range': 'bytes 0-0/4096',
        },
      })
    )
    const service = new DirectResourceValidatorService(fetchImpl)

    await expect(
      service.verify('https://example.com/file', {
        kind: 'strong-etag',
        value: '"release-v1"',
        contentLength: 4096,
        capturedAt: 1,
      })
    ).resolves.toEqual({ outcome: 'unchanged', ifRange: '"release-v1"' })
    expect(fetchImpl).toHaveBeenCalledWith(
      'https://example.com/file',
      expect.objectContaining({
        method: 'GET',
        headers: {
          'Accept-Encoding': 'identity',
          Range: 'bytes=0-0',
          'If-Range': '"release-v1"',
        },
      })
    )
  })

  it('classifies changed ETag or total length as source-changed', async () => {
    const changedTag = new DirectResourceValidatorService(
      fetchSequence(
        new Response(null, {
          status: 200,
          headers: { ETag: '"release-v2"', 'Content-Length': '4096' },
        })
      )
    )
    const changedLength = new DirectResourceValidatorService(
      fetchSequence(
        new Response(Uint8Array.of(1), {
          status: 206,
          headers: {
            ETag: '"release-v1"',
            'Content-Range': 'bytes 0-0/8192',
          },
        })
      )
    )
    const expected = {
      kind: 'strong-etag' as const,
      value: '"release-v1"',
      contentLength: 4096,
      capturedAt: 1,
    }

    await expect(
      changedTag.verify('https://example.com/file', expected)
    ).resolves.toEqual({
      outcome: 'source-changed',
      ifRange: null,
    })
    await expect(
      changedLength.verify('https://example.com/file', expected)
    ).resolves.toEqual({
      outcome: 'source-changed',
      ifRange: null,
    })
  })

  it('distinguishes ignored Range from an unverifiable response', async () => {
    const ignoredRange = new DirectResourceValidatorService(
      fetchSequence(
        new Response(null, {
          status: 200,
          headers: { ETag: '"release-v1"', 'Content-Length': '4096' },
        })
      )
    )
    const noValidator = new DirectResourceValidatorService(
      fetchSequence(new Response(null, { status: 200 }))
    )
    const expected = {
      kind: 'strong-etag' as const,
      value: '"release-v1"',
      contentLength: 4096,
      capturedAt: 1,
    }

    await expect(
      ignoredRange.verify('https://example.com/file', expected)
    ).resolves.toEqual({
      outcome: 'range-unsupported',
      ifRange: null,
    })
    await expect(
      noValidator.verify('https://example.com/file', expected)
    ).resolves.toEqual({
      outcome: 'unverifiable',
      ifRange: null,
    })
  })

  it('does not classify an HTTP error as Range support', async () => {
    const service = new DirectResourceValidatorService(
      fetchSequence(
        new Response(null, {
          status: 503,
          headers: { ETag: '"release-v1"' },
        })
      )
    )

    await expect(
      service.verify('https://example.com/file', {
        kind: 'strong-etag',
        value: '"release-v1"',
        capturedAt: 1,
      })
    ).resolves.toEqual({ outcome: 'unverifiable', ifRange: null })
  })
})

describe('sanitizeRemoteFilename', () => {
  it.each([
    ['Chinese', `${'下载文件'.repeat(80)}.zip`, '.zip'],
    ['emoji', `${'📦🚀'.repeat(80)}.exe`, '.exe'],
  ])(
    'truncates a long %s name by UTF-8 bytes without splitting code points',
    (_label, input, extension) => {
      const sanitized = sanitizeRemoteFilename(input)

      expect(sanitized).not.toBeNull()
      expect(sanitized?.endsWith(extension)).toBe(true)
      const base = sanitized?.slice(0, -extension.length) ?? ''
      const maxDeduped = `${base} (${MAX_DEDUP_ATTEMPTS})${extension}`
      expect(
        Buffer.byteLength(`${maxDeduped}${INCOMPLETE_SUFFIX}`, 'utf8')
      ).toBeLessThanOrEqual(255)
      expect(Buffer.from(sanitized as string, 'utf8').toString('utf8')).toBe(
        sanitized
      )
    }
  )
})
