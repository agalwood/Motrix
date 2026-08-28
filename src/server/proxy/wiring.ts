import type { EngineSupervisor } from '@core/engine/engine-supervisor'
import { createProxyApplier } from '@core/proxy/applier'
import type { ProxyBridgeManager } from '@core/proxy/proxy-bridge-manager'
import type { TrackerManager } from '@core/tracker/tracker-manager'

// Server has no Electron session; the updateApp scope is silently
// no-op. The toggle is still saved in settings, but only takes effect
// when the same settings file is loaded by an Electron build.
export function createServerProxyApplier(
  engineSupervisor: EngineSupervisor,
  trackerManager: TrackerManager,
  proxyBridge: ProxyBridgeManager
) {
  return createProxyApplier({
    engineSupervisor,
    trackerManager,
    proxyBridge,
    // applyUpdateAppProxy intentionally omitted
  })
}
