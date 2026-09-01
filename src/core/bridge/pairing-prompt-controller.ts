import { randomUUID } from 'node:crypto'
import type { PairDialogRequest } from './mbp1/pair-session'

export const PairingPromptTerminalOutcomes = Object.freeze({
  Paired: 'paired',
  Denied: 'denied',
  Expired: 'expired',
  Aborted: 'aborted',
} as const)

export type PairingPromptTerminalOutcome =
  (typeof PairingPromptTerminalOutcomes)[keyof typeof PairingPromptTerminalOutcomes]

export type PairingPromptSessionOutcome = Extract<
  PairingPromptTerminalOutcome,
  'paired' | 'aborted'
>

export type PairingPromptCallbackStatus =
  | 'delivered'
  | 'failed'
  | 'not-configured'

/**
 * Synchronous receipt returned only after a trusted in-repo shell adapter has
 * committed an event to its authenticated operator channel. Promise/thenable
 * publishers are outside this contract and are classified as `failed`
 * immediately; the controller never awaits them. Once arbitrary JavaScript
 * has received the snapshot, its own out-of-contract side effects cannot be
 * revoked by the controller.
 */
export type PairingPromptCallbackReceipt = Exclude<
  PairingPromptCallbackStatus,
  'not-configured'
>

export interface VerifiedPairingPromptIdentity {
  readonly browser: PairDialogRequest['browser']
  readonly verifiedOrigin: string
  readonly originHost: string
}

/**
 * In-memory operator projection for one pending prompt.
 *
 * `code` is the MBP1 PAKE password. It may be delivered only through an
 * authenticated shell adapter and must never be logged, persisted, placed in
 * a URL, or copied into a terminal event.
 */
export interface PairingPromptSnapshot {
  readonly promptId: string
  readonly verifiedIdentity: VerifiedPairingPromptIdentity
  readonly claimedExtensionId: string
  readonly identity: PairDialogRequest['identity']
  readonly pairingNonce: string
  readonly code: string
  readonly createdAt: number
  readonly expiresAt: number
}

/** Tokenless terminal event. Deliberately excludes the pairing code. */
export interface PairingPromptTerminalEvent {
  readonly promptId: string
  readonly verifiedIdentity: VerifiedPairingPromptIdentity
  readonly outcome: PairingPromptTerminalOutcome
}

export type PairingPromptCallbackFailure =
  | { readonly phase: 'enqueue' }
  | {
      readonly phase: 'terminal'
      readonly outcome: PairingPromptTerminalOutcome
    }

export interface PairingPromptTimeSource {
  now(): number
  /** Schedule once and return an idempotent cancellation callback. */
  schedule(callback: () => void, delayMs: number): () => void
}

export interface PairingPromptControllerOptions {
  /** Pairing-code/prompt lifetime. Default 120 seconds. */
  ttlMs?: number
  /** Global in-memory pending cap. Default 3. */
  maxPending?: number
  timeSource?: PairingPromptTimeSource
  /**
   * Code-bearing callback for an authenticated shell adapter only. It must
   * synchronously commit delivery and return its receipt; Promise returns are
   * a contract failure and are never awaited.
   */
  onEnqueued?: (prompt: PairingPromptSnapshot) => PairingPromptCallbackReceipt
  /**
   * Code-free callback for operator/UI lifecycle bookkeeping. It follows the
   * same synchronous receipt contract so controller disposal is bounded.
   */
  onTerminal?: (
    event: PairingPromptTerminalEvent
  ) => PairingPromptCallbackReceipt
  /** Receives a fixed, secret-free failure marker. */
  onCallbackFailure?: (
    failure: PairingPromptCallbackFailure
  ) => void | Promise<void>
}

export interface PairingPromptHandle {
  readonly promptId: string
  /** Whether the shell adapter accepted the code-bearing enqueue callback. */
  readonly published: Promise<PairingPromptCallbackStatus>
  /** Resolves exactly once and never rejects. */
  readonly terminal: Promise<PairingPromptTerminalOutcome>
  /** PairSession-owned outcomes only; operator denial uses controller.deny. */
  settle(outcome: PairingPromptSessionOutcome): PairingPromptSettleResult
}

export type PairingPromptEnqueueResult =
  | { readonly ok: true; readonly handle: PairingPromptHandle }
  | {
      readonly ok: false
      readonly reason:
        | 'duplicate'
        | 'capacity'
        | 'disposed'
        | 'invalid-origin'
        | 'scheduling-failed'
    }

export type PairingPromptSettleResult =
  | {
      readonly ok: true
      readonly outcome: PairingPromptTerminalOutcome
    }
  | { readonly ok: false; readonly reason: 'unavailable' }

interface PendingPrompt {
  readonly snapshot: PairingPromptSnapshot
  readonly identityKey: string
  readonly terminal: Promise<PairingPromptTerminalOutcome>
  readonly resolveTerminal: (outcome: PairingPromptTerminalOutcome) => void
  cancelTimer: () => void
  published: Promise<PairingPromptCallbackStatus>
}

const DEFAULT_TTL_MS = 120_000
const DEFAULT_MAX_PENDING = 3
const MAX_RETAINED_CALLBACK_FAILURES = 100

const DEFAULT_TIME_SOURCE: PairingPromptTimeSource = Object.freeze({
  now: () => Date.now(),
  schedule: (callback: () => void, delayMs: number) => {
    const timer = setTimeout(callback, delayMs)
    timer.unref?.()
    let cancelled = false
    return () => {
      if (cancelled) return
      cancelled = true
      clearTimeout(timer)
    }
  },
})

function frozenUnavailable(): PairingPromptSettleResult {
  return Object.freeze({ ok: false, reason: 'unavailable' })
}

function frozenEnqueueFailure(
  reason: Extract<PairingPromptEnqueueResult, { ok: false }>['reason']
): PairingPromptEnqueueResult {
  return Object.freeze({ ok: false, reason })
}

function hasUnsafeOriginCharacter(value: string): boolean {
  if (/\s/u.test(value)) return true
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    if (code <= 0x1f || code >= 0x7f) return true
  }
  return false
}

function parseVerifiedIdentity(
  request: PairDialogRequest
): VerifiedPairingPromptIdentity | null {
  if (
    request.verifiedOrigin.length === 0 ||
    hasUnsafeOriginCharacter(request.verifiedOrigin) ||
    request.verifiedOrigin.includes('\\') ||
    request.verifiedOrigin.includes('%')
  ) {
    return null
  }

  let parsed: URL
  try {
    parsed = new URL(request.verifiedOrigin)
  } catch {
    return null
  }

  const expectedProtocol =
    request.browser === 'chromium' ? 'chrome-extension:' : 'moz-extension:'
  if (
    parsed.protocol !== expectedProtocol ||
    parsed.host === '' ||
    parsed.port !== '' ||
    parsed.username !== '' ||
    parsed.password !== '' ||
    parsed.search !== '' ||
    parsed.hash !== '' ||
    (parsed.pathname !== '' && parsed.pathname !== '/')
  ) {
    return null
  }

  return Object.freeze({
    browser: request.browser,
    verifiedOrigin: `${parsed.protocol}//${parsed.host}`,
    originHost: parsed.host,
  })
}

function identityKey(identity: VerifiedPairingPromptIdentity): string {
  return JSON.stringify([identity.browser, identity.verifiedOrigin])
}

export class PairingPromptController {
  private readonly ttlMs: number
  private readonly maxPending: number
  private readonly timeSource: PairingPromptTimeSource
  private readonly onEnqueued: PairingPromptControllerOptions['onEnqueued']
  private readonly onTerminal: PairingPromptControllerOptions['onTerminal']
  private readonly onCallbackFailure: PairingPromptControllerOptions['onCallbackFailure']
  private readonly pending = new Map<string, PendingPrompt>()
  private readonly openIdentities = new Set<string>()
  private readonly callbackFailures: PairingPromptCallbackFailure[] = []
  private readonly promptNamespace = randomUUID()
  private nextPromptSequence = 0
  private disposed = false
  private disposePromise: Promise<void> | null = null

  constructor(options: PairingPromptControllerOptions = {}) {
    this.ttlMs = options.ttlMs ?? DEFAULT_TTL_MS
    this.maxPending = options.maxPending ?? DEFAULT_MAX_PENDING
    this.timeSource = options.timeSource ?? DEFAULT_TIME_SOURCE
    this.onEnqueued = options.onEnqueued
    this.onTerminal = options.onTerminal
    this.onCallbackFailure = options.onCallbackFailure

    if (!Number.isSafeInteger(this.ttlMs) || this.ttlMs <= 0) {
      throw new Error('pairing prompt ttlMs must be a positive safe integer')
    }
    if (!Number.isSafeInteger(this.maxPending) || this.maxPending <= 0) {
      throw new Error(
        'pairing prompt maxPending must be a positive safe integer'
      )
    }
  }

  enqueue(request: PairDialogRequest): PairingPromptEnqueueResult {
    if (this.disposed) return frozenEnqueueFailure('disposed')

    const now = this.readNow()
    this.expireDueEntries(now)

    const verifiedIdentity = parseVerifiedIdentity(request)
    if (verifiedIdentity === null) {
      return frozenEnqueueFailure('invalid-origin')
    }

    const verifiedIdentityKey = identityKey(verifiedIdentity)
    if (this.openIdentities.has(verifiedIdentityKey)) {
      return frozenEnqueueFailure('duplicate')
    }
    if (this.pending.size >= this.maxPending) {
      return frozenEnqueueFailure('capacity')
    }

    const promptId = `${this.promptNamespace}:${this.nextPromptSequence + 1}`
    this.nextPromptSequence += 1
    const snapshot: PairingPromptSnapshot = Object.freeze({
      promptId,
      verifiedIdentity,
      claimedExtensionId: request.claimedExtensionId,
      identity: request.identity,
      pairingNonce: request.pairingNonce,
      code: request.code,
      createdAt: now,
      expiresAt: now + this.ttlMs,
    })

    let resolveTerminal!: (outcome: PairingPromptTerminalOutcome) => void
    const terminal = new Promise<PairingPromptTerminalOutcome>((resolve) => {
      resolveTerminal = resolve
    })
    const entry: PendingPrompt = {
      snapshot,
      identityKey: verifiedIdentityKey,
      terminal,
      resolveTerminal,
      cancelTimer: () => {},
      published: Promise.resolve('not-configured'),
    }
    this.pending.set(promptId, entry)
    this.openIdentities.add(verifiedIdentityKey)

    let armed = false
    let firedSynchronously = false
    try {
      const cancelTimer = this.timeSource.schedule(() => {
        if (!armed) {
          firedSynchronously = true
          return
        }
        void this.settleInternal(
          promptId,
          PairingPromptTerminalOutcomes.Expired
        )
      }, this.ttlMs)
      if (typeof cancelTimer !== 'function' || firedSynchronously) {
        if (typeof cancelTimer === 'function') cancelTimer()
        this.pending.delete(promptId)
        this.openIdentities.delete(verifiedIdentityKey)
        entry.resolveTerminal(PairingPromptTerminalOutcomes.Aborted)
        return frozenEnqueueFailure('scheduling-failed')
      }
      entry.cancelTimer = cancelTimer
      armed = true
    } catch {
      this.pending.delete(promptId)
      this.openIdentities.delete(verifiedIdentityKey)
      entry.resolveTerminal(PairingPromptTerminalOutcomes.Aborted)
      return frozenEnqueueFailure('scheduling-failed')
    }

    // Publication is a synchronous trusted-adapter commit. The Promise-shaped
    // handle wraps the already-computed receipt, keeping PairSession's
    // contract uniform without ever waiting on an adapter-returned thenable.
    entry.published = Promise.resolve(this.publishIfPending(promptId, entry))
    const handle: PairingPromptHandle = Object.freeze({
      promptId,
      published: entry.published,
      terminal,
      settle: (outcome: PairingPromptSessionOutcome) =>
        this.settleFromSession(promptId, outcome),
    })
    return Object.freeze({ ok: true, handle })
  }

  /**
   * Deny one live prompt from the operator surface. A prompt that is missing,
   * already terminal, or due for expiry returns `unavailable`: an operator
   * action must never report success unless it actually won the terminal
   * transition.
   */
  deny(promptId: string): PairingPromptSettleResult {
    const entry = this.pending.get(promptId)
    if (entry === undefined) return frozenUnavailable()

    if (this.readNow() >= entry.snapshot.expiresAt) {
      this.settleInternal(promptId, PairingPromptTerminalOutcomes.Expired)
      return frozenUnavailable()
    }
    return this.settleInternal(promptId, PairingPromptTerminalOutcomes.Denied)
  }

  snapshot(): readonly PairingPromptSnapshot[] {
    if (!this.disposed) this.expireDueEntries(this.readNow())
    return Object.freeze(
      [...this.pending.values()].map((entry) => entry.snapshot)
    )
  }

  callbackFailureSnapshot(): readonly PairingPromptCallbackFailure[] {
    return Object.freeze([...this.callbackFailures])
  }

  /**
   * Abort every live prompt and prevent future enqueue. State transitions and
   * terminal publication are synchronous, so the returned promise is bounded
   * and exists only to keep shell shutdown composition uniform.
   */
  dispose(): Promise<void> {
    if (this.disposePromise !== null) return this.disposePromise
    this.disposed = true
    for (const promptId of [...this.pending.keys()]) {
      this.settleInternal(promptId, PairingPromptTerminalOutcomes.Aborted)
    }
    this.openIdentities.clear()
    this.disposePromise = Promise.resolve()
    return this.disposePromise
  }

  private readNow(): number {
    const now = this.timeSource.now()
    if (!Number.isSafeInteger(now)) {
      throw new Error(
        'pairing prompt time source returned a non-safe-integer value'
      )
    }
    return now
  }

  private expireDueEntries(now: number): void {
    for (const [promptId, entry] of [...this.pending]) {
      if (now < entry.snapshot.expiresAt) continue
      this.settleInternal(promptId, PairingPromptTerminalOutcomes.Expired)
    }
  }

  private settleFromSession(
    promptId: string,
    outcome: PairingPromptSessionOutcome
  ): PairingPromptSettleResult {
    const entry = this.pending.get(promptId)
    if (entry === undefined) return frozenUnavailable()
    if (this.readNow() >= entry.snapshot.expiresAt) {
      this.settleInternal(promptId, PairingPromptTerminalOutcomes.Expired)
      return frozenUnavailable()
    }
    return this.settleInternal(promptId, outcome)
  }

  /** Removes state before invoking callbacks, making concurrent settle safe. */
  private settleInternal(
    promptId: string,
    outcome: PairingPromptTerminalOutcome
  ): PairingPromptSettleResult {
    const entry = this.pending.get(promptId)
    if (entry === undefined) return frozenUnavailable()

    this.pending.delete(promptId)
    this.openIdentities.delete(entry.identityKey)
    try {
      entry.cancelTimer()
    } catch {
      // State is already removed. A broken injected cancellation callback
      // cannot be allowed to strand the terminal promise or duplicate settle.
    }
    entry.resolveTerminal(outcome)

    const event: PairingPromptTerminalEvent = Object.freeze({
      promptId,
      verifiedIdentity: entry.snapshot.verifiedIdentity,
      outcome,
    })
    const onTerminal = this.onTerminal
    this.invokeCallback(
      { phase: 'terminal', outcome },
      onTerminal === undefined ? undefined : () => onTerminal(event)
    )
    return Object.freeze({ ok: true, outcome })
  }

  private publishIfPending(
    promptId: string,
    entry: PendingPrompt
  ): PairingPromptCallbackStatus {
    const onEnqueued = this.onEnqueued
    if (onEnqueued === undefined) return 'not-configured'

    if (this.pending.get(promptId) !== entry) return 'failed'
    return this.invokeCallback({ phase: 'enqueue' }, () =>
      onEnqueued(entry.snapshot)
    )
  }

  private invokeCallback(
    failure: PairingPromptCallbackFailure,
    invoke: (() => PairingPromptCallbackReceipt) | undefined
  ): PairingPromptCallbackStatus {
    if (invoke === undefined) return 'not-configured'

    try {
      const receipt: unknown = invoke()
      if (receipt === 'delivered') return receipt

      // Includes an explicit `failed`, an accidental `undefined`, and a
      // Promise returned through an untyped JavaScript boundary. Never await
      // an invalid thenable; merely suppress a later rejection so it cannot
      // become a process-level unhandled rejection.
      if (receipt !== 'failed') {
        void Promise.resolve(receipt).catch(() => {})
      }
      this.recordCallbackFailure(failure)
      return 'failed'
    } catch {
      this.recordCallbackFailure(failure)
      return 'failed'
    }
  }

  private recordCallbackFailure(failure: PairingPromptCallbackFailure): void {
    const frozenFailure = Object.freeze({ ...failure })
    this.callbackFailures.push(frozenFailure)
    if (this.callbackFailures.length > MAX_RETAINED_CALLBACK_FAILURES) {
      this.callbackFailures.shift()
    }

    try {
      const observed = this.onCallbackFailure?.(frozenFailure)
      void Promise.resolve(observed).catch(() => {})
    } catch {
      // The durable in-memory marker above remains observable even if the
      // optional observer is itself broken. Never recurse or expose secrets.
    }
  }
}
