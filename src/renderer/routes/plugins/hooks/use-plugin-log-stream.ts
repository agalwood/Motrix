import { transport } from '@renderer/lib/transport'
import { comparePluginLogs } from '@shared/lib/plugin-log-order'
import type { EventChannel } from '@shared/protocol/events'
import { Events } from '@shared/protocol/events'
import { Queries } from '@shared/protocol/queries'
import type { PluginLogEntry } from '@shared/types/plugin'
import { useCallback, useEffect, useRef, useState } from 'react'

const RING_MAX = 500

function mergeEntries(...groups: PluginLogEntry[][]): PluginLogEntry[] {
  const entries = new Map<string, PluginLogEntry>()
  for (const entry of groups.flat()) {
    const key =
      typeof entry.entryId === 'string' ? entry.entryId : JSON.stringify(entry)
    entries.set(key, entry)
  }
  return [...entries.values()].sort(comparePluginLogs).slice(-RING_MAX)
}

export function usePluginLogStream(pluginId: string) {
  const [snapshot, setSnapshot] = useState({
    pluginId,
    entries: [] as PluginLogEntry[],
  })
  const refreshRef = useRef<() => Promise<void>>(async () => {})
  const refresh = useCallback(() => refreshRef.current(), [])

  useEffect(() => {
    let cancelled = false
    let generation = 0
    let pending = false
    let live: PluginLogEntry[] = []
    const channel = `${Events.PluginLog}:${pluginId}` as EventChannel
    setSnapshot({ pluginId, entries: [] })
    const readTail = async () => {
      const request = ++generation
      pending = true
      live = []
      try {
        const entries = (await transport.invoke(Queries.GetPluginLogs, {
          pluginId,
          limit: 100,
        })) as PluginLogEntry[]
        if (!cancelled && request === generation) {
          pending = false
          setSnapshot({ pluginId, entries: mergeEntries(entries ?? [], live) })
        }
      } catch {
        if (!cancelled && request === generation) pending = false
        // Preserve live entries if the snapshot fails; reconnect retries it.
      }
    }
    const onEntry = (...args: unknown[]) => {
      if (cancelled) return
      const entry = args[0] as PluginLogEntry
      if (pending) live = mergeEntries(live, [entry])
      setSnapshot((current) => ({
        pluginId,
        entries: mergeEntries(
          current.pluginId === pluginId ? current.entries : [],
          [entry]
        ),
      }))
    }
    transport.on(channel, onEntry)
    refreshRef.current = readTail
    const unsubscribe = transport.onConnectionChange?.(({ state }) => {
      if (state === 'connected') void readTail()
    })
    void readTail()
    return () => {
      cancelled = true
      refreshRef.current = async () => {}
      transport.off(channel, onEntry)
      unsubscribe?.()
    }
  }, [pluginId])

  return {
    entries: snapshot.pluginId === pluginId ? snapshot.entries : [],
    refresh,
  }
}
