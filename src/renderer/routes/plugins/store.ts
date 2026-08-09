import type { RegistryPluginDTO } from '@shared/schemas/registry'
import type {
  PluginListDTO,
  PluginManifest,
  PluginStatus,
} from '@shared/types/plugin'
import { create } from 'zustand'
import type { GrantsMap } from './lib/audience'

export type UpdateChannel = 'community' | 'builtin'

export interface PluginDetail {
  manifest: PluginManifest
  config: Record<string, unknown>
  grants: GrantsMap
}

interface PluginsState {
  loaded: boolean
  list: PluginListDTO[]
  detail: Record<string, PluginDetail | undefined>
  // Per-plugin optional-permission grants (spec §I30). Populated by
  // usePlugins via Queries.ListPluginGrants; refreshed on
  // Events.PluginGrantsChanged. PluginCard reads its slice to compute
  // an accurate audience tone — without it, every plugin with any
  // optionalPermission falsely shows "Grant access".
  grants: Record<string, GrantsMap>
  // Remote-registry directory (dl.motrix.app via RegistryClient in main).
  // Kept beside the installed list so the page can partition
  // installed-vs-available by id.
  registry: RegistryPluginDTO[]
  // pluginId → latest version + channel, from Commands.CheckPluginUpdates.
  // channel distinguishes a community-registry update (routes to
  // PluginInstallDialog's fixedSource path) from a builtin hot update
  // (routes to BuiltinUpdateDialog).
  updates: Record<string, { latestVersion: string; channel: UpdateChannel }>
  setList(list: PluginListDTO[]): void
  setRegistry(entries: RegistryPluginDTO[]): void
  setUpdates(
    updates: Record<string, { latestVersion: string; channel: UpdateChannel }>
  ): void
  clearUpdate(pluginId: string): void
  setDetail(id: string, data: PluginDetail): void
  setGrants(grants: Record<string, GrantsMap>): void
  patchGrants(id: string, grants: GrantsMap): void
  applyStatus(
    id: string,
    status: PluginStatus,
    lastError?: string,
    enabled?: boolean
  ): void
}

export const usePluginsStore = create<PluginsState>((set) => ({
  loaded: false,
  list: [],
  detail: {},
  grants: {},
  registry: [],
  updates: {},
  setList: (list) => set({ list, loaded: true }),
  setRegistry: (registry) => set({ registry }),
  setUpdates: (updates) => set({ updates }),
  clearUpdate: (pluginId) =>
    set((s) => {
      if (!(pluginId in s.updates)) return s
      const next = { ...s.updates }
      delete next[pluginId]
      return { updates: next }
    }),
  setDetail: (id, data) =>
    set((s) => ({ detail: { ...s.detail, [id]: data } })),
  setGrants: (grants) => set({ grants }),
  patchGrants: (id, grants) =>
    set((s) => ({ grants: { ...s.grants, [id]: grants } })),
  applyStatus: (id, status, lastError, enabled) =>
    set((s) => {
      const idx = s.list.findIndex((p) => p.id === id)
      if (idx < 0) return s
      const prev = s.list[idx]
      const nextEnabled = enabled ?? prev.enabled
      if (
        prev.status === status &&
        prev.enabled === nextEnabled &&
        prev.lastError === lastError
      ) {
        return s
      }
      const list = s.list.slice()
      list[idx] = { ...prev, status, enabled: nextEnabled, lastError }
      return { list }
    }),
}))
