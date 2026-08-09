import type { EngineSupervisor } from '@core/engine/engine-supervisor'
import { createProxyApplier } from '@core/proxy/applier'
import type { TrackerManager } from '@core/tracker/tracker-manager'
import { session } from 'electron'

export function createMainProxyApplier(
  engineSupervisor: EngineSupervisor,
  trackerManager: TrackerManager
) {
  return createProxyApplier({
    engineSupervisor,
    trackerManager,
    applyUpdateAppProxy: async (cfg) => {
      if (cfg) {
        await session.defaultSession.setProxy(cfg)
      } else {
        await session.defaultSession.setProxy({ mode: 'direct' })
      }
    },
  })
}
