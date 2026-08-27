import type { GeoIPStatus } from '@shared/types/geoip'
import type { GeoIPManager } from './geo-ip-manager'

export interface GetGeoIPStatusDeps {
  geoipManager: Pick<GeoIPManager, 'getStatus'>
}

export function createGetGeoIPStatusHandler(deps: GetGeoIPStatusDeps) {
  return async (): Promise<GeoIPStatus> => deps.geoipManager.getStatus()
}
