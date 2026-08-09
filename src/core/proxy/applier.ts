import { getLogger } from '@core/logger'
import { DEFAULT_PROXY_SETTINGS } from '@shared/schemas/proxy-settings'
import type { ProxySettings } from '@shared/types/settings'
import { proxyToAria2Options, proxyToElectronConfig } from './serializers'

interface EngineSupervisorLike {
  applyProxyChange: (
    opts: { allProxy: string; noProxy: string } | null
  ) => Promise<void> | void
}

interface TrackerManagerLike {
  invalidateProxyCache: () => void
}

export interface ProxyApplierDeps {
  engineSupervisor: EngineSupervisorLike
  trackerManager: TrackerManagerLike
  applyUpdateAppProxy?: (
    cfg: { proxyRules: string; proxyBypassRules: string } | null
  ) => Promise<void> | void
}

export function createProxyApplier(deps: ProxyApplierDeps) {
  const log = getLogger('proxy-applier')

  async function apply(
    oldProxy: ProxySettings,
    newProxy: ProxySettings
  ): Promise<void> {
    if (scopeDirty(oldProxy, newProxy, 'download')) {
      const opts = proxyToAria2Options(newProxy)
      await deps.engineSupervisor.applyProxyChange(opts)
      log.info({ enabled: opts !== null }, 'download proxy applied')
    }

    if (scopeDirty(oldProxy, newProxy, 'updateApp')) {
      if (deps.applyUpdateAppProxy) {
        const cfg = proxyToElectronConfig(newProxy)
        await deps.applyUpdateAppProxy(cfg)
        log.info({ enabled: cfg !== null }, 'updateApp proxy applied')
      } else {
        log.debug(
          'updateApp scope changed but no handler injected (server runtime)'
        )
      }
    }

    if (scopeDirty(oldProxy, newProxy, 'updateTrackers')) {
      deps.trackerManager.invalidateProxyCache()
      log.info('updateTrackers proxy invalidated')
    }
  }

  async function applyAll(current: ProxySettings): Promise<void> {
    const allDisabled: ProxySettings = {
      ...DEFAULT_PROXY_SETTINGS,
      scopes: { download: false, updateApp: false, updateTrackers: false },
    }
    await apply(allDisabled, current)
  }

  return { apply, applyAll }
}

function scopeDirty(
  o: ProxySettings,
  n: ProxySettings,
  scope: keyof ProxySettings['scopes']
): boolean {
  if (o.scopes[scope] !== n.scopes[scope]) return true
  if (!n.scopes[scope] && !o.scopes[scope]) return false
  return (
    o.enabled !== n.enabled ||
    o.protocol !== n.protocol ||
    o.host !== n.host ||
    o.port !== n.port ||
    o.user !== n.user ||
    o.password !== n.password ||
    JSON.stringify(o.bypass) !== JSON.stringify(n.bypass)
  )
}
