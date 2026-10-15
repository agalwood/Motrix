import type {
  PairingCodeProvider,
  PairingCodeRequest,
} from '@/background/mbp1/pairing-flow'

/** A pairing-code request currently waiting on the user, for `bg.getState`'s
 *  polling UI. */
export interface PendingPairingCode {
  request: PairingCodeRequest
  /** Absolute timestamp, not a duration — so re-polling bg.getState doesn't
   *  restart the popup's own countdown. */
  deadlineMs: number
}

export interface PairingCodeSourceDeps {
  /** Injectable clock, mirroring `PairingFlowDeps.now`. Defaults to `Date.now`. */
  now?: () => number
  /**
   * Injectable deadline timer, mirroring `PairingFlowDeps.random`. Defaults to
   * the platform `setTimeout`. The handle type is deliberately `unknown` —
   * this module never inspects it, only hands it back to `clearTimeout`.
   */
  setTimeout?: (callback: () => void, ms: number) => unknown
  clearTimeout?: (handle: unknown) => void
}

export interface PairingCodeSourceHandle {
  /** Passed to `ConnectionManagerOptions.pairingCodeSource`. */
  provider: PairingCodeProvider
  /**
   * Resolves the pending provider call with `code` — `bg.submitPairingCode`'s
   * implementation. Returns `false` with no effect if nothing is pending
   * (already resolved, or the deadline already fired).
   */
  submit: (code: string) => boolean
  /** The active request, or `null` — `bg.getState`'s `pairingCode` field. */
  getPending: () => PendingPairingCode | null
}

/**
 * `PairingCodeProvider`'s contract requires it to settle within
 * `request.timeoutMs` on its own: `PairingFlow` has no way to cancel a
 * pending call, so a provider that simply waits for the popup to respond
 * would hold the session open past every deadline §6.5/§7.2 set the moment
 * the user walked away without answering. The `setTimeout` below is what
 * actually enforces that; `submit` answering before it fires is just the
 * happy path.
 *
 * Extracted out of `service-worker.ts` so this guarantee has a test —
 * a deadline enforced only inline in a file with no test coverage is a
 * guarantee nobody will notice losing to a future "simplify, the UI already
 * has a timer" edit.
 */
export function createPairingCodeSource(
  deps: PairingCodeSourceDeps = {}
): PairingCodeSourceHandle {
  const now = deps.now ?? Date.now
  // Annotated explicitly and wrapped rather than aliased directly: the
  // platform `setTimeout`/`clearTimeout` overloads are typed in terms of
  // the ambient timer handle (`number` here, `NodeJS.Timeout` under plain
  // Node types), which doesn't unify with this module's deliberately
  // opaque `unknown` handle type without a cast confined to this one spot.
  const scheduleTimeout: (callback: () => void, ms: number) => unknown =
    deps.setTimeout ?? ((callback, ms) => setTimeout(callback, ms))
  const cancelTimeout: (handle: unknown) => void =
    deps.clearTimeout ??
    ((handle) => clearTimeout(handle as Parameters<typeof clearTimeout>[0]))

  let pending: {
    request: PairingCodeRequest
    deadlineMs: number
    resolve: (code: string) => void
  } | null = null

  const provider: PairingCodeProvider = (request) =>
    new Promise<string>((resolve, reject) => {
      let timer: unknown
      const entry = {
        request,
        deadlineMs: now() + request.timeoutMs,
        resolve: (code: string) => {
          // A newer provider call owns `submit()` now. A stale resolve must
          // never cancel or clear that replacement request.
          if (pending !== entry) return
          cancelTimeout(timer)
          pending = null
          resolve(code)
        },
      }
      pending = entry
      timer = scheduleTimeout(() => {
        // Every provider still settles at its own deadline, but only the
        // currently published request may mutate the shared submit handle.
        if (pending === entry) pending = null
        reject(
          new Error(`pairing code entry timed out after ${request.timeoutMs}ms`)
        )
      }, request.timeoutMs)
    })

  return {
    provider,
    submit: (code) => {
      if (pending === null) return false
      pending.resolve(code)
      return true
    },
    getPending: () =>
      pending === null
        ? null
        : { request: pending.request, deadlineMs: pending.deadlineMs },
  }
}
