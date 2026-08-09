import type { GeoIPStatus } from '@shared/types/geoip'
import { describe, expect, it, vi } from 'vitest'
import { createGetGeoIPStatusHandler } from './get-geo-ip-status'

const SAMPLE: GeoIPStatus = {
  enabled: true,
  hasDatabase: true,
  loaded: true,
  lastUpdatedAt: 1_700_000_000_000,
  databaseVersion: 'v1',
  sizeBytes: 9_000_000,
  isDownloading: false,
  lastError: null,
}

describe('getGeoIPStatus handler', () => {
  it('passes through GeoIPManager.getStatus()', async () => {
    const geoipManager = { getStatus: vi.fn().mockReturnValue(SAMPLE) }
    const handler = createGetGeoIPStatusHandler({ geoipManager })
    expect(await handler()).toEqual(SAMPLE)
    expect(geoipManager.getStatus).toHaveBeenCalledOnce()
  })
})
