import { toast } from '@renderer/components/ui/toast'
import {
  ENGINE_FAILURE_TOAST_ID,
  requestEngineDiagnostics,
} from '@renderer/features/engine-diagnostics/controller'
import { resolveNotificationText } from '@renderer/lib/notification-text'
import { transport } from '@renderer/lib/transport'
import { Events } from '@shared/protocol/events'
import { Queries } from '@shared/protocol/queries'
import type { EngineStatusSnapshot } from '@shared/types/engine'
import { EngineState, engineFailureReasonKey } from '@shared/types/engine'
import type { AppNotification } from '@shared/types/notification'
import { NotificationKinds } from '@shared/types/notification'
import { useEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'

/**
 * Stable id every focused-error toast upserts through. Base UI's toast
 * manager routes an `add()` call whose `id` matches an existing toast to an
 * UPDATE (no `onClose`, no re-animation) rather than a new entry — so a
 * burst of N simultaneous task failures (each firing `NotificationAdded`)
 * collapses onto this ONE visible toast showing the latest error, instead of
 * N distinct toasts. Without this, `Toaster`'s `limit={5}` (see
 * `ui/toast.tsx`) flags the oldest-beyond-limit toasts as `data-limited`
 * (invisible + unclickable) purely by recency, with no priority weighting —
 * a burst could silently bury the pairing prompt (`timeout: 0`) into its
 * backend auto-deny, or hide the sticky engine-failure toast. The durable,
 * un-coalesced per-row history always remains available on `/notifications`.
 */
const FOCUSED_ERROR_TOAST_ID = 'notification-error'

/**
 * Focused-error toast subscriber (spec §7 boundary) that also owns the
 * sticky engine-failure diagnostic toast — formerly a separate sticky-toast
 * hook that coordinated with this one through parallel
 * `Events.EngineStateChanged` tracking. Absorbing it here removes that
 * coordination: there is now exactly one place that decides when the sticky
 * toast shows and when it closes.
 *
 * Two distinct toast surfaces share this one hook:
 *
 * 1. Generic error rows (`n.severity === 'error'`, any kind other than
 *    `engine-failure`) toast through `FOCUSED_ERROR_TOAST_ID`, gated on
 *    document foreground (see below) and coalesced via close-then-add
 *    (F9). This is the renderer half of an "exactly one track fires" split
 *    with the OS notification bridge (`src/main/notifications/os-bridge.ts`,
 *    Task 16): that bridge toasts natively only when the main window is NOT
 *    foreground (`!(win.isVisible() && win.isFocused())`); this hook toasts
 *    in-app only when the document IS foreground
 *    (`visibilityState === 'visible' && document.hasFocus()`) — the exact
 *    complement, so a given error surfaces exactly once across the two
 *    tracks, never zero times or twice.
 *
 * 2. `kind === NotificationKinds.EngineFailure` rows toast through the
 *    STICKY `ENGINE_FAILURE_TOAST_ID` instead (`timeout: 0`, with an action
 *    button that closes the toast and opens the diagnostics dialog via
 *    `requestEngineDiagnostics()`). This surface has NO foreground gate — an
 *    in-app sticky toast is inert while hidden, and the OS bridge already
 *    covers the background case for this kind — and it never coalesces
 *    with `FOCUSED_ERROR_TOAST_ID`. `Events.EngineStateChanged` closes it
 *    only on `EngineState.Ready` (auto-recovery dismissal);
 *    `Restarting`/`Failed`/others leave it up, so an incident shown during a
 *    restart storm survives the `Failed → Restarting` transitions
 *    `EngineSupervisor` produces while retrying.
 *
 * Mount also runs a ONE-SHOT `Queries.GetEngineStatus` query — ported
 * verbatim from that former hook's mount-time check — to cover a renderer
 * reload after a cold-start failure, where the engine
 * is already `EngineState.Failed` before any fresh `NotificationAdded`
 * fires: if the query reports `Failed`, it shows the same sticky toast from
 * `engineFailureReasonKey(status.failure?.reason)`.
 * `lastEngineFailureReasonKeyRef` close-then-adds only when the reason
 * CHANGES (re-animating and re-surfacing it); a repeated identical failure
 * upserts in place via `add()` alone, without replaying the animation. A
 * failed query (transport not ready yet, etc.) is swallowed — a later
 * engine event or app reload will retry it.
 *
 * Only `severity === 'error'` rows and the engine-compatibility warning toast
 * at all — `task-complete`/info rows stay silent (they still land in the bell
 * badge / `/notifications` page via `useNotifications()`).
 *
 * Mount exactly once at the top of the app tree (AppLayout), mirroring
 * `useToastEvents`/`usePairRequestPrompts`: `t` and `i18n` are threaded
 * through refs so a locale switch (which bumps their identity on every
 * `changeLanguage()` call, even to the already-current language — see
 * `usePairRequestPrompts`'s docstring) never tears down and re-subscribes
 * the transport listener.
 *
 * The generic-error track (vs. the OS bridge) gates on document/window
 * focus read at different instants — this hook at emit time, the OS bridge
 * at delivery time (post store-write) — so a focus change landing between
 * those two reads can make both fire or neither. That's an accepted
 * best-effort gap, not a bug to chase; see the OS bridge's own docstring for
 * its half of the same tradeoff.
 */
export function useNotificationToasts(): void {
  const { t, i18n } = useTranslation()
  const tRef = useRef(t)
  tRef.current = t
  const i18nRef = useRef(i18n)
  i18nRef.current = i18n
  const lastEngineFailureReasonKeyRef = useRef<string | null>(null)

  useEffect(() => {
    let cancelled = false

    const resolve = (
      key: string,
      params: Record<string, string> | null
    ): string =>
      resolveNotificationText(key, params, tRef.current, i18nRef.current.exists)

    const showStickyEngineFailureToast = (
      title: string,
      description: string | undefined
    ) => {
      toast.close(ENGINE_FAILURE_TOAST_ID)
      toast.add({
        id: ENGINE_FAILURE_TOAST_ID,
        title,
        description,
        type: 'error',
        timeout: 0,
        actionProps: {
          children: tRef.current('panel.dashboard.engine.diagnostics.open'),
          onClick: () => {
            toast.close(ENGINE_FAILURE_TOAST_ID)
            requestEngineDiagnostics()
          },
        },
      })
    }

    // Bullet 3: one-shot mount check, ported verbatim from the former
    // sticky-toast hook's showFailure.
    const checkEngineStatusOnMount = async () => {
      try {
        const status = (await transport.invoke(
          Queries.GetEngineStatus
        )) as EngineStatusSnapshot
        if (cancelled || status.state !== EngineState.Failed) return
        const reasonKey = engineFailureReasonKey(status.failure?.reason)
        if (lastEngineFailureReasonKeyRef.current !== reasonKey) {
          toast.close(ENGINE_FAILURE_TOAST_ID)
        }
        lastEngineFailureReasonKeyRef.current = reasonKey
        toast.add({
          id: ENGINE_FAILURE_TOAST_ID,
          title: tRef.current('panel.dashboard.engine.startFailed'),
          description: tRef.current(reasonKey),
          type: 'error',
          timeout: 0,
          actionProps: {
            children: tRef.current('panel.dashboard.engine.diagnostics.open'),
            onClick: () => {
              toast.close(ENGINE_FAILURE_TOAST_ID)
              requestEngineDiagnostics()
            },
          },
        })
      } catch {
        // A later engine event or app reload will retry the status query.
      }
    }

    // Bullet 2: only Ready dismisses the sticky toast; Restarting/Failed/
    // others must leave it up (an incident survives a restart storm).
    const onEngineStateChanged = (...args: unknown[]) => {
      const state = args[0] as EngineState | undefined
      if (state === EngineState.Ready) {
        toast.close(ENGINE_FAILURE_TOAST_ID)
      }
    }

    const handler = (...args: unknown[]) => {
      const n = args[0] as AppNotification
      const isCompatibilityWarning =
        n.kind === NotificationKinds.EngineCompatibility
      if (n.severity !== 'error' && !isCompatibilityWarning) return

      // Bullet 1: engine-failure rows get the sticky action-bearing toast —
      // no foreground gate, no FOCUSED_ERROR_TOAST_ID coalescing.
      if (n.kind === NotificationKinds.EngineFailure) {
        showStickyEngineFailureToast(
          resolve(n.titleKey, n.titleParams),
          n.bodyKey != null ? resolve(n.bodyKey, n.bodyParams) : undefined
        )
        return
      }

      if (document.visibilityState !== 'visible' || !document.hasFocus()) {
        return
      }
      // F9: close-then-add so a coalesced error toast re-promotes. Base
      // UI's same-id add() alone UPDATES an existing toast in place and
      // never re-runs its limit computation (applyLimited) — a
      // previously-limited (hidden behind a burst of other toasts)
      // notification-error toast would stay hidden forever while merely
      // updating. close() first forces the next add() through the
      // remove-then-reinsert path instead, which re-applies the limit and
      // puts this toast back at the front (mirrors the sticky
      // engine-failure toast above). This toast has no `onClose` handler,
      // so close() firing one here is a no-op.
      toast.close(FOCUSED_ERROR_TOAST_ID)
      toast.add({
        id: FOCUSED_ERROR_TOAST_ID,
        title: resolve(n.titleKey, n.titleParams),
        description:
          n.bodyKey != null ? resolve(n.bodyKey, n.bodyParams) : undefined,
        type: isCompatibilityWarning ? 'warning' : 'error',
      })
    }

    transport.on(Events.EngineStateChanged, onEngineStateChanged)
    transport.on(Events.NotificationAdded, handler)
    void checkEngineStatusOnMount()
    return () => {
      cancelled = true
      transport.off(Events.EngineStateChanged, onEngineStateChanged)
      transport.off(Events.NotificationAdded, handler)
    }
  }, [])
}
