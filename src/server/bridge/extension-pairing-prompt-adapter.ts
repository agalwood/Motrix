import type { BridgeEventBus } from '@core/bridge/bridge-event-bus'
import type { PairDialogRequest } from '@core/bridge/mbp1/pair-session'
import {
  type PairingPromptCallbackReceipt,
  PairingPromptController,
  type PairingPromptControllerOptions,
  type PairingPromptEnqueueResult,
  type PairingPromptSnapshot,
  type PairingPromptTerminalEvent,
} from '@core/bridge/pairing-prompt-controller'
import {
  type PendingPairRequestInfo,
  pairRequestKey,
  type ResolvePairParams,
  type ResolvePairResult,
} from '@shared/protocol/bridge'

type ExtensionPairRequestPayload = Omit<
  Extract<PendingPairRequestInfo, { kind: 'extension' }>,
  'createdAt' | 'expiresAt'
>

interface ServerExtensionPairingPromptAdapterOptions
  extends Pick<
    PairingPromptControllerOptions,
    'maxPending' | 'timeSource' | 'ttlMs'
  > {
  /** Canonical public WS/WSS Host authority from the parser-issued config. */
  publicAuthority?: string
}

/**
 * Server-shell projection of the host-neutral MBP1 prompt controller.
 *
 * The caller must connect `bus` only to the authenticated operator control
 * plane. Enqueue publication is synchronous: returning `delivered` means the
 * code-bearing event has been committed to that in-process channel before the
 * PairSession is allowed to continue. Terminal events are always code-free.
 */
export class ServerExtensionPairingPromptAdapter {
  private readonly promptIdsByKey = new Map<string, string>()
  private readonly keysByPromptId = new Map<string, string>()
  private readonly prompts: PairingPromptController

  constructor(
    private readonly bus: BridgeEventBus,
    private readonly options: ServerExtensionPairingPromptAdapterOptions = {}
  ) {
    this.prompts = new PairingPromptController({
      ...options,
      onEnqueued: (snapshot) => this.publish(snapshot),
      onTerminal: (event) => this.publishTerminal(event),
    })
  }

  queueMbp1Prompt(request: PairDialogRequest): PairingPromptEnqueueResult {
    return this.prompts.enqueue(request)
  }

  /** Extension operator actions are deny-only; PAKE code entry is approval. */
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
      throw new Error('server pairing prompt adapter key collision')
    }
    this.promptIdsByKey.set(key, snapshot.promptId)
    this.keysByPromptId.set(snapshot.promptId, key)
    this.bus.emitPairRequested(payload)
    return 'delivered'
  }

  private publishTerminal(
    event: PairingPromptTerminalEvent
  ): PairingPromptCallbackReceipt {
    const key = this.keysByPromptId.get(event.promptId)
    if (key === undefined) return 'delivered'
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
      verifiedOrigin: snapshot.verifiedIdentity.verifiedOrigin,
      originHost: snapshot.verifiedIdentity.originHost,
      claimedExtensionId: snapshot.claimedExtensionId,
      attestationClass: snapshot.identity,
      ...(this.options.publicAuthority === undefined
        ? {}
        : { publicAuthority: this.options.publicAuthority }),
    }
  }
}
