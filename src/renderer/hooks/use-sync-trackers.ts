import { transport } from '@renderer/lib/transport'
import { Commands } from '@shared/protocol/commands'
import { useCallback, useState } from 'react'

export function useSyncTrackers() {
  const [isSyncing, setIsSyncing] = useState(false)

  const sync = useCallback(async () => {
    setIsSyncing(true)
    try {
      await transport.invoke(Commands.SyncTrackers)
    } finally {
      setIsSyncing(false)
    }
  }, [])

  return { sync, isSyncing }
}
