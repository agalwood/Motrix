import type { GeoIPStatus } from '@shared/types/geoip'
import { describe, expect, it, vi } from 'vitest'
import { createUpdateGeoIPDatabaseHandler } from './update-geo-ip-database'

const STATUS_AFTER: GeoIPStatus = {
  enabled: true,
  hasDatabase: true,
  loaded: true,
  lastUpdatedAt: 2_000_000_000_000,
  databaseVersion: 'v2',
  sizeBytes: 9_500_000,
  isDownloading: false,
  lastError: null,
}

describe('updateGeoIPDatabase handler', () => {
  it('returns the status from GeoIPManager.triggerUpdate()', async () => {
    const geoipManager = {
      triggerUpdate: vi.fn().mockResolvedValue(STATUS_AFTER),
    }
    const handler = createUpdateGeoIPDatabaseHandler({ geoipManager })
    expect(await handler()).toEqual(STATUS_AFTER)
    expect(geoipManager.triggerUpdate).toHaveBeenCalledOnce()
  })

  it('propagates errors from triggerUpdate', async () => {
    const geoipManager = {
      triggerUpdate: vi.fn().mockRejectedValue(new Error('source unsupported')),
    }
    const handler = createUpdateGeoIPDatabaseHandler({ geoipManager })
    await expect(handler()).rejects.toThrow(/source unsupported/)
  })
})
