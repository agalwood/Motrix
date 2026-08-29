import { getLogger } from '@core/logger'
import type { ProxySettings } from '@shared/types/settings'
import type { DownloadProxyApplyResult } from './applied-download-proxy-policy'
import type { ProxyBridgeResolver } from './proxy-bridge-manager'
import { proxyToElectronConfig } from './serializers'

interface EngineSupervisorLike {
  applyProxyChange: (
    opts: { allProxy: string; noProxy: string } | null
  ) => Promise<boolean> | boolean
}

interface TrackerManagerLike {
  invalidateProxyCache: () => void
}

export interface ProxyApplierDeps {
  engineSupervisor: EngineSupervisorLike
  trackerManager: TrackerManagerLike
  proxyBridge: Pick<ProxyBridgeResolver, 'reconcile' | 'resolveForDownload'>
  applyUpdateAppProxy?: (
    cfg: { proxyRules: string; proxyBypassRules: string } | null
  ) => Promise<void> | void
}

export function createProxyApplier(deps: ProxyApplierDeps) {
  const log = getLogger('proxy-applier')

  async function apply(
    oldProxy: ProxySettings,
    newProxy: ProxySettings
  ): Promise<DownloadProxyApplyResult> {
    let result: DownloadProxyApplyResult = { downloadProxy: 'unchanged' }
    // Reconcile even when only the tracker scope changed, so a SOCKS5
    // listener never outlives the settings that require it.
    await deps.proxyBridge.reconcile(newProxy)

    if (scopeDirty(oldProxy, newProxy, 'download')) {
      const opts = await deps.proxyBridge.resolveForDownload(newProxy)
      result = (await deps.engineSupervisor.applyProxyChange(opts))
        ? { downloadProxy: 'applied', appliedProxy: opts }
        : { downloadProxy: 'unavailable' }
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

    return result
  }

  async function applyAll(
    current: ProxySettings
  ): Promise<DownloadProxyApplyResult> {
    // This is also the recovery path after a partial/failed hot apply, so it
    // must not infer work from a synthetic old value. Reassert every scope,
    // including an explicitly direct download route, against the current
    // persisted settings.
    await deps.proxyBridge.reconcile(current)
    const opts = await deps.proxyBridge.resolveForDownload(current)
    const result: DownloadProxyApplyResult =
      (await deps.engineSupervisor.applyProxyChange(opts))
        ? { downloadProxy: 'applied', appliedProxy: opts }
        : { downloadProxy: 'unavailable' }

    if (deps.applyUpdateAppProxy) {
      await deps.applyUpdateAppProxy(proxyToElectronConfig(current))
    }
    deps.trackerManager.invalidateProxyCache()
    return result
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
