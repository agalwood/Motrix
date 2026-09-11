import { useTransportMirror } from '@renderer/hooks/use-transport-mirror'
import { transport } from '@renderer/lib/transport'
import {
  BridgeCommands,
  BridgeEvents,
  BridgeQueries,
  type BridgeStatusInfo,
  type ClientIdentity,
  type PairedClientInfo,
  type PairRequestPayload,
  type PendingPairRequestInfo,
  type ResolvePairParams,
  type TrustedExtensionInfo,
} from '@shared/protocol/bridge'
import type { CommandChannel } from '@shared/protocol/commands'
import type { EventChannel } from '@shared/protocol/events'
import type { QueryChannel } from '@shared/protocol/queries'
import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { resolvePairWithFeedback } from './pair-resolve'

// Bridge channels live in `@shared/protocol/bridge` (registered directly via
// `ipcMain.handle` in `src/main/bridge/index.ts`). They are not part of the
// generic `Commands` / `Queries` / `Events` unions consumed by `transport`,
// so we cast at the call sites — the channel strings themselves are still
// sourced from the typed `BridgeCommands` / `BridgeQueries` / `BridgeEvents`
// constants (never raw strings).

export function usePairedExtensions() {
  const [items, setItems] = useState<PairedClientInfo[]>([])

  const refresh = useCallback(async () => {
    const list = await transport.invoke(
      BridgeQueries.ListPaired as unknown as QueryChannel
    )
    setItems(list as PairedClientInfo[])
  }, [])

  useEffect(() => {
    void refresh()
    const onChange = () => {
      void refresh()
    }
    const paired = BridgeEvents.Paired as unknown as EventChannel
    const revoked = BridgeEvents.Revoked as unknown as EventChannel
    transport.on(paired, onChange)
    transport.on(revoked, onChange)
    return () => {
      transport.off(paired, onChange)
      transport.off(revoked, onChange)
    }
  }, [refresh])

  const revoke = useCallback(
    async (identity: ClientIdentity) => {
      await transport.invoke(
        BridgeCommands.RevokePair as unknown as CommandChannel,
        { identity }
      )
      await refresh()
    },
    [refresh]
  )

  return { items, refresh, revoke }
}

export function useTrustedExtensions() {
  const [items, setItems] = useState<TrustedExtensionInfo[]>([])

  const refresh = useCallback(async () => {
    const list = await transport.invoke(
      BridgeQueries.ListTrusted as unknown as QueryChannel
    )
    setItems(list as TrustedExtensionInfo[])
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const add = useCallback(
    async (id: string, browser: 'chromium' | 'firefox', label?: string) => {
      await transport.invoke(
        BridgeCommands.AddTrusted as unknown as CommandChannel,
        { id, browser, label }
      )
      await refresh()
    },
    [refresh]
  )

  const remove = useCallback(
    async (id: string, browser: 'chromium' | 'firefox') => {
      await transport.invoke(
        BridgeCommands.RemoveTrusted as unknown as CommandChannel,
        { id, browser }
      )
      await refresh()
    },
    [refresh]
  )

  return { items, refresh, add, remove }
}

/** Narrows an untrusted `GetStatus` reply to {@link BridgeStatusInfo} — a
 *  test double or an unrelated stub that resolves every query to `{}`
 *  (`integration-dialog.test.tsx`'s convention) must degrade to "no status"
 *  rather than render `status.port` as the literal string `"undefined"`. */
function isBridgeStatusInfo(value: unknown): value is BridgeStatusInfo {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { degraded?: unknown }).degraded === 'boolean' &&
    ((value as { extensionPairingHealth?: unknown }).extensionPairingHealth ===
      'ready' ||
      (value as { extensionPairingHealth?: unknown }).extensionPairingHealth ===
        'degraded')
  )
}

/**
 * The bridge's current port policy (Task 21): the bound port, whether it
 * degraded to an ephemeral port (§4), and the persisted `fixedPort`/
 * `instanceId` settings that produced that outcome. `null` while loading AND
 * when the bridge is disabled — `bridge:getStatus` has no handler installed
 * in that state (`bootstrapBridge` returns early and never reaches
 * `installIpcHandler`), so `transport.invoke` rejects; the settings UI has no
 * separate "off" state to render here since the master switch (a form field,
 * not this hook) already tells it that.
 *
 * Mount-fetch only, deliberately: no event announces a bridge port change
 * (`SettingsChanged` never reaches the renderer for bridge settings — see
 * `use-engine-display-status.ts`'s listener, which is dead for this purpose)
 * and the settings dialog remounts every time it opens, which is enough to
 * keep this current in the one place it's shown.
 */
export function useBridgeStatus(): BridgeStatusInfo | null {
  const [status, setStatus] = useState<BridgeStatusInfo | null>(null)

  useEffect(() => {
    let cancelled = false
    void (async () => {
      let raw: unknown
      try {
        raw = await transport.invoke(
          BridgeQueries.GetStatus as unknown as QueryChannel
        )
      } catch {
        // Bridge disabled (no handler registered) or transport unavailable —
        // either way there is no status to show.
        if (!cancelled) setStatus(null)
        return
      }
      if (cancelled) return
      setStatus(isBridgeStatusInfo(raw) ? raw : null)
    })()
    return () => {
      cancelled = true
    }
  }, [])

  return status
}

export function usePairRequest(
  onRequest: (payload: PairRequestPayload) => void
) {
  useEffect(() => {
    const channel = BridgeEvents.PairRequested as unknown as EventChannel
    const listener = (...args: unknown[]) => {
      onRequest(args[0] as PairRequestPayload)
    }
    transport.on(channel, listener)
    return () => transport.off(channel, listener)
  }, [onRequest])
}

export async function respondToPairRequest(
  args: ResolvePairParams
): Promise<void> {
  await transport.invoke(
    BridgeCommands.ResolvePair as unknown as CommandChannel,
    args
  )
}

/** The cli member of the {@link PendingPairRequestInfo} union — the only kind
 *  the CLI approval inbox renders (Task 4, Phase B: extension entries share
 *  the query's backing list but stay out of this inbox). */
type CliPendingPairRequestInfo = Extract<
  PendingPairRequestInfo,
  { kind: 'cli' }
>

export function usePendingPairRequests() {
  const { t } = useTranslation()
  const [items, setItems] = useState<CliPendingPairRequestInfo[]>([])
  const [now, setNow] = useState(() => Date.now())

  const load = useCallback(async (stale: () => boolean) => {
    const list = (await transport.invoke(
      BridgeQueries.ListPendingPairRequests as unknown as QueryChannel
    )) as PendingPairRequestInfo[]
    if (stale()) return
    setItems(
      list.filter((it): it is CliPendingPairRequestInfo => it.kind === 'cli')
    )
  }, [])

  // Settled (denied/approved elsewhere, or transport-aborted) and expired
  // (lapsed past TTL) both need to drop this row's Approve button promptly
  // rather than wait for focus/visibility or the 1s local prune — see
  // src/main/bridge/index.ts's PairRequestSettled / PairRequestExpired
  // emitters, which exist to drive exactly this. `Paired` is deliberately
  // NOT subscribed here: it never changes the PENDING set — a trusted
  // auto-pair creates no pending row, and a prompt-side settle for a
  // pending row already arrives as PairRequestSettled.
  const { refresh } = useTransportMirror({
    events: [
      BridgeEvents.PairRequested,
      BridgeEvents.PairRequestSettled,
      BridgeEvents.PairRequestExpired,
    ] as unknown as readonly EventChannel[],
    load,
    refetchOnVisibility: true,
  })

  useEffect(() => {
    // One 1s tick drives the countdown clock AND locally prunes lapsed rows
    // (no server round-trip) so an expiring row drops without a refetch.
    // Presentation state only — independent of the transport mirror wiring
    // above.
    const tick = window.setInterval(() => {
      const t2 = Date.now()
      setNow(t2)
      setItems((prev) => {
        const next = prev.filter((it) => it.expiresAt > t2)
        return next.length === prev.length ? prev : next
      })
    }, 1000)
    return () => window.clearInterval(tick)
  }, [])

  const approve = useCallback(
    async (requestId: string) => {
      await resolvePairWithFeedback(
        { kind: 'cli', requestId, decision: 'allow' },
        t
      )
      await refresh()
    },
    [refresh, t]
  )
  const deny = useCallback(
    async (requestId: string) => {
      await resolvePairWithFeedback(
        { kind: 'cli', requestId, decision: 'deny' },
        t
      )
      await refresh()
    },
    [refresh, t]
  )

  return { items, now, approve, deny }
}
