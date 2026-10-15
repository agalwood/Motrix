import {
  type EndpointConfig,
  LOCAL_ENDPOINT_ID,
} from '@/background/EndpointConfigStore'
import { supportsDownloadTakeover } from '@/shared/platformCapabilities'

/** Use the selected id, never a resolver's fallback for an unavailable Server. */
export function supportsAutomaticTakeover(
  config: Pick<EndpointConfig, 'activeEndpointId'> | null
): boolean {
  return (
    supportsDownloadTakeover() && config?.activeEndpointId === LOCAL_ENDPOINT_ID
  )
}
