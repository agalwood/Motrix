import { transport } from '@renderer/lib/transport'
import { Events } from '@shared/protocol/events'
import { Queries } from '@shared/protocol/queries'
import type { NatStatus } from '@shared/types/nat'
import { useEffect, useState } from 'react'

// Every NAT lifecycle event invalidates the cached status. State changes,
// mapping/gateway updates, diagnostics, and errors all just trigger a reload —
// the manager owns the authoritative snapshot.
const NAT_EVENTS = [
  Events.NatStateChanged,
  Events.NatMappingUpdated,
  Events.NatGatewayChanged,
  Events.NatDiagnosticCompleted,
  Events.NatError,
] as const

/**
 * Subscribe to the NAT manager status. Returns null until the first
 * `GetNatStatus` resolves, then the latest snapshot, re-fetched whenever any
 * NAT lifecycle event fires.
 */
export function useNatStatus(): NatStatus | null {
  const [status, setStatus] = useState<NatStatus | null>(null)
  useEffect(() => {
    let cancelled = false
    const reload = () => {
      transport
        .invoke(Queries.GetNatStatus)
        .then((res) => {
          if (cancelled) return
          if (res) setStatus(res as NatStatus)
        })
        .catch(() => {})
    }
    reload()
    for (const event of NAT_EVENTS) transport.on(event, reload)
    return () => {
      cancelled = true
      for (const event of NAT_EVENTS) transport.off(event, reload)
    }
  }, [])
  return status
}
