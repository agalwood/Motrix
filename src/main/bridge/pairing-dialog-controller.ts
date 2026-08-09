import type { BridgeEventBus } from '@core/bridge/bridge-event-bus'
import type {
  PairDecision,
  PairRequestArgs,
} from '@core/bridge/web-socket-bridge-server'
import {
  type PendingPairRequestInfo,
  pairRequestKey,
  type ResolvePairParams,
  type ResolvePairResult,
} from '@shared/protocol/bridge'
import type { BrowserWindow } from 'electron'

/** Renderer-safe request metadata for {@link PairingDialogController.listPending},
 *  minus the createdAt/expiresAt which the entry already tracks separately. */
type ExtensionPairRequestPayload = Omit<
  Extract<PendingPairRequestInfo, { kind: 'extension' }>,
  'createdAt' | 'expiresAt'
>

interface PendingRequest {
  payload: ExtensionPairRequestPayload
  resolve: (decision: PairDecision) => void
  timer: NodeJS.Timeout
  createdAt: number
  expiresAt: number
}

const PROMPT_DEDUP_MS = 60_000
const PROMPT_TIMEOUT_MS = 60_000 // independent of dedup; auto-denies pending prompts

export class PairingDialogController {
  private pending = new Map<string, PendingRequest>()
  private lastPromptAt = new Map<string, number>()

  constructor(
    private bus: BridgeEventBus,
    private getMainWindow: () => BrowserWindow | null
  ) {}

  async requestDecision(
    args: PairRequestArgs,
    pairingNonce: string
  ): Promise<PairDecision> {
    const dedupKey = `${args.browser}:${args.extensionId}`
    const now = Date.now()
    const last = this.lastPromptAt.get(dedupKey) ?? 0
    if (now - last < PROMPT_DEDUP_MS) {
      return { decision: 'deny', addToRegistry: false }
    }
    this.lastPromptAt.set(dedupKey, now)

    const payload: ExtensionPairRequestPayload = {
      kind: 'extension',
      pairingNonce,
      extensionId: args.extensionId,
      extensionName: args.extensionName,
      extensionVersion: args.extensionVersion,
      browser: args.browser,
    }
    const key = pairRequestKey(payload)
    const createdAt = now
    const expiresAt = createdAt + PROMPT_TIMEOUT_MS
    return new Promise<PairDecision>((resolve) => {
      // Wrap resolve to drop the dedup entry on an explicit allow: once
      // the user has established trust with this extension, a subsequent
      // "forget pair token + re-pair" (or any other path that legitimately
      // re-runs /pair) must not be silently denied by the anti-spam window.
      // Deny / timeout paths intentionally keep the dedup entry so a
      // denying user is not re-prompted within PROMPT_DEDUP_MS.
      const onSettled = (decision: PairDecision): void => {
        if (decision.decision === 'allow') {
          this.lastPromptAt.delete(dedupKey)
        }
        resolve(decision)
      }
      const timer = setTimeout(() => {
        const p = this.pending.get(key)
        if (p) {
          this.pending.delete(key)
          p.resolve({ decision: 'deny', addToRegistry: false })
          this.bus.emitPairRequestExpired({ key })
        }
      }, PROMPT_TIMEOUT_MS)
      this.pending.set(key, {
        payload,
        resolve: onSettled,
        timer,
        createdAt,
        expiresAt,
      })
      this.bus.emitPairRequested(payload)
      const win = this.getMainWindow()
      if (win) {
        if (win.isMinimized()) win.restore()
        win.focus()
      }
    })
  }

  /**
   * Explicit settle path for the renderer's ResolvePair command. Resolves the
   * blocked `/pair` promise, clears the timeout, and emits
   * `PairRequestSettled`. An unknown key — already settled, already expired,
   * or never requested — returns `{ ok: false, reason: 'unavailable' }` and
   * emits nothing: this method must NEVER report apparent success for a
   * decision that didn't actually land anywhere (a duplicate settle call is
   * therefore a no-op on the second call).
   */
  settle(
    params: Extract<ResolvePairParams, { kind: 'extension' }>
  ): ResolvePairResult {
    const key = pairRequestKey(params)
    const p = this.pending.get(key)
    if (!p) return { ok: false, reason: 'unavailable' }
    this.pending.delete(key)
    clearTimeout(p.timer)
    p.resolve({
      decision: params.decision,
      addToRegistry: params.addToRegistry,
    })
    this.bus.emitPairRequestSettled({
      key,
      outcome: params.decision === 'allow' ? 'allowed' : 'denied',
    })
    return { ok: true }
  }

  /** Snapshot of every currently-pending extension `/pair` prompt, for the
   *  approval inbox. Renderer-safe: token-free by construction (there is no
   *  token yet — the prompt is still awaiting a decision). */
  listPending(): PendingPairRequestInfo[] {
    return [...this.pending.values()].map((p) => ({
      ...p.payload,
      createdAt: p.createdAt,
      expiresAt: p.expiresAt,
    }))
  }

  /** Settle every pending prompt before the bridge request drain begins. */
  dispose(): void {
    for (const [key, pending] of this.pending) {
      clearTimeout(pending.timer)
      pending.resolve({ decision: 'deny', addToRegistry: false })
      this.bus.emitPairRequestExpired({ key })
    }
    this.pending.clear()
    this.lastPromptAt.clear()
  }
}
