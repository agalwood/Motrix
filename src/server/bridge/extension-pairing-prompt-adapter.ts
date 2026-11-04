import type { BridgeEventBus } from '@core/bridge/bridge-event-bus'
import type {
  PairCredentialIssuer,
  PairDialogRequest,
} from '@core/bridge/mbp1/pair-session'
import {
  type PairingPromptCallbackReceipt,
  PairingPromptController,
  type PairingPromptControllerOptions,
  type PairingPromptEnqueueResult,
  type PairingPromptSnapshot,
  type PairingPromptTerminalEvent,
} from '@core/bridge/pairing-prompt-controller'
import {
  type PairRequestPayload,
  type PendingPairRequestInfo,
  pairRequestKey,
  type ResolvePairParams,
  type ResolvePairResult,
} from '@shared/protocol/bridge'
import type {
  ClaimExtensionPairParams,
  ClaimExtensionPairResult,
} from '@shared/schemas/extension-pairing'
import type {
  NasExtensionApproval,
  NasExtensionAudience,
  NasExtensionBindings,
} from '../platform/nas/extension-bindings'
import { currentNasApprover } from '../platform/nas/identity'

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
  nasBindings?: NasExtensionBindings
}

interface NasClaim {
  approval: NasExtensionApproval
  issuer: PairCredentialIssuer
  audience: NasExtensionAudience
  proven: boolean
}

/**
 * Server-shell projection of the host-neutral MBP1 prompt controller.
 *
 * The caller must connect `bus` only to the authenticated operator control
 * plane. Enqueue publication is synchronous: returning `delivered` means the
 * code has been committed to the operator channel or, for NAS, a private inbox
 * that requires an explicit account claim. Only code-free metadata is broadcast
 * in NAS mode. Terminal events are always code-free.
 */
export class ServerExtensionPairingPromptAdapter {
  private readonly promptIdsByKey = new Map<string, string>()
  private readonly keysByPromptId = new Map<string, string>()
  private readonly prompts: PairingPromptController
  private readonly claims = new Map<string, NasClaim>()
  private readonly claiming = new Set<string>()

  constructor(
    private readonly bus: BridgeEventBus,
    private readonly options: ServerExtensionPairingPromptAdapterOptions = {}
  ) {
    this.prompts = new PairingPromptController({
      maxPending: options.maxPending,
      ttlMs: options.ttlMs,
      timeSource: options.timeSource,
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
      ...this.publicPayload(snapshot),
      createdAt: snapshot.createdAt,
      expiresAt: snapshot.expiresAt,
    }))
  }

  async claim(
    params: ClaimExtensionPairParams
  ): Promise<ClaimExtensionPairResult> {
    const bindings = this.options.nasBindings
    const unavailable = { ok: false, reason: 'unavailable' } as const
    if (!bindings || currentNasApprover()?.username !== params.expectedUsername)
      return unavailable
    const promptId = this.promptIdsByKey.get(
      pairRequestKey({ ...params, kind: 'extension' })
    )
    if (!promptId || this.claiming.has(promptId)) return unavailable
    const snapshot = this.live(promptId)
    if (!snapshot) return unavailable
    this.claiming.add(promptId)
    let claim = this.claims.get(promptId)
    try {
      if (claim) {
        if (!(await bindings.approvedByCurrentOperator(claim.approval)))
          return unavailable
      } else {
        const audience = this.audience(snapshot)
        const approval = await bindings.approve(audience)
        if (!this.live(promptId)) {
          bindings.release(approval)
          return unavailable
        }
        claim = {
          approval,
          issuer: bindings.issuer(approval, audience),
          audience,
          proven: false,
        }
        this.claims.set(promptId, claim)
      }
      const current = this.live(promptId)
      if (!current || this.claims.get(promptId) !== claim) return unavailable
      const remaining =
        current.expiresAt - (this.options.timeSource?.now() ?? Date.now())
      if (remaining <= 0) return unavailable
      return {
        ok: true,
        code: current.code,
        expiresInMs: Math.min(120_000, remaining),
      }
    } catch {
      return unavailable
    } finally {
      this.claiming.delete(promptId)
    }
  }

  /** Created before pairHello; ownership is resolved only after PAKE proves the
   * code displayed by the matching, explicitly claimed operator request. */
  issuerFor(audience: NasExtensionAudience): {
    issuer: PairCredentialIssuer
    release: () => void
  } {
    let captured: NasClaim | undefined
    let released = false
    const find = () =>
      [...this.claims].find(
        ([, claim]) =>
          claim.audience.pairingNonce === audience.pairingNonce &&
          claim.audience.browser === audience.browser &&
          claim.audience.verifiedOrigin === audience.verifiedOrigin
      )
    const lookup = () => {
      const entry = released ? undefined : find()
      if (!entry?.[1].proven)
        throw new Error('NAS extension request is not claimed')
      return entry[1]
    }
    const release = () => {
      if (released) return
      released = true
      const entry = find()
      if (entry) this.releaseClaim(entry[0])
      captured = undefined
    }
    return {
      release,
      issuer: {
        offerProvisional: (principal, identity) => {
          captured = lookup()
          return captured.issuer.offerProvisional(principal, identity)
        },
        commitFromPair: async (credentialId) => {
          try {
            const current = lookup()
            if (!captured || captured !== current)
              throw new Error('NAS extension claim changed')
            await current.issuer.commitFromPair(credentialId)
          } finally {
            release()
          }
        },
      },
    }
  }

  private live(promptId: string): PairingPromptSnapshot | undefined {
    return this.prompts.snapshot().find((entry) => entry.promptId === promptId)
  }

  private audience(snapshot: PairingPromptSnapshot): NasExtensionAudience {
    return {
      browser: snapshot.verifiedIdentity.browser,
      verifiedOrigin: snapshot.verifiedIdentity.verifiedOrigin,
      pairingNonce: snapshot.pairingNonce,
    }
  }

  async dispose(): Promise<void> {
    await this.prompts.dispose()
    for (const promptId of this.claims.keys()) this.releaseClaim(promptId)
  }

  private releaseClaim(promptId: string): void {
    const claim = this.claims.get(promptId)
    if (!claim) return
    this.options.nasBindings?.release(claim.approval)
    this.claims.delete(promptId)
  }

  private publish(
    snapshot: PairingPromptSnapshot
  ): PairingPromptCallbackReceipt {
    const payload = this.publicPayload(snapshot)
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
    const claim = this.claims.get(event.promptId)
    if (claim) {
      // PAKE closes the code prompt BEFORE the durable credential exchange.
      // The socket's issuance scope retains only approval, never the code.
      // It is released on commit, socket close, or runtime disposal.
      if (event.outcome === 'paired') claim.proven = true
      else this.releaseClaim(event.promptId)
    }
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

  private publicPayload(snapshot: PairingPromptSnapshot): PairRequestPayload {
    if (!this.options.nasBindings) return this.toPayload(snapshot)
    // Never spread a code-bearing snapshot into a broadcast or shared inbox.
    return {
      kind: 'extension-claim',
      pairingNonce: snapshot.pairingNonce,
      extensionId: snapshot.claimedExtensionId,
      browser: snapshot.verifiedIdentity.browser,
      identity: snapshot.identity,
      verifiedOrigin: snapshot.verifiedIdentity.verifiedOrigin,
      originHost: snapshot.verifiedIdentity.originHost,
      claimedExtensionId: snapshot.claimedExtensionId,
      attestationClass: snapshot.identity,
      publicAuthority: this.options.publicAuthority,
      createdAt: snapshot.createdAt,
      expiresAt: snapshot.expiresAt,
    }
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
