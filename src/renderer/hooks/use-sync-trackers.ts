import { transport } from '@renderer/lib/transport'
import { Commands } from '@shared/protocol/commands'
import { Events } from '@shared/protocol/events'
import { Queries } from '@shared/protocol/queries'
import {
  type TrackerSyncStatus,
  trackerSyncStatusSchema,
} from '@shared/schemas/tracker-sync'
import { useCallback, useState } from 'react'
import { useTransportMirror } from './use-transport-mirror'

export function useSyncTrackers() {
  const [status, setStatus] = useState<TrackerSyncStatus>('idle')
  const [pending, setPending] = useState(false)
  const [commandFailed, setCommandFailed] = useState(false)
  const [unavailable, setUnavailable] = useState(false)

  const { refresh } = useTransportMirror({
    events: [Events.TrackerSyncStatusChanged],
    load: async (stale) => {
      try {
        const next = trackerSyncStatusSchema.parse(
          await transport.invoke(Queries.GetTrackerSyncStatus)
        )
        if (stale()) return
        setStatus(next)
        setUnavailable(false)
        if (next !== 'idle' && next !== 'failed') setCommandFailed(false)
      } catch (error) {
        if (!stale()) setUnavailable(true)
        throw error
      }
    },
  })

  const sync = useCallback(async () => {
    setPending(true)
    setCommandFailed(false)
    try {
      await transport.invoke(Commands.SyncTrackers)
    } catch {
      setCommandFailed(true)
    } finally {
      await refresh()
      setPending(false)
    }
  }, [refresh])

  // A failed status read cannot confirm that the last busy snapshot is
  // still running. Allow manual retry until a fresh snapshot arrives.
  const isSyncing =
    pending || (!unavailable && status !== 'idle' && status !== 'failed')
  const error = isSyncing
    ? null
    : unavailable
      ? 'unavailable'
      : status === 'failed' || commandFailed
        ? 'failed'
        : null
  return { sync, isSyncing, status, error }
}
