import { describe, expect, it, vi } from 'vitest'
import { DirectResourceValidatorService } from './direct-resource-validator'

function fetchSequence(...responses: Response[]) {
  return vi.fn(async () => responses.shift() as Response)
}

describe('DirectResourceValidatorService', () => {
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
      'https://example.com/file',
      expect.objectContaining({
        method: 'HEAD',
        headers: { 'Accept-Encoding': 'identity' },
        redirect: 'follow',
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
