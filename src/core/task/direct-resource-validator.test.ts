import {
  INCOMPLETE_SUFFIX,
  MAX_DEDUP_ATTEMPTS,
} from '@shared/constants/incomplete'
import { describe, expect, it, vi } from 'vitest'
import {
  canMirrorAria2MetadataHeaders,
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
  it('fails closed only for concrete aria2 reports missing request features', () => {
    const report = (
      features: string[],
      version = '1.37.0-motrix.10',
      hasSqlitePersistence = true
    ) => ({
      version,
      features,
      hasSqlitePersistence,
      hasBtSeedUnverified: false,
      hasBtSaveMetadata: false,
      hasMoveStorage: false,
    })

    expect(
      canMirrorAria2MetadataHeaders(report(['GZip', 'Message Digest']))
    ).toBe(true)
    expect(canMirrorAria2MetadataHeaders(report(['GZip']))).toBe(false)
    expect(canMirrorAria2MetadataHeaders(report(['Message Digest']))).toBe(
      false
    )
    expect(
      canMirrorAria2MetadataHeaders(
        report(['GZip', 'Message Digest'], '1.37.0', false)
      )
    ).toBe(false)
    expect(canMirrorAria2MetadataHeaders(report([], 'unknown', false))).toBe(
      true
    )
  })

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

  it('ignores a non-ASCII legacy filename but accepts RFC 5987 UTF-8', async () => {
    const legacy = new DirectResourceValidatorService(
      fetchSequence(
        new Response(null, {
          headers: {
            'Content-Disposition': 'attachment; filename="résumé.zip"',
          },
        })
      ),
      100
    )
    const extended = new DirectResourceValidatorService(
      fetchSequence(
        new Response(null, {
          headers: {
            'Content-Disposition':
              "attachment; filename*=UTF-8''r%C3%A9sum%C3%A9.zip",
          },
        })
      ),
      100
    )

    await expect(
      legacy.probe('https://downloads.example/fallback.exe')
    ).resolves.toEqual({ filename: 'fallback.exe', validator: null })
    await expect(
      extended.probe('https://downloads.example/fallback.exe')
    ).resolves.toEqual({ filename: 'résumé.zip', validator: null })
  })

  it('fails closed before a cross-origin redirect would strip request headers', async () => {
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
    const close = vi.fn(async () => undefined)
    const makeProxyClient = vi.fn(async () => ({ fetch: fetchImpl, close }))
    const service = new DirectResourceValidatorService(
      fetchImpl,
      100,
      Date.now,
      makeProxyClient
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
    ).resolves.toBeNull()

    expect(makeProxyClient).toHaveBeenCalledWith({
      proxy: 'http://proxy.example:8080',
      noProxy: 'localhost,*.internal',
    })
    expect(fetchImpl).toHaveBeenCalledOnce()
    expect(String(fetchImpl.mock.calls[0]?.[0])).toBe(
      'https://update.example/latest/win32-x64-user/stable'
    )
    expect(fetchImpl.mock.calls[0]?.[1]).toEqual(
      expect.objectContaining({
        method: 'GET',
        headers: {
          accept: '*/*',
          'accept-encoding': 'deflate, gzip',
          authorization: 'Bearer secret',
          cookie: '',
          'user-agent': 'Motrix test',
          'want-digest': 'SHA-512;q=1, SHA-256;q=1, SHA;q=0.1',
          'x-api-key': 'also-secret',
        },
        redirect: 'manual',
      })
    )
    expect(fetchImpl.mock.calls[0]?.[1]).not.toHaveProperty('dispatcher')
    expect(close).toHaveBeenCalledOnce()
  })

  it('follows a cross-origin redirect when every request header is replayable', async () => {
    const fetchImpl = fetchSequence(
      new Response(null, {
        status: 302,
        headers: { Location: 'https://cdn.example/release' },
      }),
      new Response(null, {
        status: 200,
        headers: {
          'Content-Disposition': 'attachment; filename="release.zip"',
        },
      })
    )
    const service = new DirectResourceValidatorService(fetchImpl, 100)

    await expect(
      service.probe('https://downloads.example/latest', {
        headers: { Accept: 'application/octet-stream' },
        userAgent: 'Motrix/2.0',
      })
    ).resolves.toEqual({ filename: 'release.zip', validator: null })

    expect(fetchImpl).toHaveBeenCalledTimes(2)
    expect(fetchImpl.mock.calls[1]?.[1]).toEqual(
      expect.objectContaining({
        headers: {
          accept: 'application/octet-stream',
          'accept-encoding': 'deflate, gzip',
          authorization: '',
          cookie: '',
          'user-agent': 'Motrix/2.0',
          'want-digest': 'SHA-512;q=1, SHA-256;q=1, SHA;q=0.1',
        },
      })
    )
  })

  it('replays sensitive headers across a same-origin redirect', async () => {
    const fetchImpl = fetchSequence(
      new Response(null, {
        status: 302,
        headers: { Location: '/release' },
      }),
      new Response(null, {
        status: 200,
        headers: {
          'Content-Disposition': 'attachment; filename="release.zip"',
        },
      })
    )
    const service = new DirectResourceValidatorService(fetchImpl, 100)

    await expect(
      service.probe('https://downloads.example/latest', {
        headers: { Authorization: 'Bearer secret' },
      })
    ).resolves.toEqual({ filename: 'release.zip', validator: null })

    expect(fetchImpl.mock.calls[1]?.[1]).toEqual(
      expect.objectContaining({
        headers: expect.objectContaining({
          authorization: 'Bearer secret',
        }),
      })
    )
  })

  it('cancels a metadata GET body and applies a Content-Type extension', async () => {
    const response = new Response(Uint8Array.of(1), {
      status: 200,
      headers: {
        'Content-Type': 'application/vnd.microsoft.portable-executable',
      },
    })
    const cancel = vi.spyOn(response.body as ReadableStream, 'cancel')
    const fetchImpl = fetchSequence(response)
    const service = new DirectResourceValidatorService(fetchImpl, 100)

    await expect(
      service.probe('https://update.example/latest/win32-x64-user/stable')
    ).resolves.toEqual({ filename: 'stable.exe', validator: null })

    expect(fetchImpl).toHaveBeenCalledOnce()
    expect(fetchImpl.mock.calls[0]?.[1]).toEqual(
      expect.objectContaining({
        method: 'GET',
        headers: {
          accept: '*/*',
          'accept-encoding': 'deflate, gzip',
          authorization: '',
          cookie: '',
          'want-digest': 'SHA-512;q=1, SHA-256;q=1, SHA;q=0.1',
        },
      })
    )
    expect(cancel).toHaveBeenCalledOnce()
  })

  it('returns filename and validator from the same successful GET', async () => {
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

  it('rejects duplicate ETags merged into one response header', async () => {
    const headers = new Headers({
      'Content-Disposition': 'attachment; filename="release.zip"',
    })
    headers.append('ETag', '"release-v1"')
    headers.append('ETag', '"release-v2"')
    const fetchImpl = fetchSequence(
      new Response(null, { status: 200, headers })
    )
    const service = new DirectResourceValidatorService(fetchImpl, 100, () => 7)

    await expect(
      service.probe('https://example.com/download.php')
    ).resolves.toEqual({ filename: 'release.zip', validator: null })
  })

  it('does not bypass a proxy that cannot be represented', async () => {
    const fetchImpl = vi.fn()
    const makeProxyClient = vi.fn(async () => {
      throw new Error('unsupported proxy')
    })
    const service = new DirectResourceValidatorService(
      fetchImpl,
      100,
      Date.now,
      makeProxyClient
    )

    await expect(
      service.probe('https://example.com/stable', {
        proxy: 'socks5://proxy.example:1080',
      })
    ).resolves.toBeNull()
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('uses a proxy-bound client instead of the direct fetch implementation', async () => {
    const directFetch = vi.fn(async () => {
      throw new Error('direct fetch must not run for a proxied probe')
    })
    const proxyFetch = fetchSequence(
      new Response(null, {
        status: 200,
        headers: {
          'Content-Disposition': 'attachment; filename="release.zip"',
        },
      })
    )
    const close = vi.fn(async () => undefined)
    const makeProxyClient = vi.fn(async () => ({ fetch: proxyFetch, close }))
    const service = new DirectResourceValidatorService(
      directFetch,
      100,
      Date.now,
      makeProxyClient
    )

    await expect(
      service.probe('https://example.com/download.php', {
        proxy: 'http://proxy.example:8080',
        noProxy: 'localhost,*.internal',
      })
    ).resolves.toEqual({ filename: 'release.zip', validator: null })

    expect(makeProxyClient).toHaveBeenCalledWith({
      proxy: 'http://proxy.example:8080',
      noProxy: 'localhost,*.internal',
    })
    expect(directFetch).not.toHaveBeenCalled()
    expect(proxyFetch).toHaveBeenCalledOnce()
    expect(close).toHaveBeenCalledOnce()
  })

  it('captures a strong ETag and content length with GET', async () => {
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
      'https://example.com/file',
      expect.objectContaining({
        method: 'GET',
        headers: {
          accept: '*/*',
          'accept-encoding': 'deflate, gzip',
          authorization: '',
          cookie: '',
          'want-digest': 'SHA-512;q=1, SHA-256;q=1, SHA;q=0.1',
        },
        redirect: 'manual',
      })
    )
  })

  it('uses the effective engine User-Agent unless the task overrides it', async () => {
    const inheritedFetch = fetchSequence(new Response(null, { status: 200 }))
    const overriddenFetch = fetchSequence(new Response(null, { status: 200 }))

    await new DirectResourceValidatorService(inheritedFetch, 100).capture(
      'https://example.com/file',
      { userAgent: 'Motrix/2.0' }
    )
    await new DirectResourceValidatorService(overriddenFetch, 100).capture(
      'https://example.com/file',
      {
        headers: { 'User-Agent': 'Task Agent' },
        userAgent: 'Motrix/2.0',
      }
    )

    expect(inheritedFetch.mock.calls[0]?.[1]).toEqual(
      expect.objectContaining({
        headers: expect.objectContaining({ 'user-agent': 'Motrix/2.0' }),
      })
    )
    expect(overriddenFetch.mock.calls[0]?.[1]).toEqual(
      expect.objectContaining({
        headers: expect.objectContaining({ 'user-agent': 'Task Agent' }),
      })
    )
  })

  it('sends an explicitly empty effective User-Agent', async () => {
    const fetchImpl = fetchSequence(new Response(null, { status: 200 }))

    await new DirectResourceValidatorService(fetchImpl, 100).capture(
      'https://example.com/file',
      { userAgent: '' }
    )

    expect(fetchImpl.mock.calls[0]?.[1]).toEqual(
      expect.objectContaining({
        headers: expect.objectContaining({ 'user-agent': '' }),
      })
    )
  })

  it.each([
    [{ Host: 'other.example' }],
    [{ Authorization: 'one', authorization: 'two' }],
    [{ 'X-Test': 'safe\r\nInjected: yes' }],
  ])(
    'does not request metadata for an unrepresentable header map',
    async (headers) => {
      const fetchImpl = vi.fn()
      const service = new DirectResourceValidatorService(fetchImpl, 100)

      await expect(
        service.probe('https://example.com/file', { headers })
      ).resolves.toBeNull()
      expect(fetchImpl).not.toHaveBeenCalled()
    }
  )

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
      service.verify(
        'https://example.com/file',
        {
          kind: 'strong-etag',
          value: '"release-v1"',
          contentLength: 4096,
          capturedAt: 1,
        },
        { userAgent: 'Motrix/2.0' }
      )
    ).resolves.toEqual({ outcome: 'unchanged', ifRange: '"release-v1"' })
    expect(fetchImpl).toHaveBeenCalledWith(
      'https://example.com/file',
      expect.objectContaining({
        method: 'GET',
        headers: {
          accept: '*/*',
          'accept-encoding': 'deflate, gzip',
          authorization: '',
          cookie: '',
          'user-agent': 'Motrix/2.0',
          'want-digest': 'SHA-512;q=1, SHA-256;q=1, SHA;q=0.1',
          range: 'bytes=0-0',
          'if-range': '"release-v1"',
        },
        redirect: 'manual',
        signal: expect.any(AbortSignal),
      })
    )
  })

  it('verifies through a proxy client and closes it without direct fallback', async () => {
    const directFetch = vi.fn()
    const proxyFetch = fetchSequence(
      new Response(null, {
        status: 206,
        headers: {
          ETag: '"release-v1"',
          'Content-Range': 'bytes 0-0/4096',
        },
      })
    )
    const close = vi.fn(async () => undefined)
    const makeProxyClient = vi.fn(async () => ({ fetch: proxyFetch, close }))
    const service = new DirectResourceValidatorService(
      directFetch,
      100,
      () => 7,
      makeProxyClient
    )

    await expect(
      service.verify(
        'https://example.com/file',
        {
          kind: 'strong-etag',
          value: '"release-v1"',
          contentLength: 4096,
          capturedAt: 1,
        },
        { proxy: 'proxy.example:8080', noProxy: 'localhost' }
      )
    ).resolves.toEqual({ outcome: 'unchanged', ifRange: '"release-v1"' })

    expect(makeProxyClient).toHaveBeenCalledWith({
      proxy: 'proxy.example:8080',
      noProxy: 'localhost',
    })
    expect(directFetch).not.toHaveBeenCalled()
    expect(proxyFetch).toHaveBeenCalledOnce()
    expect(close).toHaveBeenCalledOnce()
  })

  it('fails closed when a verification proxy cannot be represented', async () => {
    const directFetch = vi.fn()
    const makeProxyClient = vi.fn(async () => null)
    const service = new DirectResourceValidatorService(
      directFetch,
      100,
      Date.now,
      makeProxyClient
    )

    await expect(
      service.verify(
        'https://example.com/file',
        {
          kind: 'strong-etag',
          value: '"release-v1"',
          capturedAt: 1,
        },
        { proxy: 'unsupported://proxy.example' }
      )
    ).resolves.toEqual({ outcome: 'unverifiable', ifRange: null })
    expect(directFetch).not.toHaveBeenCalled()
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
