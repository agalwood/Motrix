import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { RegistryPluginDTO } from '@shared/schemas/registry'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  assertAllowlistedPackageUrl,
  downloadRegistryMoext,
  fetchVerifiedPackageBytes,
  MAX_REGISTRY_PACKAGE_BYTES,
} from './registry-fetcher'

const BYTES = Buffer.from('fake-moext-bytes')
const SHA = createHash('sha256').update(BYTES).digest('hex')

function entry(
  over: Partial<NonNullable<RegistryPluginDTO['package']>> = {}
): RegistryPluginDTO {
  return {
    id: 'acme.speed-boost',
    listing: {
      defaultLocale: 'en-US',
      localizations: {
        'en-US': { name: 'Speed Boost', description: 'Boosts speed' },
      },
    },
    version: '1.0.0',
    author: { name: 'Acme' },
    origin: 'community',
    categories: ['network'],
    engines: { motrix: '^2.0.0' },
    permissions: [],
    optionalPermissions: [],
    hostPermissions: [],
    screenshots: [],
    updatedAt: '2026-07-01',
    featured: false,
    compatible: true,
    package: {
      url: 'https://github.com/acme/speed-boost/releases/download/v1.0.0/x.moext',
      sha256: SHA,
      size: BYTES.byteLength,
      ...over,
    },
  }
}

function responseFetch(response: Response): typeof fetch {
  return vi.fn(async () => response) as unknown as typeof fetch
}

function fakeFetch(
  body: Buffer,
  status = 200,
  headers?: HeadersInit
): typeof fetch {
  return responseFetch(new Response(Uint8Array.from(body), { status, headers }))
}

describe('assertAllowlistedPackageUrl', () => {
  it('accepts https github.com and dl.motrix.app', () => {
    expect(() =>
      assertAllowlistedPackageUrl('https://github.com/a/b/releases/x.moext')
    ).not.toThrow()
    expect(() =>
      assertAllowlistedPackageUrl('https://dl.motrix.app/p/x.moext')
    ).not.toThrow()
  })

  it('rejects http, other hosts, and garbage', () => {
    for (const bad of [
      'http://github.com/a.moext',
      'https://evil.example.com/a.moext',
      'not a url',
    ]) {
      expect(() => assertAllowlistedPackageUrl(bad)).toThrowError(
        /registry_url_not_allowlisted/
      )
    }
  })
})

describe('downloadRegistryMoext', () => {
  let dir: string
  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'reg-fetch-'))
  })
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('writes the file when size and sha256 match', async () => {
    const dest = path.join(dir, 'ok.moext')
    await downloadRegistryMoext(entry(), dest, fakeFetch(BYTES))
    expect(await readFile(dest)).toEqual(BYTES)
  })

  it('rejects an entry without a package pointer', async () => {
    const e = { ...entry(), package: undefined }
    await expect(
      downloadRegistryMoext(e, path.join(dir, 'x.moext'), fakeFetch(BYTES))
    ).rejects.toThrowError(/registry_no_package/)
  })

  it('rejects a size mismatch and writes nothing', async () => {
    const dest = path.join(dir, 'size.moext')
    await expect(
      downloadRegistryMoext(entry({ size: 1 }), dest, fakeFetch(BYTES))
    ).rejects.toThrowError(/registry_size_mismatch/)
    expect(existsSync(dest)).toBe(false)
  })

  it('rejects a sha256 mismatch and writes nothing', async () => {
    const dest = path.join(dir, 'sha.moext')
    await expect(
      downloadRegistryMoext(
        entry({ sha256: 'a'.repeat(64) }),
        dest,
        fakeFetch(BYTES)
      )
    ).rejects.toThrowError(/registry_sha256_mismatch/)
    expect(existsSync(dest)).toBe(false)
  })

  it('rejects a non-200 response', async () => {
    await expect(
      downloadRegistryMoext(
        entry(),
        path.join(dir, 'x.moext'),
        fakeFetch(BYTES, 404)
      )
    ).rejects.toThrowError(/registry_download_failed/)
  })
})

describe('fetchVerifiedPackageBytes', () => {
  it('returns verified bytes when Content-Length is absent', async () => {
    const bytes = await fetchVerifiedPackageBytes(entry(), fakeFetch(BYTES))
    expect(bytes).toEqual(BYTES)
  })

  it('verifies size and sha256 across streamed chunks', async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(BYTES.subarray(0, 4))
        controller.enqueue(BYTES.subarray(4))
        controller.close()
      },
    })

    await expect(
      fetchVerifiedPackageBytes(
        entry(),
        responseFetch(
          new Response(stream, {
            headers: { 'content-length': String(BYTES.byteLength) },
          })
        )
      )
    ).resolves.toEqual(BYTES)
  })

  it('cancels immediately when the stream exceeds the declared size', async () => {
    const cancel = vi.fn()
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(Buffer.concat([BYTES, Buffer.from('!')]))
      },
      cancel,
    })

    await expect(
      fetchVerifiedPackageBytes(entry(), responseFetch(new Response(stream)))
    ).rejects.toThrowError(/registry_size_mismatch/)
    expect(cancel).toHaveBeenCalledOnce()
  })

  it('cancels immediately when the stream exceeds the absolute cap', async () => {
    const cancel = vi.fn()
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(MAX_REGISTRY_PACKAGE_BYTES + 1))
      },
      cancel,
    })

    await expect(
      fetchVerifiedPackageBytes(
        entry({ size: MAX_REGISTRY_PACKAGE_BYTES }),
        responseFetch(new Response(stream))
      )
    ).rejects.toThrowError(/package_too_large/)
    expect(cancel).toHaveBeenCalledOnce()
  })

  it('does not trust a mismatched Content-Length over verified body bytes', async () => {
    await expect(
      fetchVerifiedPackageBytes(
        entry(),
        responseFetch(
          new Response(Uint8Array.from(BYTES), {
            headers: { 'content-length': String(BYTES.byteLength - 1) },
          })
        )
      )
    ).resolves.toEqual(BYTES)
  })

  it('cancels a Content-Length above the absolute cap', async () => {
    const cancel = vi.fn()
    const stream = new ReadableStream<Uint8Array>({ cancel })

    await expect(
      fetchVerifiedPackageBytes(
        entry(),
        responseFetch(
          new Response(stream, {
            headers: {
              'content-length': String(MAX_REGISTRY_PACKAGE_BYTES + 1),
            },
          })
        )
      )
    ).rejects.toThrowError(/package_too_large/)
    expect(cancel).toHaveBeenCalledOnce()
  })

  it('rejects an invalid declared package size before fetching', async () => {
    const fetchImpl = vi.fn()
    await expect(
      fetchVerifiedPackageBytes(
        entry({ size: MAX_REGISTRY_PACKAGE_BYTES + 1 }),
        fetchImpl
      )
    ).rejects.toThrowError(/package_too_large/)
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('rejects an absent response body', async () => {
    await expect(
      fetchVerifiedPackageBytes(
        entry(),
        responseFetch(new Response(null, { status: 200 }))
      )
    ).rejects.toThrowError(/registry_download_failed: empty body/)
  })

  it('wraps response stream errors', async () => {
    const cause = new Error('stream failed')
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.error(cause)
      },
    })

    await expect(
      fetchVerifiedPackageBytes(entry(), responseFetch(new Response(stream)))
    ).rejects.toMatchObject({
      message: 'plugin.install.registry_download_failed: stream error',
      cause,
    })
  })
})
