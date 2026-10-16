import type { BridgeEventBus } from '@core/bridge/bridge-event-bus'
import type { IdentityTriState as CoreIdentityTriState } from '@core/bridge/credential-store'
import type { PairDialogRequest } from '@core/bridge/mbp1/pair-session'
import {
  type PairingPromptCallbackReceipt,
  PairingPromptController,
  type PairingPromptEnqueueResult,
  type PairingPromptSnapshot,
  type PairingPromptTerminalEvent,
} from '@core/bridge/pairing-prompt-controller'
import {
  type PendingPairRequestInfo,
  pairRequestKey,
  type ResolvePairParams,
  type ResolvePairResult,
  type IdentityTriState as SharedIdentityTriState,
} from '@shared/protocol/bridge'
import type { BrowserWindow } from 'electron'

// `SharedIdentityTriState` is a renderer-safe literal copy of core's union.
// This is the one layer that maps between them, so keep the drift guard here.
function _assertIdentityTriStateParity(): void {
  const core: CoreIdentityTriState = null as never
  const shared: SharedIdentityTriState = core
  const backToCore: CoreIdentityTriState = shared
  void backToCore
}
void _assertIdentityTriStateParity

type ExtensionPairRequestPayload = Omit<
  Extract<PendingPairRequestInfo, { kind: 'extension' }>,
  'createdAt' | 'expiresAt'
>

/**
 * Electron-only projection of the host-neutral prompt controller.
 *
 * Core owns TTL, capacity, verified-Origin dedup, and the terminal state
 * machine. This adapter owns only renderer DTOs, window focus, and the stable
 * renderer key <-> opaque core prompt id mapping. The pairing code crosses
 * this layer only in PairRequested/listPending payloads; terminal events are
 * code-free.
 */
export class PairingDialogController {
  private readonly promptIdsByKey = new Map<string, string>()
  private readonly keysByPromptId = new Map<string, string>()
  private readonly prompts: PairingPromptController

  constructor(
    private readonly bus: BridgeEventBus,
    private readonly getMainWindow: () => BrowserWindow | null
  ) {
    this.prompts = new PairingPromptController({
      onEnqueued: (snapshot) => this.publish(snapshot),
      onTerminal: (event) => this.publishTerminal(event),
    })
  }

  queueMbp1Prompt(args: PairDialogRequest): PairingPromptEnqueueResult {
    return this.prompts.enqueue(args)
  }

  /**
   * The extension operator action is denial only. Approval is still proven by
   * entering the PAKE code in the extension, never by clicking in Motrix.
   */
  settle(
    params: Extract<ResolvePairParams, { kind: 'extension' }>
  ): ResolvePairResult {
    const promptId = this.promptIdsByKey.get(pairRequestKey(params))
    if (promptId === undefined) {
      return { ok: false, reason: 'unavailable' }
    }

    const result = this.prompts.deny(promptId)
    return result.ok && result.outcome === 'denied'
      ? { ok: true }
      : { ok: false, reason: 'unavailable' }
  }

  listPending(): PendingPairRequestInfo[] {
    return this.prompts.snapshot().map((snapshot) => ({
      ...this.toPayload(snapshot),
      createdAt: snapshot.createdAt,
      expiresAt: snapshot.expiresAt,
    }))
  }

  /** Abort every live prompt and drain code-free terminal callbacks. */
  dispose(): Promise<void> {
    return this.prompts.dispose()
  }

  private publish(
    snapshot: PairingPromptSnapshot
  ): PairingPromptCallbackReceipt {
    const payload = this.toPayload(snapshot)
    const key = pairRequestKey(payload)
    if (
      this.promptIdsByKey.has(key) ||
      this.keysByPromptId.has(snapshot.promptId)
    ) {
      throw new Error('pairing prompt adapter key collision')
    }

    this.promptIdsByKey.set(key, snapshot.promptId)
    this.keysByPromptId.set(snapshot.promptId, key)
    this.bus.emitPairRequested(payload)

    // Delivery commits at the synchronous renderer event above. Window
    // ergonomics are best-effort and must never turn an already-visible code
    // into `failed` (which would abort PairSession and undercount flood
    // control). Each Electron call is isolated so one broken operation does
    // not suppress the others.
    let win: BrowserWindow | null
    try {
      win = this.getMainWindow()
    } catch {
      return 'delivered'
    }
    if (win === null) return 'delivered'
    try {
      if (win.isMinimized()) win.restore()
    } catch {
      // The renderer event is already committed; focus remains worth trying.
    }
    try {
      win.focus()
    } catch {
      // Best-effort window focus is outside the publication receipt boundary.
    }
    return 'delivered'
  }

  private publishTerminal(
    event: PairingPromptTerminalEvent
  ): PairingPromptCallbackReceipt {
    const key = this.keysByPromptId.get(event.promptId)
    if (key === undefined) {
      return 'delivered'
    }
    this.keysByPromptId.delete(event.promptId)
    this.promptIdsByKey.delete(key)

    switch (event.outcome) {
      case 'paired':
        this.bus.emitPairRequestSettled({ key, outcome: 'allowed' })
        break
      case 'denied':
        this.bus.emitPairRequestSettled({ key, outcome: 'denied' })
        break
      case 'expired':
        this.bus.emitPairRequestExpired({ key })
        break
      case 'aborted':
        this.bus.emitPairRequestSettled({ key, outcome: 'aborted' })
        break
    }
    return 'delivered'
  }

  private toPayload(
    snapshot: PairingPromptSnapshot
  ): ExtensionPairRequestPayload {
    return {
      kind: 'extension',
      pairingNonce: snapshot.pairingNonce,
      extensionId: snapshot.claimedExtensionId,
      browser: snapshot.verifiedIdentity.browser,
      identity: snapshot.identity,
      code: snapshot.code,
    }
  }
}
