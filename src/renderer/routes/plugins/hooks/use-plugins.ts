import { transport } from '@renderer/lib/transport'
import { Events } from '@shared/protocol/events'
import { Queries } from '@shared/protocol/queries'
import type { PluginListDTO, PluginStatus } from '@shared/types/plugin'
import type { GrantsMap } from '@shared/types/plugin-install'
import { useEffect } from 'react'
import { usePluginsStore } from '../store'

interface StatusChangedPayload {
  id?: string
  pluginId?: string
  status: PluginStatus
  enabled?: boolean
  lastError?: string
}

export function usePlugins(): PluginListDTO[] {
  const list = usePluginsStore((s) => s.list)
  const setList = usePluginsStore((s) => s.setList)
  const setGrants = usePluginsStore((s) => s.setGrants)
  const patchGrants = usePluginsStore((s) => s.patchGrants)
  const applyStatus = usePluginsStore((s) => s.applyStatus)

  useEffect(() => {
    let cancelled = false
    let refreshGeneration = 0
    let inFlight: Promise<void> | null = null
    let refreshQueued = false

    const runRefresh = (generation: number): Promise<void> => {
      const request = Promise.all([
        transport.invoke(Queries.ListPlugins),
        transport.invoke(Queries.ListPluginGrants),
      ])
        .then(([listResp, grantsResp]) => {
          if (cancelled || generation !== refreshGeneration) return
          setList(listResp as PluginListDTO[])
          setGrants((grantsResp as Record<string, GrantsMap>) ?? {})
        })
        .catch(() => {
          // Keep the last good snapshot. A later event can retry the refresh.
        })
        .finally(() => {
          if (inFlight !== request) return
          inFlight = null
          if (cancelled || !refreshQueued) return
          refreshQueued = false
          inFlight = runRefresh(refreshGeneration)
        })
      return request
    }

    const refresh = (): void => {
      refreshGeneration += 1
      if (inFlight) {
        refreshQueued = true
        return
      }
      inFlight = runRefresh(refreshGeneration)
    }
    refresh()

    const onStatus = (...args: unknown[]) => {
      const p = args[0] as StatusChangedPayload
      const pluginId = p.pluginId ?? p.id
      if (!pluginId) return
      applyStatus(pluginId, p.status, p.lastError, p.enabled)
    }
    const onLifecycle = () => {
      refresh()
    }
    const onLocale = () => {
      refresh()
    }
    const onGrants = (...args: unknown[]) => {
      const p = args[0] as { pluginId: string }
      if (!p?.pluginId) return
      void transport.invoke(Queries.GetPluginGrants, p.pluginId).then((g) => {
        if (cancelled) return
        patchGrants(p.pluginId, (g as GrantsMap) ?? {})
      })
    }

    transport.on(Events.PluginStatusChanged, onStatus)
    transport.on(Events.PluginInstalled, onLifecycle)
    transport.on(Events.PluginUninstalled, onLifecycle)
    transport.on(Events.LocaleChanged, onLocale)
    transport.on(Events.PluginGrantsChanged, onGrants)

    return () => {
      cancelled = true
      refreshGeneration += 1
      refreshQueued = false
      transport.off(Events.PluginStatusChanged, onStatus)
      transport.off(Events.PluginInstalled, onLifecycle)
      transport.off(Events.PluginUninstalled, onLifecycle)
      transport.off(Events.LocaleChanged, onLocale)
      transport.off(Events.PluginGrantsChanged, onGrants)
    }
  }, [setList, setGrants, patchGrants, applyStatus])

  return list
}
