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

  it('preserves a browser Referer through cross-origin filename redirects', async () => {
    const referer = 'https://origin.example/downloads'
    const finalUrl =
      'https://cdn.example/releases/Thunderbird%20Setup%20157.0.exe'
    const fetchImpl = fetchSequence(
      new Response(null, {
        status: 302,
        headers: { Location: 'https://mirror.example/latest' },
      }),
      new Response(null, {
        status: 307,
        headers: { Location: finalUrl },
      }),
      new Response(null, {
        headers: { 'Content-Type': 'application/x-msdos-program' },
      })
    )
    const service = new DirectResourceValidatorService(fetchImpl, 100)

    await expect(
      service.probe('https://download.example/?product=thunderbird', {
        headers: { rEfErEr: referer, 'User-Agent': 'Mozilla/5.0' },
      })
    ).resolves.toEqual({
      filename: 'Thunderbird Setup 157.0.exe',
      validator: null,
    })

    expect(fetchImpl).toHaveBeenCalledTimes(3)
    expect(String(fetchImpl.mock.calls[2]?.[0])).toBe(finalUrl)
    for (const [, init] of fetchImpl.mock.calls) {
      expect(init).toEqual(
        expect.objectContaining({
          method: 'GET',
          redirect: 'manual',
          headers: expect.objectContaining({
            referer,
            'user-agent': 'Mozilla/5.0',
          }),
        })
      )
    }
  })

  it.each([
    ['Authorization', 'Bearer secret'],
    ['Cookie', 'session=secret'],
    ['X-Api-Key', 'secret'],
  ])(
    'still refuses cross-origin %s alongside a browser Referer',
    async (name, value) => {
      const fetchImpl = fetchSequence(
        new Response(null, {
          status: 302,
          headers: { Location: 'https://cdn.example/release.zip' },
        })
      )
      const service = new DirectResourceValidatorService(fetchImpl, 100)

      await expect(
        service.probe('https://download.example/latest', {
          headers: {
            Referer: 'https://origin.example/downloads',
            [name]: value,
          },
        })
      ).resolves.toBeNull()
      expect(fetchImpl).toHaveBeenCalledOnce()
    }
  )

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
          cookie: '',
          'user-agent': 'Motrix/2.0',
          'want-digest': 'SHA-512;q=1, SHA-256;q=1, SHA;q=0.1',
          range: 'bytes=0-0',
        },
        redirect: 'manual',
        signal: expect.any(AbortSignal),
      })
    )
  })

  it.each([
    ['"release-v1"', 4096, 'unchanged'],
    ['"release-v2"', 4096, 'source-changed'],
    ['"release-v1"', 8192, 'source-changed'],
    ['W/"release-v1"', 4096, 'unverifiable'],
    ['', 4096, 'unverifiable'],
  ] as const)(
    'checks redirected metadata (tag %s, length %s)',
    async (etag, length, outcome) => {
      const fetchImpl = fetchSequence(
        new Response(null, {
          status: 302,
          headers: { Location: 'https://cdn.example/file' },
        }),
        new Response(null, {
          status: 200,
          headers: { ETag: '"release-v1"', 'Content-Length': '4096' },
        }),
        new Response(null, {
          status: 302,
          headers: { Location: 'https://cdn.example/file' },
        }),
        new Response(null, {
          status: 206,
          headers: {
            ETag: etag,
            'Content-Range': `bytes 0-0/${length}`,
          },
        })
      )
      const service = new DirectResourceValidatorService(fetchImpl)
      const expected = await service.capture('https://example.com/file')
      expect(expected?.resourceUrlHash).toMatch(/^[a-f0-9]{64}$/)
      if (!expected) throw new Error('missing captured validator')
      await expect(
        service.verify('https://example.com/file', expected)
      ).resolves.toEqual({
        outcome,
        ifRange: outcome === 'unchanged' ? '"release-v1"' : null,
        ...(outcome === 'unverifiable'
          ? { reason: 'validator-missing', httpStatus: 206 }
          : {}),
      })
      expect(fetchImpl).toHaveBeenCalledTimes(4)
      for (const call of fetchImpl.mock.calls.slice(2)) {
        expect(call[1]).toMatchObject({ headers: { range: 'bytes=0-0' } })
        expect((call[1] as RequestInit).headers).not.toHaveProperty('if-range')
      }
    }
  )

  it.each([false, true])(
    'does not infer a legacy cross-origin target from an equal ETag (round trip: %s)',
    async (roundTrip) => {
      const service = new DirectResourceValidatorService(
        fetchSequence(
          new Response(null, {
            status: 302,
            headers: { Location: 'https://cdn.example/file' },
          }),
          ...(roundTrip
            ? [
                new Response(null, {
                  status: 302,
                  headers: { Location: 'https://example.com/different-file' },
                }),
              ]
            : []),
          new Response(null, {
            status: 206,
            headers: {
              ETag: '"release-v1"',
              'Content-Range': 'bytes 0-0/4096',
            },
          })
        )
      )
      await expect(
        service.verify('https://example.com/file', {
          kind: 'strong-etag',
          value: '"release-v1"',
          capturedAt: 1,
          contentLength: 4096,
        })
      ).resolves.toEqual({
        outcome: 'unverifiable',
        ifRange: null,
        reason: 'redirect-identity-unavailable',
        httpStatus: 206,
      })
    }
  )

  it.each(['capture', 'probe'] as const)(
    'binds a cross-origin round trip during %s and rejects a different final target',
    async (operation) => {
      const redirect = (location: string) =>
        new Response(null, { status: 302, headers: { Location: location } })
      const metadata = (status: number) =>
        new Response(null, {
          status,
          headers: {
            ETag: '"release-v1"',
            ...(status === 200
              ? { 'Content-Length': '4096' }
              : { 'Content-Range': 'bytes 0-0/4096' }),
          },
        })
      const fetch = fetchSequence(
        redirect('https://cdn.example/bounce'),
        redirect('https://example.com/original'),
        metadata(200),
        redirect('https://cdn.example/bounce'),
        redirect('https://example.com/original'),
        metadata(206),
        redirect('https://cdn.example/bounce'),
        redirect('https://example.com/different-file'),
        metadata(206)
      )
      const service = new DirectResourceValidatorService(fetch)
      const captured =
        operation === 'capture'
          ? await service.capture('https://example.com/original')
          : (await service.probe('https://example.com/original'))?.validator
      expect(captured?.resourceUrlHash).toMatch(/^[a-f0-9]{64}$/)
      if (!captured) throw new Error('missing captured validator')
      await expect(
        service.verify('https://example.com/original', captured)
      ).resolves.toEqual({ outcome: 'unchanged', ifRange: '"release-v1"' })
      await expect(
        service.verify('https://example.com/original', captured)
      ).resolves.toEqual({ outcome: 'source-changed', ifRange: null })
    }
  )

  it.each(['https://cdn.example/other-file', 'https://other-cdn.example/file'])(
    'rejects a changed redirect target even when its ETag and length collide: %s',
    async (target) => {
      const service = new DirectResourceValidatorService(
        fetchSequence(
          new Response(null, {
            status: 302,
            headers: { Location: 'https://cdn.example/file?secret=token' },
          }),
          new Response(null, {
            status: 200,
            headers: { ETag: '"release-v1"', 'Content-Length': '4096' },
          }),
          new Response(null, { status: 302, headers: { Location: target } }),
          new Response(null, {
            status: 206,
            headers: {
              ETag: '"release-v1"',
              'Content-Range': 'bytes 0-0/4096',
            },
          })
        )
      )
      const captured = await service.capture('https://example.com/file')
      expect(captured?.resourceUrlHash).toMatch(/^[a-f0-9]{64}$/)
      expect(JSON.stringify(captured)).not.toContain('secret')
      expect(JSON.stringify(captured)).not.toContain('token')
      if (!captured) throw new Error('missing captured validator')
      await expect(
        service.verify('https://example.com/file', captured)
      ).resolves.toEqual({ outcome: 'source-changed', ifRange: null })
    }
  )

  it.each([
    '',
    'bytes 0-1/4096',
    'bytes 1-1/4096',
    'bytes 0-0/*',
    'bytes 0-0/0',
    'bytes 0-0/9007199254740992',
  ])('rejects an invalid one-byte range response: %s', async (contentRange) => {
    const service = new DirectResourceValidatorService(
      fetchSequence(
        new Response(null, {
          status: 206,
          headers: {
            ETag: '"release-v1"',
            'Content-Range': contentRange,
            'Content-Length': '1',
          },
        })
      )
    )
    await expect(
      service.verify('https://example.com/file', {
        kind: 'strong-etag',
        value: '"release-v1"',
        capturedAt: 1,
      })
    ).resolves.toEqual({
      outcome: 'unverifiable',
      ifRange: null,
      reason: 'invalid-content-range',
      httpStatus: 206,
    })
  })

  it.each([
    ['ftp://example.com/file', 'invalid-url', {}],
    [
      'https://example.com/file',
      'unsupported-headers',
      { userAgent: 'bad\r\nheader' },
    ],
  ] as const)(
    'declines %s with reason %s before sending a request',
    async (uri, reason, options) => {
      const fetch = vi.fn()
      const service = new DirectResourceValidatorService(fetch)
      await expect(
        service.verify(
          uri,
          { kind: 'strong-etag', value: '"release-v1"', capturedAt: 1 },
          options
        )
      ).resolves.toEqual({
        outcome: 'unverifiable',
        ifRange: null,
        reason,
      })
      expect(fetch).not.toHaveBeenCalled()
    }
  )

  it.each(['Bytes 0-0/4096', 'bytes 00-00/004096'])(
    'accepts equivalent byte-range syntax: %s',
    async (contentRange) => {
      const service = new DirectResourceValidatorService(
        fetchSequence(
          new Response(null, {
            status: 206,
            headers: { ETag: '"release-v1"', 'Content-Range': contentRange },
          })
        )
      )
      await expect(
        service.verify('https://example.com/file', {
          kind: 'strong-etag',
          value: '"release-v1"',
          contentLength: 4096,
          capturedAt: 1,
        })
      ).resolves.toEqual({ outcome: 'unchanged', ifRange: '"release-v1"' })
    }
  )

  it.each([
    ['https://[invalid', 'redirect-url-unsupported', 1],
    ['https://example.com/file', 'redirect-limit', 6],
  ] as const)(
    'reports a declined redirect without disclosing its location: %s',
    async (location, reason, requests) => {
      const fetch = vi.fn(
        async () =>
          new Response(null, { status: 302, headers: { Location: location } })
      )
      const service = new DirectResourceValidatorService(fetch)
      await expect(
        service.verify('https://example.com/file', {
          kind: 'strong-etag',
          value: '"release-v1"',
          capturedAt: 1,
        })
      ).resolves.toEqual({
        outcome: 'unverifiable',
        ifRange: null,
        reason,
        httpStatus: 302,
      })
      expect(fetch).toHaveBeenCalledTimes(requests)
    }
  )

  it.each(['unchanged', 'changed'] as const)(
    'checks the saved Last-Modified when a response adds an ETag (%s)',
    async (state) => {
      const savedDate = 'Tue, 25 Aug 2026 08:00:00 GMT'
      const service = new DirectResourceValidatorService(
        fetchSequence(
          new Response(null, {
            status: 206,
            headers: {
              ETag: '"newly-added-tag"',
              'Last-Modified':
                state === 'unchanged'
                  ? savedDate
                  : 'Wed, 26 Aug 2026 08:00:00 GMT',
              'Content-Range': 'bytes 0-0/4096',
            },
          })
        )
      )
      await expect(
        service.verify('https://example.com/file', {
          kind: 'last-modified',
          value: savedDate,
          contentLength: 4096,
          capturedAt: 1,
        })
      ).resolves.toEqual({
        outcome: state === 'unchanged' ? 'unchanged' : 'source-changed',
        ifRange: state === 'unchanged' ? savedDate : null,
      })
    }
  )

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
    ).resolves.toEqual({
      outcome: 'unverifiable',
      ifRange: null,
      reason: 'http-client-unavailable',
    })
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
      reason: 'validator-missing',
      httpStatus: 200,
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
    ).resolves.toEqual({
      outcome: 'unverifiable',
      ifRange: null,
      reason: 'http-status',
      httpStatus: 503,
    })
  })

  it.each(['probe', 'capture', 'verify'] as const)(
    'uses the appropriate timeout budget for %s',
    async (operation) => {
      vi.useFakeTimers()
      try {
        const fetchImpl = vi.fn(
          () =>
            new Promise<Response>((resolve) => {
              setTimeout(
                () =>
                  resolve(
                    new Response(null, {
                      status: 206,
                      headers: {
                        ETag: '"release-v1"',
                        'Content-Range': 'bytes 0-0/4096',
                      },
                    })
                  ),
                3_500
              )
            })
        )
        const service = new DirectResourceValidatorService(fetchImpl)
        const result =
          operation === 'verify'
            ? service.verify('https://example.com/file', {
                kind: 'strong-etag',
                value: '"release-v1"',
                contentLength: 4096,
                capturedAt: 1,
              })
            : service[operation]('https://example.com/file')

        await vi.advanceTimersByTimeAsync(3_500)

        await expect(result).resolves.toEqual(
          operation === 'verify'
            ? { outcome: 'unchanged', ifRange: '"release-v1"' }
            : null
        )
        expect(vi.getTimerCount()).toBe(0)
      } finally {
        vi.useRealTimers()
      }
    }
  )

  it.each([undefined, 50])(
    'bounds stalled verification and closes its client (override: %s)',
    async (timeoutMs) => {
      vi.useFakeTimers()
      try {
        const close = vi.fn()
        const fetchImpl = vi.fn(() => new Promise<Response>(() => {}))
        const service = new DirectResourceValidatorService(
          undefined,
          timeoutMs,
          Date.now,
          async () => ({ fetch: fetchImpl, close })
        )
        let settled = false
        const result = service
          .verify(
            'https://example.com/file',
            { kind: 'strong-etag', value: '"release-v1"', capturedAt: 1 },
            { proxy: 'http://proxy.example:8080' }
          )
          .then((value) => {
            settled = true
            return value
          })
        await vi.advanceTimersByTimeAsync((timeoutMs ?? 30_000) - 1)
        expect(settled).toBe(false)
        await vi.advanceTimersByTimeAsync(1)
        await expect(result).resolves.toEqual({
          outcome: 'unverifiable',
          ifRange: null,
          reason: 'request-timeout',
        })
        expect(close).toHaveBeenCalledOnce()
        expect(vi.getTimerCount()).toBe(0)
      } finally {
        vi.useRealTimers()
      }
    }
  )

  it('keeps request errors out of verification diagnostics', async () => {
    const service = new DirectResourceValidatorService(
      vi.fn().mockRejectedValue(new Error('https://example.com/?secret=token'))
    )
    await expect(
      service.verify('https://example.com/file', {
        kind: 'strong-etag',
        value: '"release-v1"',
        capturedAt: 1,
      })
    ).resolves.toEqual({
      outcome: 'unverifiable',
      ifRange: null,
      reason: 'request-failed',
    })
  })

  it.each(['ECONNRESET', 'ENOTFOUND', 'UND_ERR_SOCKET', 'private-token'])(
    'reports only allowlisted transport codes: %s',
    async (code) => {
      const service = new DirectResourceValidatorService(
        vi
          .fn()
          .mockRejectedValue(
            new Error('https://example.com/?secret=token', { cause: { code } })
          )
      )
      await expect(
        service.verify('https://example.com/file', {
          kind: 'strong-etag',
          value: '"release-v1"',
          capturedAt: 1,
        })
      ).resolves.toEqual({
        outcome: 'unverifiable',
        ifRange: null,
        reason: 'request-failed',
        ...(code === 'private-token' ? {} : { networkErrorCode: code }),
      })
    }
  )
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
