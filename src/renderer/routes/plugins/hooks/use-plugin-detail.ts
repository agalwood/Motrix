import { transport } from '@renderer/lib/transport'
import { Events } from '@shared/protocol/events'
import { Queries } from '@shared/protocol/queries'
import type { PluginManifest } from '@shared/types/plugin'
import type { GrantsMap } from '@shared/types/plugin-install'
import { useEffect, useState } from 'react'

export interface PluginDetailSnapshot {
  manifest: PluginManifest
  config: Record<string, unknown>
  grants: GrantsMap
}

interface SettingsSnapshot {
  plugins?: Record<string, Record<string, unknown>>
}

export function usePluginDetail(pluginId: string): PluginDetailSnapshot | null {
  const [detail, setDetail] = useState<PluginDetailSnapshot | null>(null)

  useEffect(() => {
    let cancelled = false
    let refreshGeneration = 0
    let inFlight: Promise<void> | null = null
    let refreshQueued = false

    const runRefresh = (generation: number): Promise<void> => {
      const request = Promise.all([
        transport.invoke(Queries.GetPluginManifest, pluginId),
        transport.invoke(Queries.GetSettings),
        transport.invoke(Queries.GetPluginGrants, pluginId),
      ])
        .then(([manifest, settings, grants]) => {
          if (cancelled || generation !== refreshGeneration) return
          if (!manifest) {
            setDetail(null)
            return
          }
          const m = manifest as PluginManifest
          const s = settings as SettingsSnapshot | undefined
          setDetail({
            manifest: m,
            config: s?.plugins?.[pluginId] ?? {},
            grants: (grants as GrantsMap) ?? {},
          })
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

    const onConfigChanged = (...args: unknown[]) => {
      const p = args[0] as { pluginId: string }
      if (p.pluginId === pluginId) refresh()
    }
    const onGrantsChanged = (...args: unknown[]) => {
      const p = args[0] as { pluginId: string }
      if (p.pluginId === pluginId) refresh()
    }
    const onLocale = () => {
      refresh()
    }
    // A builtin update commit hot-swaps the plugin and emits PluginInstalled;
    // without this the list (usePlugins) refreshes but the detail snapshot
    // keeps showing the pre-update manifest (stale version) until remount.
    const onInstalled = (...args: unknown[]) => {
      const p = args[0] as { pluginId: string }
      if (p.pluginId === pluginId) refresh()
    }
    transport.on(Events.PluginConfigChanged, onConfigChanged)
    transport.on(Events.PluginGrantsChanged, onGrantsChanged)
    transport.on(Events.LocaleChanged, onLocale)
    transport.on(Events.PluginInstalled, onInstalled)

    return () => {
      cancelled = true
      refreshGeneration += 1
      refreshQueued = false
      transport.off(Events.PluginConfigChanged, onConfigChanged)
      transport.off(Events.PluginGrantsChanged, onGrantsChanged)
      transport.off(Events.LocaleChanged, onLocale)
      transport.off(Events.PluginInstalled, onInstalled)
    }
  }, [pluginId])

  return detail
}
