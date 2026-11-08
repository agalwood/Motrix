import { transport } from '@renderer/lib/transport'
import { Queries } from '@shared/protocol/queries'
import { portableModeSchema } from '@shared/schemas/portable-mode'
import { useState } from 'react'
import { useTransportMirror } from './use-transport-mirror'

export function usePortableMode(): boolean {
  const [portable, setPortable] = useState(false)
  useTransportMirror({
    events: [],
    refetchOnFocus: false,
    load: async (stale) => {
      if (transport.platform === 'web') return
      const status = portableModeSchema.parse(
        await transport.invoke(Queries.GetPortableMode)
      )
      if (!stale()) setPortable(status.enabled)
    },
  })
  return portable
}
