import {
  type PairRequestToastData,
  pairRequestCopy,
  toast,
} from '@renderer/components/ui/toast'
import { transport } from '@renderer/lib/transport'
import {
  BridgeEvents,
  BridgeQueries,
  type PairRequestExpiredPayload,
  type PairRequestPayload,
  type PairRequestSettledPayload,
  type PendingPairRequestInfo,
  pairRequestKey,
  type ResolvePairParams,
} from '@shared/protocol/bridge'
import type { EventChannel } from '@shared/protocol/events'
import type { QueryChannel } from '@shared/protocol/queries'
import { useEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { resolvePairWithFeedback } from './pair-resolve'

/** Projects a backend-owned pending entry (from `ListPendingPairRequests`)
 *  onto the same wire shape a live `PairRequested` event carries, so both
 *  sources can flow through one `present()` path. */
function toPairRequestPayload(
  info: PendingPairRequestInfo
): PairRequestPayload {
  return info.kind === 'cli'
    ? {
        kind: 'cli',
        requestId: info.requestId,
        userCode: info.userCode,
        clientName: info.clientName,
        clientVersion: info.clientVersion,
      }
    : {
        kind: 'extension',
        pairingNonce: info.pairingNonce,
        extensionId: info.extensionId,
        browser: info.browser,
        identity: info.identity,
        code: info.code,
      }
}

/**
 * Renderer-wide pairing-prompt host (Phase B). Replaces the old
 * one-toast-per-event `usePairRequestToast`: each pending pairing
 * request is now a Base UI toast keyed by {@link pairRequestKey}, and the
 * prompt set is reconciled against the backend's own bookkeeping
 * (`ListPendingPairRequests`) instead of living only in a toast closure —
 * so a renderer reload recovers in-flight prompts instead of losing them.
 *
 * Subscribe-then-snapshot ordering matters on Electron: the three lifecycle
 * listeners attach BEFORE the initial snapshot is invoked, so a request that
 * settles or expires in the gap between the query firing and its response
 * landing is still caught by the live listener (and the `prompts` identity
 * guard below absorbs the ensuing duplicate/no-op cleanly either way). That
 * guarantee is Electron-only, though: on the web shell the WebSocket may
 * still be CONNECTING/backing off while `transport.on()` registers its local
 * callback, and the server-side broadcaster drops events with zero connected
 * sockets — so a live listener alone can miss a prompt/settle that happens
 * in that gap. `transport.onConnectionChange` re-snapshots on every
 * `connected` transition (including the very first one) to close it; see the
 * `snapshot()` re-use below.
 *
 * The effect subscribes exactly once (empty deps) and never on a `t`
 * identity change: `LanguageSync` calls `i18n.changeLanguage()`
 * unconditionally on every app start (even to the same language), which
 * bumps `t`'s identity via react-i18next with no same-language
 * short-circuit. Re-running this effect on that would tear down and
 * re-snapshot on every mount — discarding the `prompts`/settled map and
 * racing a fresh snapshot response against whatever the user just decided
 * (see the regression this guards against in the hook's tests). `t` is
 * only needed for `resolvePairWithFeedback` and the add-time SR
 * announcement copy below, so it's threaded through a ref instead
 * (mirrors `use-notification-toasts.ts`'s mount-time engine-status check).
 */
export function usePairRequestPrompts(): void {
  const { t } = useTranslation()
  const tRef = useRef(t)
  tRef.current = t

  useEffect(() => {
    // key -> lifecycle state for a prompt currently owned by this hook
    // instance. Guards three races: a duplicate `PairRequested` for a
    // live key (no-op), a double Allow/Deny click (no-op past the first),
    // and the close-button path (`onClose`, wired to a deny) firing again
    // when OUR OWN `toast.close(key)` runs after we've already settled —
    // marking `settled` before that close is what makes the second deny
    // a no-op instead of a duplicate resolve.
    const prompts = new Map<string, { settled: boolean }>()

    const present = (payload: PairRequestPayload) => {
      const key = pairRequestKey(payload)
      if (prompts.has(key)) return
      const state = { settled: false }
      prompts.set(key, state)

      // Allow/Deny mark settled + close the toast optimistically, then await
      // the actual ResolvePair round-trip. If that round-trip itself never
      // lands (transport down, backend persistence failure — as opposed to
      // the backend cleanly replying "no longer pending", which
      // `resolvePairWithFeedback` already surfaces as its own toast), the
      // decision never reached the backend at all: the request is still
      // genuinely pending there. Un-settling locally and dropping this key's
      // tombstone lets a later PairRequested/snapshot re-present the SAME
      // prompt instead of leaving the user with no way to ever decide it.
      // Tombstone semantics for a request that genuinely DID settle are
      // untouched — no Settled/Expired event fired for this key, so nothing
      // else believes it's done.
      const settle = async (decision: 'allow' | 'deny') => {
        if (state.settled) return
        state.settled = true
        toast.close(key)
        const params: ResolvePairParams =
          payload.kind === 'cli'
            ? { kind: 'cli', requestId: payload.requestId, decision }
            : {
                // MBP1 has no allow/deny decision for an extension prompt —
                // approval is proven by typing the code into the extension,
                // not by a click here (ui/toast.tsx renders no Allow button
                // for this kind at all). `decision` is accepted but unused:
                // both the Deny button and the × close reach here only via
                // settle('deny').
                kind: 'extension',
                pairingNonce: payload.pairingNonce,
                extensionId: payload.extensionId,
                browser: payload.browser,
              }
        try {
          await resolvePairWithFeedback(params, tRef.current)
        } catch {
          state.settled = false
          prompts.delete(key)
          toast.add({
            type: 'error',
            title: tRef.current('settings.integration.pairResolveFailed'),
          })
        }
      }

      // Base UI's high-priority alert region announces from the toast
      // OPTIONS (`title`/`description`), not from what ToastList renders —
      // without these, a screen reader sees an empty alert (a regression
      // vs. the old toast). `Toast.Title`/`Toast.Description` favor
      // explicit children over `toast.title`/`toast.description`, so
      // ToastList's own live-locale rendering is unaffected; this copy is
      // frozen to whatever `t` was current when the prompt was created.
      const { title, description } = pairRequestCopy(payload, tRef.current)

      // Matches PairRequestToastData's per-kind shape: only `cli` gets an
      // `onAllow` — an extension prompt has none to wire up. Annotated
      // explicitly (rather than inlined in the `toast.add()` call below) to
      // give the ternary's two closures a concrete expected type up front.
      const pairRequestData: PairRequestToastData['pairRequest'] =
        payload.kind === 'cli'
          ? {
              ...payload,
              onAllow: () => void settle('allow'),
              onDeny: () => void settle('deny'),
            }
          : {
              ...payload,
              onDeny: () => void settle('deny'),
            }

      toast.add({
        id: key,
        title,
        description,
        timeout: 0,
        priority: 'high',
        data: { pairRequest: pairRequestData },
        // Dismiss-as-deny: fires on the × close button, swipe-dismiss, and
        // our own programmatic `toast.close(key)` alike — the `settled`
        // guard above is what keeps the latter from double-sending.
        onClose: () => void settle('deny'),
      })
    }

    // Backend-driven lifecycle: the request reached a non-TTL terminal
    // outcome (approved, denied, or transport-aborted elsewhere) or lapsed
    // past its TTL. Either way we close without ourselves sending a deny; the
    // "no longer pending" feedback stays where it lives today — a late settle
    // attempt via `resolvePairWithFeedback`.
    const closeSilently = (key: string) => {
      const state = prompts.get(key)
      if (state) {
        if (state.settled) return
        state.settled = true
      } else {
        prompts.set(key, { settled: true })
      }
      toast.close(key)
    }

    const onPairRequested = (...args: unknown[]) => {
      present(args[0] as PairRequestPayload)
    }
    const onSettled = (...args: unknown[]) => {
      closeSilently((args[0] as PairRequestSettledPayload).key)
    }
    const onExpired = (...args: unknown[]) => {
      closeSilently((args[0] as PairRequestExpiredPayload).key)
    }

    // BridgeEvents are not part of the generic Events union — see
    // use-bridge.ts for context on this cast pattern.
    const pairRequestedChannel =
      BridgeEvents.PairRequested as unknown as EventChannel
    const settledChannel =
      BridgeEvents.PairRequestSettled as unknown as EventChannel
    const expiredChannel =
      BridgeEvents.PairRequestExpired as unknown as EventChannel

    // Subscribe BEFORE snapshotting — see the ordering note above.
    transport.on(pairRequestedChannel, onPairRequested)
    transport.on(settledChannel, onSettled)
    transport.on(expiredChannel, onExpired)

    // Guards a teardown-while-in-flight race: if the effect unmounts (or
    // re-runs) before `transport.invoke` resolves, an abandoned run must not
    // call `present()` — doing so would `toast.add({ id: key, onClose })`
    // and upsert the abandoned run's `onClose` closure over a live prompt's,
    // so a later settle would fire the stale closure instead (spurious deny
    // + wrong "unavailable" toast).
    let cancelled = false

    // Reconciles `prompts`/the toast set against the backend's own
    // bookkeeping. Called once on mount, and again on every web-transport
    // `connected` transition (Fix 2) — `present()`'s `prompts.has(key)`
    // guard makes repeat calls idempotent, so re-running this on reconnect
    // is safe even if nothing actually changed backend-side.
    const snapshot = async (): Promise<void> => {
      let raw: unknown
      try {
        raw = await transport.invoke(
          BridgeQueries.ListPendingPairRequests as unknown as QueryChannel
        )
      } catch {
        // Electron transport throws pre-preload, http-ws throws on a
        // non-ok response — either way, a live PairRequested event still
        // populates the toast; only the reload-recovery sweep for
        // already-pending requests is skipped this run (mirrors
        // use-notification-toasts.ts's mount-time engine-status check catch).
        return
      }
      if (cancelled) return
      // Defensive against a non-array reply (e.g. an unrelated stub that
      // resolves every query to `{}`) — reload recovery degrades to "no
      // prompts yet" rather than throwing.
      const list = Array.isArray(raw) ? (raw as PendingPairRequestInfo[]) : []
      for (const info of list) {
        present(toPairRequestPayload(info))
      }
    }

    void snapshot()

    // Web-only: re-snapshot on every `connected` transition to close the gap
    // described in the hook's top docstring (WS still CONNECTING/backing off
    // when `transport.on()` above registered its callback, or the broadcaster
    // dropped an event with zero connected sockets). Electron's IPC has no
    // connection lifecycle — `onConnectionChange` is undefined there, so this
    // is a no-op on desktop and the subscribe-then-snapshot ordering above is
    // what covers its (much narrower) startup race instead.
    const stopConnectionSync = transport.onConnectionChange?.((event) => {
      if (event.state === 'connected') void snapshot()
    })

    return () => {
      cancelled = true
      stopConnectionSync?.()
      transport.off(pairRequestedChannel, onPairRequested)
      transport.off(settledChannel, onSettled)
      transport.off(expiredChannel, onExpired)
    }
  }, [])
}
