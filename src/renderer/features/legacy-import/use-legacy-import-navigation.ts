import { useTransportMirror } from '@renderer/hooks/use-transport-mirror'
import { Events } from '@shared/protocol/events'
import { Queries } from '@shared/protocol/queries'
import { legacyImportNavigationSchema } from '@shared/schemas/legacy-import'
import { useState } from 'react'

export function useLegacyImportNavigation() {
  const [detected, setDetected] = useState(false)
  useTransportMirror({
    events: [Events.LegacyImportNavigationChanged],
    load: async (stale, read) => {
      if (__MOTRIX_TARGET__ !== 'electron') return
      const state = legacyImportNavigationSchema.parse(
        await read(Queries.GetLegacyImportNavigation)
      )
      if (!stale()) setDetected(state.detected)
    },
  })
  return { detected }
}
