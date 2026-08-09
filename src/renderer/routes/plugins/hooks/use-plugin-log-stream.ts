import { transport } from '@renderer/lib/transport'
import type { EventChannel } from '@shared/protocol/events'
import { Events } from '@shared/protocol/events'
import { Queries } from '@shared/protocol/queries'
import type { PluginLogEntry } from '@shared/types/plugin'
import { useEffect, useState } from 'react'

const RING_MAX = 500

export function usePluginLogStream(pluginId: string) {
  const [entries, setEntries] = useState<PluginLogEntry[]>([])

  useEffect(() => {
    let cancelled = false
    const channel = `${Events.PluginLog}:${pluginId}` as EventChannel

    transport
      .invoke(Queries.GetPluginLogs, { pluginId, limit: 100 })
      .then((r) => {
        if (!cancelled) setEntries((r as PluginLogEntry[]) ?? [])
      })
      .catch(() => {
        /* swallow — empty initial tail */
      })

    const onEntry = (...args: unknown[]) => {
      const entry = args[0] as PluginLogEntry
      setEntries((arr) =>
        arr.length >= RING_MAX
          ? [...arr.slice(-(RING_MAX - 1)), entry]
          : [...arr, entry]
      )
    }

    transport.on(channel, onEntry)
    return () => {
      cancelled = true
      transport.off(channel, onEntry)
    }
  }, [pluginId])

  return { entries, setEntries }
}
