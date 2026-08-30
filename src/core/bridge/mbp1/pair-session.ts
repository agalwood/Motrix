// MBP1 first-pair session state machine
// (docs/bridge-pairing-protocol.md §6, §7, §9.2, §11).
//
// This is where the reviewed mbp1 crypto modules become the §6 protocol: it
// owns the `/pair` conversation from `pairHello` through `credentialCommitted`
// and then hands the live AEAD endpoints to the wiring, which runs MDXP over
// them. It is deliberately transport-neutral — every byte leaves through the
// injected `sendText`/`sendBinary`/`close` — so `src/core/bridge/` keeps its
// "only `web-socket-bridge-server.ts` may import `ws`" boundary.
//
// Four orderings here are load-bearing and are the whole point of the module.
// Rearranging any of them looks harmless and is not:
//
//   1. **§7.3 admission runs before anything else touches state.** `admit()`
//      is called immediately after the version and origin checks and *before*
//      ticket validation, because `verifyNmTicket` consumes the ticket's
//      one-shot replay slot (§9.2's replay row). Validating first would burn a
//      legitimate ticket on a session that is then refused `busy`, and its
//      retry would abort as `replayed`.
//
//   2. **A ticket abort outranks identity.** A presented-but-broken ticket
//      ends the pairing even for a caller whose verified origin would
//      otherwise make it `official` (§9.2). The abort *reason* is never put on
//      the wire: each reason names a distinct §9.2 table row, so echoing it
//      would turn `pairError` into a row-identifying oracle that §11 forbids.
//
//   3. **An attempt is consumed the moment a run reaches `pakeA`.** §7.2
//      counts a run that ends without mutual confirmation *for any reason* —
//      including the socket simply closing — so the counter increments up
//      front and `dispose` never gives it back.
//
//   4. **The provisional credential is durable before `credentialOffer`
//      exists** (§6.7 step 1), and the commit is durable before
//      `credentialCommitted` (step 3).
//
// Every failure that is not a plain framing error must also be
// *indistinguishable*: §11 permits `codeMismatch`/`attemptsRemaining` and
// nothing else about which internal step failed. That is why a wrong `cA`, a
// failed `ticketProof`, and an identity `K` all produce the identical frame.
//
// This module logs nothing at any level: the pairing code, `w`, the PAKE
// intermediates, the traffic keys, the confirmation MACs, and the ticket are
// all in scope here and all forbidden from any log (§11).

import { Buffer } from 'node:buffer'
import { timingSafeEqual } from 'node:crypto'
import { utf8ToBytes } from '@noble/hashes/utils.js'
import type { Browser } from '@shared/protocol/bridge'
import type { CredentialPrincipal, IdentityTriState } from '../credential-store'
import {
  type NormalizedExtensionIdentity,
  normalizeExtensionIdentity,
  resolveNormalizedExtensionIdentity,
} from '../extension-identity-resolver'
import type {
  PairingPromptEnqueueResult,
  PairingPromptHandle,
  PairingPromptSessionOutcome,
  PairingPromptSettleResult,
  PairingPromptTerminalOutcome,
} from '../pairing-prompt-controller'
import { fromBase64Url, toBase64Url } from './canonical'
import { DIR_C2S, DIR_S2C, EnvelopeOpener, EnvelopeSealer } from './envelope'
import {
  confirmAFrameSchema,
  confirmBFrameSchema,
  credentialAckFrameSchema,
  credentialCommittedFrameSchema,
  credentialOfferFrameSchema,
  frameEnvelopeSchema,
  MAX_PRE_AUTH_FRAME_BYTES,
  MBP1_PROTOCOL_VERSION,
  nmTicketWireSchema,
  type PairErrorCode,
  type PairErrorFrame,
  pairAcceptFrameSchema,
  pairErrorFrameSchema,
  pairHelloFrameSchema,
  pakeAFrameSchema,
  pakeBFrameSchema,
} from './frames'
import { formatPairingCode, generatePairingCode } from './pairing-code'
import { deriveW } from './scrypt-w'
import {
  buildTT,
  computePublicB,
  confirmationMacs,
  drawScalar,
  EDWARDS25519_GROUP,
  IdentityKError,
  keySchedule,
  pairTrafficKeys,
  sharedFromB,
} from './spake2-core'
import {
  type TicketReplayCache,
  verifyNmTicket,
  verifyTicketProofStrict,
} from './ticket-verify'
import { buildAad, buildAId, buildBId, ticketDigest } from './transcript'

/** Attempts a single pairing code allows before it dies (§7.2). */
const MAX_ATTEMPTS = 3

/** Pairing-code lifetime from the moment the prompt is queued (§7.2). */
const CODE_LIFETIME_MS = 120_000

/**
 * The §7.3 admission verdict. Structurally identical to
 * `PairFloodControl.admit`, which is what the wiring passes through.
 */
export type PairAdmission =
  | { ok: true }
  | { ok: false; code: 'busy' | 'rateLimited' }

/** Everything `pairHello` needs to describe the approval prompt (§5, §7.1). */
export interface PairDialogRequest {
  browser: Browser
  claimedExtensionId: string
  identity: IdentityTriState
  /** The §7.1 **display** form, grouped `XXXX-XXXX`. The dialog renders it verbatim. */
  code: string
  pairingNonce: string
  /**
   * The verified `Origin` this `/pair` connection presented (§5) — never a
   * self-reported field. The prompt controller keys its dedup on this, never
   * on `claimedExtensionId`: on Firefox the
   * claimed id is self-reported, so keying on it would let one extension
   * suppress another's prompt by claiming its id. Internal bookkeeping only —
   * never surfaced to the renderer.
   */
  verifiedOrigin: string
}

/**
 * The two `Mbp1CredentialStore` operations §6.7's first-pair flow needs.
 * Narrowed to what this module calls so the session can be driven by a double
 * without standing up a real on-disk store; the real store satisfies it
 * structurally.
 */
export interface PairCredentialIssuer {
  offerProvisional(
    principal: CredentialPrincipal,
    identity: IdentityTriState
  ): Promise<{ credentialId: string; mutualKeyB64: string }>
  commitFromPair(credentialId: string): Promise<void>
}

export interface PairSessionDeps {
  /** Whether the demux's one-shot `?nonce=` consumption succeeded (§6.1). */
  nonceValid: boolean
  /** The exact ASCII nonce this `/pair` connection consumed; binds `w` and the AAD (§6.2, §6.4). */
  pairNonce: string
  /** The `Origin` header value, never a self-reported field (§5). */
  verifiedOrigin: string
  /**
   * The browser this connection actually came from, derived by the wiring from
   * the `Origin` scheme — never `pairHello.browser` (§5). `ReconnectSessionDeps`
   * has always taken it this way; `/pair` did not, and the asymmetry was a
   * defect: the credential principal stored the client's self-report while §8
   * builds `RT` from the live connection, so a client whose two producers
   * disagreed paired successfully and then failed **every** reconnect with the
   * uniform `authFailed` it is forbidden to delete a credential over
   * (§6.7/§12) — an unrecoverable pairing indistinguishable from a forged
   * listener. `onPairHello` now rejects the mismatch instead.
   */
  browser: Browser
  instanceId: string
  serverGeneration: string
  localToken: string
  /** Reads the immutable allowlist **only** — never the NM manifest set (§5). */
  isOfficialId(browser: Browser, id: string): boolean
  credentials: PairCredentialIssuer
  replay: TicketReplayCache
  /**
   * §7.3 dedup, global pending cap, and backoff. Called before any session
   * state exists; a refusal is reported verbatim and ends the session.
   */
  admit(verifiedOrigin: string): PairAdmission
  /**
   * Frees the pending slot `admit` took. The session calls this **exactly
   * once**, and only if its own `admit` succeeded, at the earliest of key
   * confirmation, termination, or `dispose`.
   *
   * Both halves of that rule matter, because `PairFloodControl` keys its
   * pending set by origin alone and cannot tell two sessions apart. Releasing
   * a slot this session never took would free the slot held by whichever
   * session *did* take it, and releasing twice would free the slot of a later
   * session that re-admitted the same origin in between — either one raises
   * the effective pending cap for an attacker that reconnects on a fixed
   * origin.
   *
   * The caller still owns the §7.3 *failure counter*, which it can compute
   * from `attemptCount` and whether `onAuthenticated` fired.
   */
  release(verifiedOrigin: string): void
  queueDialog(args: PairDialogRequest): PairingPromptEnqueueResult
  sendText(json: object): void
  sendBinary(frame: Uint8Array): void
  close(reason: string): void
  /**
   * Fires once `credentialCommitted` is on the wire, handing over the *live*
   * envelope endpoints — their sequence counters continue from the credential
   * exchange, so MDXP must reuse these instances rather than derive new ones.
   */
  onAuthenticated(
    channel: {
      sealer: EnvelopeSealer
      opener: EnvelopeOpener
    },
    /** The exact durable credential committed by this session. */
    credentialId: string
  ): void
  now(): number
  random(n: number): Uint8Array
}

type PairState =
  | 'awaiting-hello'
  | 'awaiting-pakeA'
  | 'awaiting-confirmA'
  | 'channel-active'
  | 'offer-sent'
  | 'acked'
  | 'committed'
  | 'closed'

/** Per-run SPAKE2 state. Discarded whenever a run ends, successfully or not (§6.3). */
interface PakeRun {
  tt: Uint8Array
  ke: Uint8Array
  expectedCA: Uint8Array
  cB: Uint8Array
}

/** The `pairHello` facts every later step binds against. */
interface HelloContext {
  browser: Browser
  claimedExtensionId: string
  clientInstallationId: string
  aId: Uint8Array
  aad: Uint8Array
  identity: IdentityTriState
  /** The ticket's binding key when one was presented, else `null` (§6.5). */
  ticketBindingPub: Uint8Array | null
}

export class PairSession {
  private readonly deps: PairSessionDeps
  private state: PairState = 'awaiting-hello'
  private hello: HelloContext | null = null
  private prompt: PairingPromptHandle | null = null
  private codeNormalized: string | null = null
  private codeExpiresAt = 0
  private w: bigint | null = null
  private run: PakeRun | null = null
  private channel: { sealer: EnvelopeSealer; opener: EnvelopeOpener } | null =
    null
  private offeredCredentialId: string | null = null
  private confirmed = false
  private attempts = 0
  /** Whether this session's own `admit` took a §7.3 pending slot. */
  private admitted = false
  /** Whether that slot has already been given back. */
  private released = false

  constructor(deps: PairSessionDeps) {
    this.deps = deps
  }

  /**
   * Attempts this session has consumed (§7.2). Never decremented: the wiring
   * reads it after the socket closes to decide whether the run counts toward
   * the §7.3 global failure counter.
   */
  get attemptCount(): number {
    return this.attempts
  }

  async handleText(raw: string, byteLength: number): Promise<void> {
    if (this.state === 'closed' || this.state === 'committed') {
      return
    }
    if (!this.deps.nonceValid) {
      this.fail('expired')
      return
    }
    if (this.channel !== null) {
      // §10: a text frame after channel activation is a violation, and
      // `pairError` is pre-channel only (§11) — so this closes without a frame.
      this.terminate('textAfterChannelActivation')
      return
    }
    if (byteLength > MAX_PRE_AUTH_FRAME_BYTES) {
      this.violation()
      return
    }

    let body: unknown
    try {
      body = JSON.parse(raw)
    } catch {
      this.violation()
      return
    }

    const envelope = frameEnvelopeSchema.safeParse(body)
    if (!envelope.success) {
      this.violation()
      return
    }

    switch (envelope.data.type) {
      case 'pairHello':
        await this.onPairHello(body)
        return
      case 'pakeA':
        this.onPakeA(body)
        return
      case 'confirmA':
        await this.onConfirmA(body)
        return
      default:
        this.violation()
    }
  }

  async handleBinary(data: Uint8Array): Promise<void> {
    if (this.state === 'closed' || this.state === 'committed') {
      return
    }
    if (this.state !== 'offer-sent' || this.channel === null) {
      this.terminate('unexpectedBinaryFrame')
      return
    }

    let plaintext: Uint8Array
    try {
      plaintext = this.channel.opener.open(data)
    } catch {
      // §10: any gap, repeat, or GCM failure closes the connection immediately.
      this.terminate('envelopeViolation')
      return
    }

    let body: unknown
    try {
      body = JSON.parse(Buffer.from(plaintext).toString('utf-8'))
    } catch {
      this.terminate('protocolViolation')
      return
    }

    const ack = credentialAckFrameSchema.safeParse(body)
    if (!ack.success || ack.data.credentialId !== this.offeredCredentialId) {
      this.terminate('protocolViolation')
      return
    }

    const credentialId = ack.data.credentialId
    this.state = 'acked'
    try {
      // §6.7 step 3: durable first, then the message that announces it.
      await this.deps.credentials.commitFromPair(credentialId)
    } catch {
      this.terminate('credentialCommitFailed')
      return
    }
    // Captured into a local, not re-read from `this`: `sendSealed` can
    // `terminate` (which nulls `this.channel`), and TypeScript keeps the
    // narrowing above alive across that call.
    const channel = this.channel
    if (this.state !== 'acked' || channel === null) {
      return
    }

    const committedFrame = { type: 'credentialCommitted' }
    if (!credentialCommittedFrameSchema.safeParse(committedFrame).success) {
      this.terminate('credentialCommittedInvalid')
      return
    }
    // A failed seal has already closed the session. Continuing would set
    // `state = 'committed'` on a closed session and hand the wiring a channel
    // after its `close` callback had fired.
    if (!this.sendSealed(committedFrame)) {
      return
    }
    this.state = 'committed'
    this.deps.onAuthenticated(channel, credentialId)
  }

  /**
   * Ends the session without writing to the socket: the peer is gone
   * (`socket-closed`), the wiring's pre-auth deadline is closing it
   * (`timeout`), or an explicit credential revoke is cancelling every
   * same-Origin handshake (`access-revoked`). The consumed attempt count is
   * deliberately preserved (§7.2).
   */
  dispose(_reason: 'socket-closed' | 'timeout' | 'access-revoked'): void {
    if (this.isClosed()) {
      return
    }
    this.state = 'closed'
    this.discardRunState()
    try {
      this.settlePrompt('aborted')
    } finally {
      // A renderer/dialog teardown fault must not leak §7.3's pending slot.
      this.releasePendingSlot()
    }
  }

  // -- §6.1 pairHello ------------------------------------------------------

  private async onPairHello(body: unknown): Promise<void> {
    if (this.state !== 'awaiting-hello') {
      this.violation()
      return
    }

    const parsed = pairHelloFrameSchema.safeParse(body)
    if (!parsed.success) {
      this.violation()
      return
    }
    const frame = parsed.data

    if (frame.protocolVersion !== MBP1_PROTOCOL_VERSION) {
      this.fail('unsupportedVersion')
      return
    }

    // §5 forbids taking identity from a self-reported field, so `browser` must
    // agree with what the `Origin` scheme already proved. Rejecting the
    // mismatch here — before admission, so it costs no §7.3 slot — is what
    // keeps every later use of `frame.browser` sound, and it moves an honest
    // client's detection bug from "pairs, then fails every reconnect forever"
    // to one abort it can actually diagnose.
    if (frame.browser !== this.deps.browser) {
      this.violation()
      return
    }

    // Normalize only the transport-derived browser/Origin. The helper uses
    // the pairHello claim once for Chromium host equality, then discards it;
    // Firefox's claimed Gecko id never enters normalized evidence. This runs
    // before admission so a contradictory identity cannot occupy a §7.3 slot.
    const normalizedIdentity = normalizeExtensionIdentity({
      browser: this.deps.browser,
      verifiedOrigin: this.deps.verifiedOrigin,
      claimedExtensionId: frame.claimedExtensionId,
    })
    if (!normalizedIdentity.ok) {
      this.violation()
      return
    }

    // §7.3, before any session state, ticket work, or prompt.
    const admission = this.deps.admit(this.deps.verifiedOrigin)
    if (!admission.ok) {
      // No slot was taken, so `releasePendingSlot` must stay a no-op — the
      // slot this was refused against belongs to another live session.
      this.fail(admission.code)
      return
    }
    this.admitted = true

    const resolved = this.resolveIdentity(frame, normalizedIdentity.identity)
    if (resolved === null) {
      return
    }

    // `generatePairingCode`, `buildAad`, and `buildAId` all throw rather than
    // encode something the peer could not reproduce — a short CSPRNG draw, or
    // a non-ASCII `pairNonce`/`verifiedOrigin` reaching `enc()` (§2). None of
    // those are the peer's fault in a way §11 has a code for, so they collapse
    // into the generic `pairingFailed` instead of escaping the frame handler.
    let code: string
    let aad: Uint8Array
    let aId: Uint8Array
    try {
      code = generatePairingCode(this.deps.random(5))
      aad = buildAad(
        MBP1_PROTOCOL_VERSION,
        this.deps.pairNonce,
        frame.ticketBindingKey === undefined
          ? null
          : fromBase64Url(frame.ticketBindingKey),
        resolved.digest
      )
      aId = buildAId({
        browser: frame.browser,
        verifiedOrigin: this.deps.verifiedOrigin,
        claimedExtensionId: frame.claimedExtensionId,
        clientInstallationId: frame.clientInstallationId,
      })
    } catch {
      this.fail('pairingFailed')
      return
    }

    this.hello = {
      browser: frame.browser,
      claimedExtensionId: frame.claimedExtensionId,
      clientInstallationId: frame.clientInstallationId,
      aId,
      aad,
      identity: resolved.identity,
      ticketBindingPub: resolved.bindingPub,
    }
    this.codeNormalized = code
    this.codeExpiresAt = this.deps.now() + CODE_LIFETIME_MS

    // §6.1: sent when the prompt is queued, and carrying no approval
    // semantics — only key confirmation proves the user approved.
    const acceptFrame = {
      type: 'pairAccept',
      protocolVersion: MBP1_PROTOCOL_VERSION,
      instanceId: this.deps.instanceId,
    }
    if (!pairAcceptFrameSchema.safeParse(acceptFrame).success) {
      this.terminate('pairAcceptInvalid')
      return
    }

    let enqueued: PairingPromptEnqueueResult
    try {
      enqueued = this.deps.queueDialog({
        browser: frame.browser,
        claimedExtensionId: frame.claimedExtensionId,
        identity: resolved.identity,
        code: formatPairingCode(code),
        pairingNonce: this.deps.pairNonce,
        verifiedOrigin: this.deps.verifiedOrigin,
      })
    } catch {
      this.fail('pairingFailed')
      return
    }
    if (!enqueued.ok) {
      // The refusal reason belongs to the local prompt adapter. Collapsing all
      // of them avoids turning duplicate/capacity/scheduler state into a wire
      // oracle and, critically, leaves no session waiting for a handle that
      // does not exist.
      this.fail('pairingFailed')
      return
    }

    const prompt = enqueued.handle
    this.prompt = prompt
    prompt.terminal.then(
      (outcome) => this.onPromptTerminal(outcome),
      () => this.onPromptContractFailure()
    )

    let published: Awaited<PairingPromptHandle['published']>
    try {
      published = await prompt.published
    } catch {
      published = 'failed'
    }
    if (this.isClosed()) {
      return
    }
    if (published !== 'delivered') {
      // A code that never reached the authenticated shell UI cannot authorize
      // anything. Fail generically, then settle the prompt as session-aborted
      // during terminate(); callback errors and their details stay local.
      this.fail('pairingFailed')
      return
    }
    if (this.codeExpired()) {
      this.expire()
      return
    }

    this.state = 'awaiting-pakeA'
    this.deps.sendText(acceptFrame)
  }

  /**
   * Applies §9.2's outcome table and §5's tri-state. Returns `null` once the
   * session has already been ended by an abort.
   */
  private resolveIdentity(
    frame: {
      browser: Browser
      claimedExtensionId: string
      nmTicket?: unknown
      ticketBindingKey?: string
    },
    normalizedIdentity: NormalizedExtensionIdentity
  ): {
    identity: IdentityTriState
    bindingPub: Uint8Array | null
    digest: Uint8Array | null
  } | null {
    if (frame.nmTicket === undefined) {
      // No ticket. §5's table has a genuinely empty cell here — a ticketless
      // Chromium caller whose id is *not* allowlisted — so this reading is a
      // controller ruling, not a transcription of the table. Do not "fix" it
      // to `unverified` without re-reading the whole argument:
      //
      //   - §5's `official` row admits TWO independent bases for a proven
      //     caller identity: "the Chromium verified `Origin` host, OR the
      //     `callerId` inside a valid NM attestation ticket". The Origin check
      //     above already rejected any Chromium session whose origin host
      //     disagrees with `claimedExtensionId`, so a surviving Chromium
      //     session has proven *which* extension it is, ticket or no ticket.
      //   - `official` vs `attested-non-official` is then purely "is that
      //     proven id on the immutable allowlist". Returning `unverified` for
      //     the not-allowlisted case would be internally inconsistent: the
      //     identical evidence would be strong enough to grant `official` when
      //     the id IS allowlisted, yet too weak to say "we know which
      //     extension this is" when it is not.
      //   - `unverified` is reserved for callers whose id genuinely cannot be
      //     established: Firefox's `moz-extension://<UUID>`, which maps to no
      //     Gecko id, and candidate-sweep peers.
      //   - The display consequence follows. `attested-non-official` shows the
      //     raw *proven* id, which on Chromium is truthful;`unverified` shows a
      //     raw *claimed* id with warning styling, understating what the server
      //     knows.
      //
      // §5's "native local processes can forge any Origin header" caveat does
      // not change this: it applies equally to the `official` row and the spec
      // accepts it there. The user-facing boundary is the pairing code, the
      // approval dialog, and the global prompt caps (§7.3) — never the Origin.
      const resolution = resolveNormalizedExtensionIdentity(
        normalizedIdentity,
        { kind: 'none' },
        this.deps.isOfficialId
      )
      if (!resolution.ok) {
        this.violation()
        return null
      }
      return {
        identity: resolution.identity,
        bindingPub: null,
        digest: null,
      }
    }

    const verdict = verifyNmTicket(frame.nmTicket, {
      localToken: this.deps.localToken,
      serverGeneration: this.deps.serverGeneration,
      nowMs: this.deps.now(),
      helloBrowser: frame.browser,
      helloClaimedExtensionId: frame.claimedExtensionId,
      helloTicketBindingKey: this.helloBindingKey(frame),
      replay: this.deps.replay,
    })

    if (verdict.kind === 'abort') {
      // The reason identifies a §9.2 row and never reaches the wire (§11).
      this.violation()
      return null
    }

    const digest = this.digestOf(frame.nmTicket)
    if (digest === null) {
      // Unreachable: a non-abort verdict means ticket-verify's own strict
      // schema already accepted this object. Fail generically rather than
      // report a peer violation for what would be our own inconsistency.
      this.fail('pairingFailed')
      return null
    }

    // §9.2's two boundary rules, in order: a structural abort outranks
    // identity and was handled above, and a surviving ticket's contribution
    // can only *raise* an identity, never lower one. `attested` proves
    // *which* caller it is — the immutable allowlist, and only the allowlist,
    // then decides whether that caller is official (§5). A semantic
    // downgrade contributes nothing, so identity falls back to what the
    // verified origin alone establishes — the exact ticketless outcome, so a
    // stale ticket is never worse for a caller than presenting none.
    const resolution = resolveNormalizedExtensionIdentity(
      normalizedIdentity,
      verdict.kind === 'attested'
        ? { kind: 'verified-nm-ticket', callerId: verdict.callerId }
        : { kind: 'none' },
      this.deps.isOfficialId
    )
    if (!resolution.ok) {
      this.violation()
      return null
    }

    return {
      identity: resolution.identity,
      bindingPub: verdict.deferredProof.bindingPub,
      digest,
    }
  }

  private helloBindingKey(frame: {
    ticketBindingKey?: string
  }): Uint8Array | null {
    if (frame.ticketBindingKey === undefined) {
      return null
    }
    try {
      return fromBase64Url(frame.ticketBindingKey)
    } catch {
      return null
    }
  }

  /** §6.4's `ticketDigest` over the parsed values of every ticket wire field. */
  private digestOf(wire: unknown): Uint8Array | null {
    const parsed = nmTicketWireSchema.safeParse(wire)
    if (!parsed.success) {
      return null
    }
    try {
      return ticketDigest({
        ...parsed.data,
        bindingPub: fromBase64Url(parsed.data.bindingPub),
        mac: fromBase64Url(parsed.data.mac),
      })
    } catch {
      return null
    }
  }

  // -- §6.3 pakeA ----------------------------------------------------------

  private onPakeA(body: unknown): void {
    if (this.state !== 'awaiting-pakeA' || this.hello === null) {
      this.violation()
      return
    }
    if (this.codeExpired()) {
      this.expire()
      return
    }

    // §7.2: the run has begun. Consuming the attempt here — before the schema
    // parse, and never on its outcome — is what makes both a mid-run
    // disconnect and a malformed frame unable to reclaim it. §7.2 lists
    // "malformed point after `pakeA`" among the failures that count, so an
    // unparseable `pakeA` spends an attempt just as a bad `cA` does.
    this.attempts += 1

    const parsed = pakeAFrameSchema.safeParse(body)
    if (!parsed.success) {
      this.violation()
      return
    }

    let w: bigint
    try {
      w = this.deriveWOnce()
    } catch {
      // `w = 0` (§6.2) and a broken local invariant alike: generic, never a
      // peer violation.
      this.fail('pairingFailed')
      return
    }

    let y: bigint
    try {
      y = drawScalar(EDWARDS25519_GROUP.order, this.deps.random)
    } catch {
      // `drawScalar` throws `ProtocolViolationError` for a short CSPRNG draw —
      // a local fault, not the peer's. Reporting it as `protocolViolation`
      // would misattribute our own failure.
      this.fail('pairingFailed')
      return
    }

    const pA = fromBase64Url(parsed.data.pA)
    const pB = computePublicB(EDWARDS25519_GROUP, w, y)

    let k: Uint8Array
    try {
      k = sharedFromB(EDWARDS25519_GROUP, w, y, pA)
    } catch (error) {
      if (error instanceof IdentityKError) {
        // §6.3/§7.2: a failed attempt. It must be indistinguishable from a bad
        // `cA` — otherwise it is an oracle for "your `pA` equalled `w·M`",
        // i.e. for `w` itself.
        this.failRun()
        return
      }
      // A non-canonical or off-curve `pA` (§6.3).
      this.violation()
      return
    }

    const tt = buildTT(
      this.hello.aId,
      buildBId(this.deps.instanceId),
      pA,
      pB,
      k,
      w
    )
    const keys = keySchedule(tt, this.hello.aad)
    const macs = confirmationMacs(keys.KcA, keys.KcB, tt)
    this.run = { tt, ke: keys.Ke, expectedCA: macs.cA, cB: macs.cB }

    const pakeBFrame = { type: 'pakeB', pB: toBase64Url(pB) }
    if (!pakeBFrameSchema.safeParse(pakeBFrame).success) {
      this.terminate('pakeBInvalid')
      return
    }
    this.state = 'awaiting-confirmA'
    this.deps.sendText(pakeBFrame)
  }

  // -- §6.5 confirmA -------------------------------------------------------

  private async onConfirmA(body: unknown): Promise<void> {
    const run = this.run
    if (this.state !== 'awaiting-confirmA' || run === null || !this.hello) {
      this.violation()
      return
    }
    if (this.codeExpired()) {
      this.expire()
      return
    }

    const parsed = confirmAFrameSchema.safeParse(body)
    if (!parsed.success) {
      this.violation()
      return
    }

    const bindingPub = this.hello.ticketBindingPub
    const proof = parsed.data.ticketProof
    // §6.5: `ticketProof` is required iff an `nmTicket` was presented. Its
    // 64-byte length is a schema concern, so anything reaching here is either
    // present-and-well-formed or absent.
    if ((bindingPub !== null) !== (proof !== undefined)) {
      this.violation()
      return
    }

    const macOk = constantTimeEqual(
      fromBase64Url(parsed.data.cA),
      run.expectedCA
    )
    // `verifyTicketProofStrict`'s precondition holds: `bindingPub` is the key
    // `verifyNmTicket` already accepted, which is why it does not re-validate.
    // Both checks are evaluated before either is branched on, so which one
    // failed is not observable.
    const proofOk =
      bindingPub === null ||
      proof === undefined ||
      verifyTicketProofStrict(bindingPub, run.tt, fromBase64Url(proof))

    if (!macOk || !proofOk) {
      this.failRun()
      return
    }

    const confirmBFrame = { type: 'confirmB', cB: toBase64Url(run.cB) }
    if (!confirmBFrameSchema.safeParse(confirmBFrame).success) {
      this.terminate('confirmBInvalid')
      return
    }
    let promptSettlement: PairingPromptSettleResult
    try {
      promptSettlement = this.settlePrompt('paired')
    } catch {
      this.fail('pairingFailed')
      return
    }
    if (!promptSettlement.ok) {
      // Denial, expiry, adapter disposal, or session teardown already won.
      // Its terminal callback owns the corresponding wire outcome.
      return
    }

    this.confirmed = true
    this.deps.sendText(confirmBFrame)

    // §6.6: the channel is live in both directions from here on.
    const { kC2S, kS2C } = pairTrafficKeys(run.ke)
    this.channel = {
      sealer: new EnvelopeSealer(kS2C, DIR_S2C),
      opener: new EnvelopeOpener(kC2S, DIR_C2S),
    }
    this.state = 'channel-active'
    this.run = null
    this.w = null
    this.codeNormalized = null
    // The prompt is terminal, so the §7.3 pending slot is free — and it must be
    // freed here rather than at `dispose`, or a long-lived paired connection
    // would hold a slot for its whole lifetime and three of them would block
    // every new prompt.
    this.releasePendingSlot()

    await this.issueCredential()
  }

  // -- §6.7 credential issuance -------------------------------------------

  private async issueCredential(): Promise<void> {
    if (this.hello === null) {
      return
    }
    // `browser` comes from the derived value, not `this.hello.browser`, and the
    // distinction is the whole point: §8 rebuilds `RT` from the **live**
    // connection's browser on every reconnect, so a principal recorded from
    // anything else fails the MAC forever. `onPairHello` proves the two are
    // equal, so this is the same value either way — but it now comes from the
    // same source the reconnect side reads, which is what makes that true by
    // construction rather than by a check someone could later move.
    const principal: CredentialPrincipal = {
      browser: this.deps.browser,
      verifiedOrigin: this.deps.verifiedOrigin,
      clientInstallationId: this.hello.clientInstallationId,
    }

    let offer: { credentialId: string; mutualKeyB64: string }
    try {
      // §6.7 step 1: durable in state `provisional` *before* the offer exists.
      offer = await this.deps.credentials.offerProvisional(
        principal,
        this.hello.identity
      )
    } catch {
      this.terminate('credentialPersistFailed')
      return
    }
    if (this.state !== 'channel-active' || this.channel === null) {
      return
    }

    // Self-check the frame we are about to emit. `credentialOfferFrameSchema`
    // asserts `mutualKey` is canonical base64url of exactly 32 bytes (§6.7),
    // and nothing else verifies that the store honours it: `PairCredentialIssuer`
    // is a structural interface, so `tsc` proves the method shapes match but
    // says nothing about the *contents* of the string it returns. Validating
    // here turns a store-contract violation into a local, diagnosable close
    // instead of a malformed frame the peer has to reject, and makes
    // `frames.ts`'s "one schema describes both directions" claim literally true.
    const offerFrame = {
      type: 'credentialOffer',
      credentialId: offer.credentialId,
      mutualKey: offer.mutualKeyB64,
    }
    if (!credentialOfferFrameSchema.safeParse(offerFrame).success) {
      this.terminate('credentialOfferInvalid')
      return
    }

    this.offeredCredentialId = offer.credentialId
    this.state = 'offer-sent'
    if (!this.sendSealed(offerFrame)) {
      return
    }
  }

  // -- shared helpers ------------------------------------------------------

  private deriveWOnce(): bigint {
    if (this.w === null) {
      if (this.codeNormalized === null) {
        throw new Error('no live pairing code')
      }
      // Derived lazily so scrypt is paid only by a session that actually
      // attempts, and cached so all three runs share one `w` per code (§6.2).
      this.w = deriveW(
        this.codeNormalized,
        this.deps.pairNonce,
        EDWARDS25519_GROUP.order
      )
    }
    return this.w
  }

  private codeExpired(): boolean {
    return this.deps.now() >= this.codeExpiresAt
  }

  private isClosed(): boolean {
    return this.state === 'closed'
  }

  /** A run that reached `pakeA` and ended without mutual confirmation (§7.2). */
  private failRun(): void {
    this.run = null
    if (this.attempts >= MAX_ATTEMPTS) {
      this.fail('rateLimited')
      return
    }
    if (
      !this.sendPairError({
        type: 'pairError',
        code: 'codeMismatch',
        attemptsRemaining: MAX_ATTEMPTS - this.attempts,
      })
    ) {
      return
    }
    this.state = 'awaiting-pakeA'
  }

  private onPromptTerminal(outcome: PairingPromptTerminalOutcome): void {
    if (
      this.confirmed ||
      this.state === 'closed' ||
      this.state === 'committed'
    ) {
      return
    }

    if (outcome === 'paired') {
      // Only this PairSession owns `paired`; observing it before the session
      // marked mutual confirmation is a broken adapter contract, not approval.
      this.fail('pairingFailed')
      return
    }
    this.fail(
      outcome === 'expired'
        ? 'expired'
        : outcome === 'denied'
          ? 'denied'
          : 'aborted'
    )
  }

  private onPromptContractFailure(): void {
    if (
      this.confirmed ||
      this.state === 'closed' ||
      this.state === 'committed'
    ) {
      return
    }
    this.fail('pairingFailed')
  }

  private expire(): void {
    this.fail('expired')
  }

  private violation(): void {
    this.fail('protocolViolation')
  }

  private fail(code: PairErrorCode): void {
    if (!this.sendPairError({ type: 'pairError', code })) {
      return
    }
    this.terminate(code)
  }

  /**
   * Validates a `pairError` frame against its own schema before it reaches
   * the peer. `pairError`'s fields are locally constructed — a typed `code`
   * and a computed `attemptsRemaining` — but validating it too is what makes
   * `frames.ts`'s "one schema describes both directions" claim total rather
   * than true for six frames out of seven. A frame that fails here is our own
   * construction bug, and there is nowhere left to report it: a second
   * `pairError` could be just as broken, so this terminates silently instead
   * of recursing into `fail`.
   */
  private sendPairError(frame: PairErrorFrame): boolean {
    if (!pairErrorFrameSchema.safeParse(frame).success) {
      this.terminate('pairErrorFrameInvalid')
      return false
    }
    this.deps.sendText(frame)
    return true
  }

  private terminate(reason: string): void {
    if (this.state === 'closed') {
      return
    }
    this.state = 'closed'
    this.discardRunState()
    try {
      this.settlePrompt('aborted')
    } catch {
      // The socket still closes and the admission slot is still released. A
      // broken shell adapter cannot keep protocol state alive.
    } finally {
      this.releasePendingSlot()
      this.deps.close(reason)
    }
  }

  private settlePrompt(
    outcome: PairingPromptSessionOutcome
  ): PairingPromptSettleResult {
    const prompt = this.prompt
    if (prompt === null) {
      return { ok: false, reason: 'unavailable' }
    }
    const result = prompt.settle(outcome)
    if (result.ok) {
      this.prompt = null
    }
    return result
  }

  /** See `PairSessionDeps.release`: at most once, and only for a slot we took. */
  private releasePendingSlot(): void {
    if (!this.admitted || this.released) {
      return
    }
    this.released = true
    this.deps.release(this.deps.verifiedOrigin)
  }

  /** §6.3: all PAKE state is in-memory only and dies with the run. */
  private discardRunState(): void {
    this.run = null
    this.w = null
    this.codeNormalized = null
    this.channel = null
  }

  /**
   * Seals and sends one frame, reporting whether it actually went out. A
   * `false` return means the session is **already closed** — every caller must
   * return immediately rather than continue on the assumption that the frame
   * was delivered.
   */
  private sendSealed(frame: object): boolean {
    if (this.channel === null) {
      return false
    }
    try {
      this.deps.sendBinary(
        this.channel.sealer.seal(utf8ToBytes(JSON.stringify(frame)))
      )
      return true
    } catch {
      this.terminate('envelopeSealFailed')
      return false
    }
  }
}

/** Constant-time equality; lengths are public, so an early length exit leaks nothing (§2). */
function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && timingSafeEqual(a, b)
}
