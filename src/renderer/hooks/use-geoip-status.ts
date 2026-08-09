import { transport } from '@renderer/lib/transport'
import { Commands } from '@shared/protocol/commands'
import { Events } from '@shared/protocol/events'
import { Queries } from '@shared/protocol/queries'
import type { DownloadProgress, GeoIPStatus } from '@shared/types/geoip'
import { useCallback, useEffect, useState } from 'react'

export interface UseGeoIPStatusResult {
  status: GeoIPStatus | null
  progress: DownloadProgress | null
  /** Trigger a fresh download. Resolves with the post-update status. */
  triggerUpdate: () => Promise<GeoIPStatus | null>
  /** Re-fetch the latest status from the main process. */
  refresh: () => Promise<void>
}

export function useGeoIPStatus(): UseGeoIPStatusResult {
  const [status, setStatus] = useState<GeoIPStatus | null>(null)
  const [progress, setProgress] = useState<DownloadProgress | null>(null)

  const refresh = useCallback(async () => {
    try {
      const data = (await transport.invoke(
        Queries.GetGeoIPStatus
      )) as GeoIPStatus
      setStatus(data)
    } catch {
      // The main process is the source of truth; transient IPC errors
      // can simply leave the previous status visible until the next
      // refresh.
    }
  }, [])

  useEffect(() => {
    refresh()
    const onProgress = (...args: unknown[]) => {
      setProgress(args[0] as DownloadProgress)
    }
    const onStatus = (...args: unknown[]) => {
      setStatus(args[0] as GeoIPStatus)
      // Clear progress at the moment status reports a non-downloading
      // state; otherwise the progress bar lingers at 100% after success.
      const next = args[0] as GeoIPStatus
      if (!next.isDownloading) setProgress(null)
    }
    transport.on(Events.GeoIPUpdateProgress, onProgress)
    transport.on(Events.GeoIPStatusChanged, onStatus)
    return () => {
      transport.off(Events.GeoIPUpdateProgress, onProgress)
      transport.off(Events.GeoIPStatusChanged, onStatus)
    }
  }, [refresh])

  const triggerUpdate = useCallback(async () => {
    const next = (await transport.invoke(
      Commands.UpdateGeoIPDatabase
    )) as GeoIPStatus
    setStatus(next)
    return next
  }, [])

  return { status, progress, triggerUpdate, refresh }
}
