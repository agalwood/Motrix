import {
  type PairRequestToastData,
  pairRequestCopy,
  toast,
} from '@renderer/components/ui/toast'
import {
  refreshOperatorSession,
  useOperatorSession,
} from '@renderer/lib/operator-auth'
import { transport } from '@renderer/lib/transport'
import {
  BridgeCommands,
  BridgeEvents,
  BridgeQueries,
  type PairRequestExpiredPayload,
  type PairRequestPayload,
  type PairRequestSettledPayload,
  type PendingPairRequestInfo,
  pairRequestKey,
  type ResolvePairParams,
} from '@shared/protocol/bridge'
import type { CommandChannel } from '@shared/protocol/commands'
import type { EventChannel } from '@shared/protocol/events'
import type { QueryChannel } from '@shared/protocol/queries'
import { claimExtensionPairResultSchema } from '@shared/schemas/extension-pairing'
import {
  isNasAuthMode,
  supportsClientPairing,
} from '@shared/schemas/operator-auth'
import { useEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { resolvePairWithFeedback } from './pair-resolve'

/** Projects a backend-owned pending entry (from `ListPendingPairRequests`)
 *  onto the same wire shape a live `PairRequested` event carries, so both
 *  sources can flow through one `present()` path. */
function toPairRequestPayload(
  info: PendingPairRequestInfo
): PairRequestPayload {
  if (info.kind === 'extension-claim') return info
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
 * The effect subscribes when pairing is supported and never on a `t`
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
function operatorKey(
  session: ReturnType<typeof useOperatorSession.getState>
): string | undefined {
  return session.status &&
    isNasAuthMode(session.status.mode) &&
    session.status.authed
    ? `${session.epoch}:${session.status.username ?? ''}`
    : undefined
}

export function usePairRequestPrompts(): void {
  const { t } = useTranslation()
  const supported = useOperatorSession(
    (session) =>
      supportsClientPairing(session.status, 'cli') ||
      supportsClientPairing(session.status, 'extension')
  )
  const operatorIdentity = useOperatorSession(operatorKey)
  const tRef = useRef(t)
  tRef.current = t

  useEffect(() => {
    if (!supported) return
    const accountName = useOperatorSession.getState().status?.username
    const sameOperator = () =>
      operatorKey(useOperatorSession.getState()) === operatorIdentity
    // key -> lifecycle state for a prompt currently owned by this hook
    // instance. Guards three races: a duplicate `PairRequested` for a
    // live key (no-op), a double Allow/Deny click (no-op past the first),
    // and the close-button path (`onClose`, wired to a deny) firing again
    // when OUR OWN `toast.close(key)` runs after we've already settled —
    // marking `settled` before that close is what makes the second deny
    // a no-op instead of a duplicate resolve.
    const prompts = new Map<
      string,
      {
        settled: boolean
        claiming: boolean
        expires?: ReturnType<typeof setTimeout>
      }
    >()

    const present = (payload: PairRequestPayload) => {
      const key = pairRequestKey(payload)
      if (prompts.has(key)) return
      const state: {
        settled: boolean
        claiming: boolean
        expires?: ReturnType<typeof setTimeout>
      } = { settled: false, claiming: false }
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
        clearTimeout(state.expires)
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
          if (cancelled || !sameOperator() || prompts.get(key) !== state) return
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
      const claim = async () => {
        if (
          payload.kind !== 'extension-claim' ||
          cancelled ||
          !sameOperator() ||
          !accountName ||
          state.settled ||
          state.claiming
        )
          return
        state.claiming = true
        let revealed = false
        refreshClaim()
        try {
          const result = claimExtensionPairResultSchema.parse(
            await transport.invoke(
              BridgeCommands.ClaimExtensionPair as unknown as CommandChannel,
              {
                browser: payload.browser,
                extensionId: payload.extensionId,
                pairingNonce: payload.pairingNonce,
                expectedUsername: accountName,
              }
            )
          )
          if (
            cancelled ||
            state.settled ||
            prompts.get(key) !== state ||
            !sameOperator()
          )
            return
          if (!result.ok) {
            void refreshOperatorSession()
            toast.add({
              title: tRef.current(
                'settings.integration.browser.pairUnavailable'
              ),
            })
            return
          }
          const request: PairRequestToastData['pairRequest'] = {
            ...payload,
            kind: 'extension',
            accountName,
            code: result.code,
            onDeny: () => void settle('deny'),
          }
          toast.update(key, { data: { pairRequest: request } })
          revealed = true
          state.expires = setTimeout(
            () => closeSilently(key),
            result.expiresInMs
          )
        } catch {
          if (!cancelled && !state.settled)
            toast.add({
              type: 'error',
              title: tRef.current('settings.integration.pairResolveFailed'),
            })
        } finally {
          state.claiming = false
          if (!revealed) refreshClaim()
        }
      }
      const refreshClaim = () => {
        if (
          payload.kind !== 'extension-claim' ||
          cancelled ||
          state.settled ||
          !sameOperator()
        )
          return
        toast.update(key, {
          data: {
            pairRequest: {
              ...payload,
              accountName,
              claiming: state.claiming,
              onClaim: () => void claim(),
              onDeny: () => void settle('deny'),
            },
          },
        })
      }
      const pairRequestData: PairRequestToastData['pairRequest'] =
        payload.kind === 'cli'
          ? {
              ...payload,
              onAllow: () => void settle('allow'),
              onDeny: () => void settle('deny'),
            }
          : payload.kind === 'extension-claim'
            ? {
                ...payload,
                accountName,
                claiming: false,
                onClaim: () => void claim(),
                onDeny: () => void settle('deny'),
              }
            : { ...payload, onDeny: () => void settle('deny') }

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
        clearTimeout(state.expires)
        if (state.settled) return
        state.settled = true
      } else {
        prompts.set(key, { settled: true, claiming: false })
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
    let snapshotGeneration = 0

    // Reconciles `prompts`/the toast set against the backend's own
    // bookkeeping. Called once on mount, and again on every web-transport
    // `connected` transition (Fix 2) — `present()`'s `prompts.has(key)`
    // guard makes repeat calls idempotent, so re-running this on reconnect
    // is safe even if nothing actually changed backend-side.
    const snapshot = async (): Promise<void> => {
      const generation = ++snapshotGeneration
      const known = new Map(prompts)
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
      if (cancelled || generation !== snapshotGeneration || !Array.isArray(raw))
        return
      const list = raw as PendingPairRequestInfo[]
      if (operatorIdentity !== undefined) {
        const live = new Set(list.map(pairRequestKey))
        for (const [key, state] of known) {
          if (!state.settled && prompts.get(key) === state && !live.has(key))
            closeSilently(key)
        }
      }
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
      if (event.state === 'disconnected' && operatorIdentity !== undefined) {
        // A restarted package cannot honor a code from the old connection.
        // Forget local receipts without denying still-live requests on the host.
        snapshotGeneration++
        for (const key of prompts.keys()) closeSilently(key)
        prompts.clear()
      }
    })

    const refreshVisibleInbox = () => {
      if (!document.hidden) void snapshot()
    }
    if (operatorIdentity !== undefined)
      document.addEventListener('visibilitychange', refreshVisibleInbox)

    return () => {
      cancelled = true
      document.removeEventListener('visibilitychange', refreshVisibleInbox)
      stopConnectionSync?.()
      transport.off(pairRequestedChannel, onPairRequested)
      transport.off(settledChannel, onSettled)
      transport.off(expiredChannel, onExpired)
      // Losing the host capability or session must also remove visible codes.
      // This is a local teardown, not a decision to deny the server request.
      for (const [key, state] of prompts) {
        clearTimeout(state.expires)
        if (state.settled) continue
        state.settled = true
        toast.close(key)
      }
    }
  }, [supported, operatorIdentity])
}
