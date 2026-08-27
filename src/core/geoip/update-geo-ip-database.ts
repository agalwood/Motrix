import type { GeoIPStatus } from '@shared/types/geoip'
import type { GeoIPManager } from './geo-ip-manager'

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
