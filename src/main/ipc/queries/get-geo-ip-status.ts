import type { GeoIPManager } from '@core/geoip/geo-ip-manager'
import type { GeoIPStatus } from '@shared/types/geoip'

export interface GetGeoIPStatusDeps {
  geoipManager: Pick<GeoIPManager, 'getStatus'>
}

export function createGetGeoIPStatusHandler(deps: GetGeoIPStatusDeps) {
  return async (): Promise<GeoIPStatus> => deps.geoipManager.getStatus()
}
