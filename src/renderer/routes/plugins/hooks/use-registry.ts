import { transport } from '@renderer/lib/transport'
import { Commands } from '@shared/protocol/commands'
import { Queries } from '@shared/protocol/queries'
import type { RegistryPluginDTO } from '@shared/schemas/registry'
import { useEffect, useState } from 'react'
import { type UpdateChannel, usePluginsStore } from '../store'

/**
 * Remote-registry directory for the marketplace list. The main process
 * serves last-good cached data (RegistryClient), so this resolves offline;
 * an empty result simply renders no "available" section.
 */
export function useRegistryPlugins(): RegistryPluginDTO[] {
  const entries = usePluginsStore((s) => s.registry)
  const setRegistry = usePluginsStore((s) => s.setRegistry)

  useEffect(() => {
    let cancelled = false
    void transport.invoke(Queries.ListRegistryPlugins).then((resp) => {
      if (cancelled) return
      setRegistry((resp as RegistryPluginDTO[]) ?? [])
    })
    return () => {
      cancelled = true
    }
  }, [setRegistry])

  return entries
}

/**
 * Single registry entry lookup for the detail page's registry-backed view
 * (deeplinked, not-installed plugins). Served from the store when the list
 * page already fetched the directory; the GetRegistryPlugin round-trip only
 * runs on cold-start deeplinks. `checked` distinguishes "still loading"
 * from "definitely not in the registry".
 */
export function useRegistryEntry(id: string): {
  checked: boolean
  entry: RegistryPluginDTO | null
} {
  const fromStore = usePluginsStore(
    (s) => s.registry.find((e) => e.id === id) ?? null
  )
  // Keyed by id so a route change never surfaces the previous id's result.
  const [fetched, setFetched] = useState<{
    id: string
    entry: RegistryPluginDTO | null
  } | null>(null)

  useEffect(() => {
    if (fromStore) return
    let cancelled = false
    void transport.invoke(Queries.GetRegistryPlugin, id).then((resp) => {
      if (cancelled) return
      setFetched({ id, entry: (resp as RegistryPluginDTO | null) ?? null })
    })
    return () => {
      cancelled = true
    }
  }, [id, fromStore])

  if (fromStore) return { checked: true, entry: fromStore }
  if (fetched?.id === id) return { checked: true, entry: fetched.entry }
  return { checked: false, entry: null }
}

function toUpdatesMap(
  resp: unknown
): Record<string, { latestVersion: string; channel: UpdateChannel }> {
  const list =
    (resp as {
      pluginId: string
      latestVersion: string
      channel: UpdateChannel
    }[]) ?? []
  return Object.fromEntries(
    list.map((u) => [
      u.pluginId,
      { latestVersion: u.latestVersion, channel: u.channel },
    ])
  )
}

/**
 * Registry update scan. Both shells expose CheckPluginUpdates; the server
 * returns community updates only because builtin overlays ship with a new
 * container image. Mount-time check is cache-only inside the client TTL;
 * `refresh()` forces a conditional refetch and re-pulls the directory.
 */
export function useRegistryUpdates(enabled: boolean): {
  refreshing: boolean
  refresh: () => Promise<void>
} {
  const setUpdates = usePluginsStore((s) => s.setUpdates)
  const setRegistry = usePluginsStore((s) => s.setRegistry)
  const [refreshing, setRefreshing] = useState(false)

  useEffect(() => {
    if (!enabled) return
    let cancelled = false
    void transport.invoke(Commands.CheckPluginUpdates, {}).then((resp) => {
      if (cancelled) return
      setUpdates(toUpdatesMap(resp))
    })
    return () => {
      cancelled = true
    }
  }, [enabled, setUpdates])

  async function refresh(): Promise<void> {
    if (!enabled) return
    setRefreshing(true)
    try {
      const updates = await transport.invoke(Commands.CheckPluginUpdates, {
        force: true,
      })
      const entries = await transport.invoke(Queries.ListRegistryPlugins)
      setUpdates(toUpdatesMap(updates))
      setRegistry((entries as RegistryPluginDTO[]) ?? [])
    } catch {
      // Silent degrade per the registry client contract: last-good data
      // keeps serving; a failed manual refresh must not surface as an
      // unhandled rejection.
    } finally {
      setRefreshing(false)
    }
  }

  return { refreshing, refresh }
}
