import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// mmdb-lib has no Writer in 3.x; we mock the Reader so unit tests don't
// require a real GeoLite2 binary on disk. The integration smoke test is
// covered manually via the dev runner.
const mockGet = vi.fn()
vi.mock('mmdb-lib', () => {
  class Reader {
    get(ip: string): unknown {
      return mockGet(ip)
    }
  }
  return { Reader }
})

import { GeoIPService } from './geo-ip-service'

describe('GeoIPService', () => {
  let tmp: string
  let dbPath: string

  beforeEach(async () => {
    tmp = await mkdtemp(path.join(tmpdir(), 'geoip-svc-'))
    dbPath = path.join(tmp, 'GeoLite2-Country.mmdb')
    mockGet.mockReset()
  })

  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true })
  })

  it('returns false from open() when the file is missing', async () => {
    const svc = new GeoIPService()
    expect(await svc.open(dbPath)).toBe(false)
    expect(svc.isLoaded()).toBe(false)
    expect(svc.lookupCountry('1.2.3.4')).toBeNull()
  })

  it('opens an on-disk file and resolves country lookups', async () => {
    await writeFile(dbPath, Buffer.alloc(64, 0x00))
    mockGet.mockReturnValue({
      country: { iso_code: 'US', names: { en: 'United States' } },
    })
    const svc = new GeoIPService()
    expect(await svc.open(dbPath)).toBe(true)
    expect(svc.isLoaded()).toBe(true)
    expect(svc.lookupCountry('8.8.8.8')).toEqual({
      code: 'US',
      name: 'United States',
    })
  })

  it('returns null when the lookup misses', async () => {
    await writeFile(dbPath, Buffer.alloc(64, 0x00))
    mockGet.mockReturnValue(null)
    const svc = new GeoIPService()
    await svc.open(dbPath)
    expect(svc.lookupCountry('192.168.0.1')).toBeNull()
  })

  it('falls back to the iso_code when the English name is missing', async () => {
    await writeFile(dbPath, Buffer.alloc(64, 0x00))
    mockGet.mockReturnValue({ country: { iso_code: 'XX', names: {} } })
    const svc = new GeoIPService()
    await svc.open(dbPath)
    expect(svc.lookupCountry('1.1.1.1')).toEqual({ code: 'XX', name: 'XX' })
  })

  it('reload() swaps the underlying buffer and lookups reflect the new DB', async () => {
    await writeFile(dbPath, Buffer.alloc(64, 0x00))
    mockGet.mockReturnValue({
      country: { iso_code: 'US', names: { en: 'United States' } },
    })
    const svc = new GeoIPService()
    expect(await svc.open(dbPath)).toBe(true)
    expect(svc.lookupCountry('1.1.1.1')?.code).toBe('US')
    mockGet.mockReturnValue({
      country: { iso_code: 'CN', names: { en: 'China' } },
    })
    expect(await svc.reload(dbPath)).toBe(true)
    expect(svc.lookupCountry('1.1.1.1')?.code).toBe('CN')
  })

  it('returns null after close()', async () => {
    await writeFile(dbPath, Buffer.alloc(64, 0x00))
    mockGet.mockReturnValue({
      country: { iso_code: 'US', names: { en: 'United States' } },
    })
    const svc = new GeoIPService()
    await svc.open(dbPath)
    svc.close()
    expect(svc.isLoaded()).toBe(false)
    expect(svc.lookupCountry('1.1.1.1')).toBeNull()
  })

  it('returns null on an empty IP string without throwing', async () => {
    await writeFile(dbPath, Buffer.alloc(64, 0x00))
    const svc = new GeoIPService()
    await svc.open(dbPath)
    expect(svc.lookupCountry('')).toBeNull()
  })
})
