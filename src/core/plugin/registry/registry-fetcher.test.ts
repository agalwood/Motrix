import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { RegistryPluginDTO } from '@shared/schemas/registry'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  assertAllowlistedPackageUrl,
  downloadRegistryMoext,
  fetchVerifiedPackageBytes,
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

function fakeFetch(body: Buffer, status = 200): typeof fetch {
  return (async () => ({
    ok: status === 200,
    status,
    arrayBuffer: async () =>
      body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength),
  })) as unknown as typeof fetch
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
  it('fetchVerifiedPackageBytes returns the verified bytes without touching disk', async () => {
    const bytes = await fetchVerifiedPackageBytes(entry(), fakeFetch(BYTES))
    expect(bytes).toEqual(BYTES)
  })
})
