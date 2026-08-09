import { transport } from '@renderer/lib/transport'
import type { EventChannel } from '@shared/protocol/events'
import { useEffect, useRef } from 'react'

/** Subscribes to a motrix IPC event, auto-cleans up on unmount. */
export function useIpcEvent(
  event: EventChannel,
  handler: (...args: unknown[]) => void
) {
  const handlerRef = useRef(handler)
  useEffect(() => {
    handlerRef.current = handler
  })

  useEffect(() => {
    const listener = (...args: unknown[]) => handlerRef.current(...args)
    transport.on(event, listener)
    return () => transport.off(event, listener)
  }, [event])
}
