import type { BridgeEventBus } from '@core/bridge/bridge-event-bus'
import type { IdentityTriState as CoreIdentityTriState } from '@core/bridge/credential-store'
import type {
  PairDialogHandle,
  PairDialogRequest,
} from '@core/bridge/mbp1/pair-session'
import {
  type PendingPairRequestInfo,
  pairRequestKey,
  type ResolvePairParams,
  type ResolvePairResult,
  type IdentityTriState as SharedIdentityTriState,
} from '@shared/protocol/bridge'
import type { BrowserWindow } from 'electron'

// Drift guard (progress.md:155): `SharedIdentityTriState` is a renderer-safe
// literal copy of core's `IdentityTriState` — duplicated because the
// renderer must not import `@core/`. This module is the one place that
// assigns a value of one into the other (below, building the renderer
// payload), so the bidirectional assignability check lives here. Never
// called — a real call would need a live `IdentityTriState` value this file
// has no reason to fabricate — so it costs nothing at runtime; its only job
// is that `tsc` rejects it if either union ever widens without the other.
function _assertIdentityTriStateParity(): void {
  const core: CoreIdentityTriState = null as never
  const shared: SharedIdentityTriState = core
  const backToCore: CoreIdentityTriState = shared
  void backToCore
}
void _assertIdentityTriStateParity

/** Renderer-safe request metadata for {@link PairingDialogController.listPending},
 *  minus the createdAt/expiresAt which the entry already tracks separately. */
type ExtensionPairRequestPayload = Omit<
  Extract<PendingPairRequestInfo, { kind: 'extension' }>,
  'createdAt' | 'expiresAt'
>

interface PendingRequest {
  payload: ExtensionPairRequestPayload
  /** Idempotent teardown: resolves `dismissed`, drops the origin's dedup
   *  entry, clears the timer, and emits `PairRequestExpired` — but only on
   *  its FIRST call. Shared by the timeout, an explicit `settle()`, and the
   *  `PairDialogHandle.close()` a `PairSession` calls on its own teardown, so
   *  whichever fires first is the one that actually tears down. */
  close: () => void
  createdAt: number
  expiresAt: number
}

/**
 * How long the desktop dialog stays open before auto-closing. Matches §7.2's
 * pairing-code lifetime (`CODE_LIFETIME_MS` in `mbp1/pair-session.ts`, not
 * exported — this is a deliberately independent constant, not a shared one):
 * the code the dialog displays stops being usable at exactly this point, so
 * there is nothing left to keep the prompt open for.
 */
const PROMPT_TIMEOUT_MS = 120_000

export class PairingDialogController {
  private pending = new Map<string, PendingRequest>()
  /**
   * Dedup keyed on the verified origin (§5), never on `claimedExtensionId`:
   * on Firefox the claimed id is self-reported, so keying on it would let one
   * extension suppress another's prompt by claiming its id. Presence means
   * "a prompt is currently open for this origin" — cleared the moment that
   * prompt settles by ANY outcome (success, dismiss, or timeout), not after a
   * cooldown window. There is deliberately no dedup timestamp: a window would
   * either be shorter than §7.2's 120s code lifetime (letting a second
   * legitimate attempt in) or longer (reintroducing the old "forget + re-pair
   * is silently denied" regression, and worse — invisibly, since there is no
   * deny event to explain it).
   */
  private openOrigins = new Set<string>()

  constructor(
    private bus: BridgeEventBus,
    private getMainWindow: () => BrowserWindow | null
  ) {}

  /**
   * Show the §7.1 approval dialog for a `/pair` session that reached
   * `pairHello`. Error-free by construction — §7.3 admission (core's
   * `PairFloodControl`) already ran before this is called, so the only
   * refusal this method can make is its own per-origin dedup, and it reports
   * that as an immediate dismissal (an already-resolved `dismissed`) rather
   * than hanging: `PairSession` treats a resolved `dismissed` as a clean user
   * dismissal, whereas a handle that never resolves would hold a §7.3
   * pending slot for the full 150s pre-auth deadline.
   */
  queueMbp1Prompt(args: PairDialogRequest): PairDialogHandle {
    if (this.openOrigins.has(args.verifiedOrigin)) {
      return { dismissed: Promise.resolve(), close: () => {} }
    }
    this.openOrigins.add(args.verifiedOrigin)

    const payload: ExtensionPairRequestPayload = {
      kind: 'extension',
      pairingNonce: args.pairingNonce,
      extensionId: args.claimedExtensionId,
      browser: args.browser,
      identity: args.identity,
      code: args.code,
    }
    const key = pairRequestKey(payload)
    const createdAt = Date.now()
    const expiresAt = createdAt + PROMPT_TIMEOUT_MS

    let resolveDismissed!: () => void
    const dismissed = new Promise<void>((resolve) => {
      resolveDismissed = resolve
    })

    let closed = false
    const close = (): void => {
      if (closed) return
      closed = true
      clearTimeout(timer)
      this.pending.delete(key)
      this.openOrigins.delete(args.verifiedOrigin)
      resolveDismissed()
      // A machine-side teardown (session confirmed, session aborted, or this
      // prompt's own timeout) is never a user denial — `denied` must mean the
      // user denied and nothing else, or the approval inbox would lie about
      // why a prompt disappeared. The renderer already treats `expired` as
      // "remove this entry", regardless of which of those three caused it.
      this.bus.emitPairRequestExpired({ key })
    }
    const timer = setTimeout(close, PROMPT_TIMEOUT_MS)

    this.pending.set(key, { payload, close, createdAt, expiresAt })
    this.bus.emitPairRequested(payload)
    const win = this.getMainWindow()
    if (win) {
      if (win.isMinimized()) win.restore()
      win.focus()
    }

    return { dismissed, close }
  }

  /**
   * Explicit dismiss path for the renderer's ResolvePair command (the user
   * closed the prompt). Under MBP1 there is no allow/deny decision to make
   * here — approval is proven by typing the code into the extension, not by
   * a click in this dialog — so this only resolves the pending `dismissed`
   * promise, which `PairSession` observes as an abort. An unknown key —
   * already settled, already expired, or never requested — returns
   * `{ ok: false, reason: 'unavailable' }` and emits nothing: this method
   * must NEVER report apparent success for a request that didn't actually
   * land anywhere (a duplicate settle call is therefore a no-op on the
   * second call).
   */
  settle(
    params: Extract<ResolvePairParams, { kind: 'extension' }>
  ): ResolvePairResult {
    const key = pairRequestKey(params)
    const p = this.pending.get(key)
    if (!p) return { ok: false, reason: 'unavailable' }
    p.close()
    return { ok: true }
  }

  /** Snapshot of every currently-pending extension `/pair` prompt, for the
   *  approval inbox. Renderer-safe: token-free by construction, and the
   *  pairing code is never logged (§7.1) — only ever sent to the renderer. */
  listPending(): PendingPairRequestInfo[] {
    return [...this.pending.values()].map((p) => ({
      ...p.payload,
      createdAt: p.createdAt,
      expiresAt: p.expiresAt,
    }))
  }

  /** Settle every pending prompt before the bridge request drain begins, so
   *  no `PairSession` awaits a `dismissed` that will never resolve across a
   *  bridge restart. */
  dispose(): void {
    for (const pending of [...this.pending.values()]) {
      pending.close()
    }
    this.pending.clear()
    this.openOrigins.clear()
  }
}
