import type { GeoIPManager } from '@core/geoip/geo-ip-manager'
import type { GeoIPStatus } from '@shared/types/geoip'

export interface UpdateGeoIPDatabaseDeps {
  geoipManager: Pick<GeoIPManager, 'triggerUpdate'>
}

/**
 * Trigger a download of the configured GeoIP source. Concurrent calls
 * are coalesced inside {@link GeoIPManager.triggerUpdate}, so multiple
 * UI clicks resolve once with the same status payload.
 */
export function createUpdateGeoIPDatabaseHandler(
  deps: UpdateGeoIPDatabaseDeps
) {
  return async (): Promise<GeoIPStatus> => deps.geoipManager.triggerUpdate()
}
