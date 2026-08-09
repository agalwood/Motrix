import { transport } from '@renderer/lib/transport'
import type { EventChannel } from '@shared/protocol/events'
import { useCallback, useEffect, useRef } from 'react'

/** Bounded retry delay for a failed `load()` — one retry per generation. */
const RETRY_DELAY_MS = 500

export interface TransportMirrorOptions {
  /**
   * Transport events that invalidate the mirror; each triggers refresh().
   * Mount-captured; changes after mount are ignored.
   */
  events: readonly EventChannel[]
  /**
   * Fetch + apply. Read fresh on every call (via a ref, not mount-captured)
   * — a new `load` closure passed on a later render is always the one that
   * runs next, with no re-subscribe needed.
   *
   * MUST check `stale()` after every await before applying state; when
   * `stale()` is true the response belongs to a refresh SUPERSEDED by a
   * newer one — it is NOT an unmount signal, and `load` authors must not
   * treat it as an unmount guard (an unmounted hook simply stops scheduling
   * further work; it does not flip `stale()` for a still-in-flight call).
   */
  load: (stale: () => boolean) => Promise<void>
  /**
   * Refetch on window focus (default true). Mount-captured; changes after
   * mount are ignored.
   */
  refetchOnFocus?: boolean
  /**
   * Refetch on document visibilitychange, but only the transition INTO
   * `visible` (default false). Mount-captured; changes after mount are
   * ignored.
   */
  refetchOnVisibility?: boolean
  /**
   * One bounded retry (500 ms) when `load` throws (default true).
   * Mount-captured; changes after mount are ignored.
   */
  retryOnce?: boolean
}

export interface TransportMirrorResult {
  refresh: () => Promise<void>
}

/**
 * Shared "subscribe events -> snapshot -> stale-guard -> reconnect/focus
 * resnapshot -> bounded retry" wiring, distilled from `useNotifications`
 * (generation ref + one-retry + Changed-event subscription +
 * `onConnectionChange` + focus) and `usePendingPairRequests` (multi-event +
 * visibility) — see Tasks 9-10 for the two consumers migrated onto this.
 *
 * Subscriptions (events, connection-change, focus, visibility) are all
 * registered BEFORE the initial `load()` call (subscribe-then-snapshot), so
 * a live event firing while the first load is still in flight is never
 * missed. `options` is captured in a ref, and the setup effect body only
 * ever touches refs, so it runs exactly once (`[]` deps).
 *
 * That single effect run is also the mount/freeze line for most of
 * `options`: `events`, `refetchOnFocus`, `refetchOnVisibility`, and
 * `retryOnce` are destructured out of the ref ONCE, inside the effect body,
 * and close over those local values for the lifetime of the hook — passing
 * different values for any of them on a later render does nothing; the
 * effect never re-runs to pick them up. `load` is the one exception: it is
 * read fresh through `optionsRef.current.load` on every call, so a new
 * `load` closure on a later render is honored on the very next refresh with
 * no re-subscribe needed.
 *
 * A generation counter makes `stale()` true for any refresh superseded by
 * a newer one, so two overlapping `load()`s that resolve out of order can't
 * let the older response clobber the newer one. `stale()` is a supersession
 * check, NOT an unmount guard — `load` authors must not use it to detect
 * unmount (see `TransportMirrorOptions.load`'s doc).
 *
 * When `load` throws, exactly one retry fires after `RETRY_DELAY_MS`, scoped
 * to that refresh's generation: a second failure in a row does not schedule
 * another retry, and starting a newer refresh (any trigger) cancels a
 * still-pending retry for an older generation. Unmounting clears any
 * pending retry timer and removes every listener registered by the setup
 * effect.
 *
 * `refresh()` delegates through a ref assigned inside the setup effect, so
 * before that effect has run (e.g. a call made synchronously during the
 * first render) it is a no-op that resolves immediately — there is nothing
 * yet to delegate to.
 */
export function useTransportMirror(
  options: TransportMirrorOptions
): TransportMirrorResult {
  const optionsRef = useRef(options)
  optionsRef.current = options

  // Generation guard: subscription-driven refreshes and reconnect/focus can
  // fire in quick succession, and their `load()`s can resolve out of order.
  // Only the most-recently-ISSUED refresh's response may commit.
  const generation = useRef(0)
  const retryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  // Assigned inside the setup effect below; `refresh()` always delegates
  // through this ref so its own identity can stay stable across renders
  // without depending on the setup effect having (re)run.
  const performRefreshRef = useRef<() => Promise<void>>(() => Promise.resolve())

  const refresh = useCallback(() => performRefreshRef.current(), [])

  useEffect(() => {
    // Guards against scheduling a retry timer AFTER cleanup has already run:
    // an in-flight load() that is still pending at unmount can reject later,
    // and without this flag its catch branch would see an unchanged
    // generation (stale() only detects supersession by a NEWER refresh, not
    // unmount) and schedule a setTimeout nobody will ever clear — firing
    // load() again against an unmounted hook 500ms later.
    let disposed = false

    const clearRetryTimer = () => {
      if (retryTimerRef.current !== null) {
        clearTimeout(retryTimerRef.current)
        retryTimerRef.current = null
      }
    }

    // Mount-captured: read once here (not per-call through the ref) so the
    // whole hook has one uniform freeze line — everything except `load`
    // locks at mount.
    const {
      events,
      refetchOnFocus = true,
      refetchOnVisibility = false,
      retryOnce = true,
    } = optionsRef.current

    const runLoad = async (
      myGeneration: number,
      isRetry: boolean
    ): Promise<void> => {
      const stale = () => myGeneration !== generation.current
      try {
        await optionsRef.current.load(stale)
      } catch {
        // Bounded: only the first failure for this generation schedules a
        // retry. A second failure in a row falls back to the next live
        // event/focus/reconnect instead of retrying indefinitely.
        if (disposed || !retryOnce || stale() || isRetry) return
        clearRetryTimer()
        retryTimerRef.current = setTimeout(() => {
          retryTimerRef.current = null
          void runLoad(myGeneration, true)
        }, RETRY_DELAY_MS)
      }
    }

    const performRefresh = (): Promise<void> => {
      const myGeneration = ++generation.current
      clearRetryTimer()
      return runLoad(myGeneration, false)
    }
    performRefreshRef.current = performRefresh

    // Deduped once and reused for both subscribe and cleanup — a caller
    // that lists the same channel twice (e.g. composed from more than one
    // source) must not double-subscribe transport.on/off.
    const dedupedEvents = [...new Set(events)]

    const onEvent = () => {
      void performRefresh()
    }

    // Only refetch on the transition INTO `visible` — a hidden-tab refetch
    // is a wasted round-trip, and this freezes that semantics for future
    // consumers rather than leaving it to each caller to re-derive.
    const onVisibilityChange = () => {
      if (document.visibilityState === 'visible') void performRefresh()
    }

    for (const event of dedupedEvents) transport.on(event, onEvent)

    const removeConnectionListener =
      transport.onConnectionChange?.((connectionEvent) => {
        if (connectionEvent.state === 'connected') void performRefresh()
      }) ?? null

    if (refetchOnFocus) window.addEventListener('focus', onEvent)
    if (refetchOnVisibility) {
      document.addEventListener('visibilitychange', onVisibilityChange)
    }

    void performRefresh()

    return () => {
      disposed = true
      for (const event of dedupedEvents) transport.off(event, onEvent)
      removeConnectionListener?.()
      if (refetchOnFocus) window.removeEventListener('focus', onEvent)
      if (refetchOnVisibility) {
        document.removeEventListener('visibilitychange', onVisibilityChange)
      }
      clearRetryTimer()
    }
  }, [])

  return { refresh }
}
