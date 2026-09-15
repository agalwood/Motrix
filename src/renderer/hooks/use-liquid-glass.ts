import { transport } from '@renderer/lib/transport'
import { Events } from '@shared/protocol/events'
import { Queries } from '@shared/protocol/queries'
import type { AppSettings } from '@shared/types/settings'
import { useState } from 'react'
import { useTransportMirror } from './use-transport-mirror'

export function useLiquidGlass(): boolean {
  const [enabled, setEnabled] = useState(false)
  useTransportMirror({
    events: [Events.LiquidGlassChanged],
    load: async (stale) => {
      const settings = (await transport.invoke(
        Queries.GetSettings
      )) as AppSettings
      if (!stale()) setEnabled(settings?.app?.liquidGlassEffect === true)
    },
  })
  return enabled
}
