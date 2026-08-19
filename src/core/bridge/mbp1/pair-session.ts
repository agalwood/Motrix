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
import { fromBase64Url, toBase64Url } from './canonical'
import { DIR_C2S, DIR_S2C, EnvelopeOpener, EnvelopeSealer } from './envelope'
import {
  confirmAFrameSchema,
  credentialAckFrameSchema,
  frameEnvelopeSchema,
  MAX_PRE_AUTH_FRAME_BYTES,
  MBP1_PROTOCOL_VERSION,
  nmTicketWireSchema,
  type PairErrorCode,
  pairHelloFrameSchema,
  pakeAFrameSchema,
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

/** Pairing-code lifetime from the moment the dialog is queued (§7.2). */
const CODE_LIFETIME_MS = 120_000

const CHROMIUM_ORIGIN_SCHEME = 'chrome-extension://'

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
}

/** A queued approval dialog. `dismissed` resolves when the user dismisses it. */
export interface PairDialogHandle {
  dismissed: Promise<void>
  close(): void
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
  queueDialog(args: PairDialogRequest): PairDialogHandle
  sendText(json: object): void
  sendBinary(frame: Uint8Array): void
  close(reason: string): void
  /**
   * Fires once `credentialCommitted` is on the wire, handing over the *live*
   * envelope endpoints — their sequence counters continue from the credential
   * exchange, so MDXP must reuse these instances rather than derive new ones.
   */
  onAuthenticated(channel: {
    sealer: EnvelopeSealer
    opener: EnvelopeOpener
  }): void
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
  private dialog: PairDialogHandle | null = null
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
        this.onPairHello(body)
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

    this.state = 'acked'
    try {
      // §6.7 step 3: durable first, then the message that announces it.
      await this.deps.credentials.commitFromPair(ack.data.credentialId)
    } catch {
      this.terminate('credentialCommitFailed')
      return
    }
    if (this.state !== 'acked' || this.channel === null) {
      return
    }

    this.sendSealed({ type: 'credentialCommitted' })
    this.state = 'committed'
    this.deps.onAuthenticated(this.channel)
  }

  /**
   * Ends the session without writing to the socket: by the time this runs the
   * peer is gone (`socket-closed`) or the wiring's pre-auth deadline is
   * closing it (`timeout`). The consumed attempt count is deliberately
   * preserved (§7.2).
   */
  dispose(_reason: 'socket-closed' | 'timeout'): void {
    if (this.state === 'closed') {
      return
    }
    this.state = 'closed'
    this.discardRunState()
    this.dialog?.close()
    this.releasePendingSlot()
  }

  // -- §6.1 pairHello ------------------------------------------------------

  private onPairHello(body: unknown): void {
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

    // §5: on Chromium the verified `Origin` host proves the extension id, so a
    // `claimedExtensionId` that disagrees with it is a rejected pairing. On
    // Firefox a `moz-extension://<UUID>` origin cannot be mapped to a Gecko
    // id, so there is nothing to compare. Host-header validation is the
    // wiring's, since the header never reaches this module.
    if (
      frame.browser === 'chromium' &&
      this.deps.verifiedOrigin !==
        `${CHROMIUM_ORIGIN_SCHEME}${frame.claimedExtensionId}`
    ) {
      this.violation()
      return
    }

    // §7.3, before any session state, ticket work, or dialog.
    const admission = this.deps.admit(this.deps.verifiedOrigin)
    if (!admission.ok) {
      // No slot was taken, so `releasePendingSlot` must stay a no-op — the
      // slot this was refused against belongs to another live session.
      this.fail(admission.code)
      return
    }
    this.admitted = true

    const resolved = this.resolveIdentity(frame)
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

    this.dialog = this.deps.queueDialog({
      browser: frame.browser,
      claimedExtensionId: frame.claimedExtensionId,
      identity: resolved.identity,
      code: formatPairingCode(code),
      pairingNonce: this.deps.pairNonce,
    })
    this.dialog.dismissed.then(
      () => this.onDismissed(),
      () => this.onDismissed()
    )

    this.state = 'awaiting-pakeA'
    // §6.1: sent when the dialog is queued, and carrying no approval
    // semantics — only key confirmation proves the user approved.
    this.deps.sendText({
      type: 'pairAccept',
      protocolVersion: MBP1_PROTOCOL_VERSION,
      instanceId: this.deps.instanceId,
    })
  }

  /**
   * Applies §9.2's outcome table and §5's tri-state. Returns `null` once the
   * session has already been ended by an abort.
   */
  private resolveIdentity(frame: {
    browser: Browser
    claimedExtensionId: string
    nmTicket?: unknown
    ticketBindingKey?: string
  }): {
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
      const identity: IdentityTriState =
        frame.browser === 'firefox'
          ? 'unverified'
          : this.deps.isOfficialId(frame.browser, frame.claimedExtensionId)
            ? 'official'
            : 'attested-non-official'
      return { identity, bindingPub: null, digest: null }
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

    // §9.2 `attested` proves *which* caller it is; the immutable allowlist,
    // and only the allowlist, decides whether that caller is official (§5). A
    // downgrade proves nothing, so it lands in `unverified` regardless of what
    // the origin would otherwise have supported.
    const identity: IdentityTriState =
      verdict.kind === 'attested'
        ? this.deps.isOfficialId(frame.browser, verdict.callerId)
          ? 'official'
          : 'attested-non-official'
        : 'unverified'

    return { identity, bindingPub: verdict.deferredProof.bindingPub, digest }
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

    const parsed = pakeAFrameSchema.safeParse(body)
    if (!parsed.success) {
      this.violation()
      return
    }

    // §7.2: the run has begun. Consuming the attempt here — not on its
    // outcome — is what makes disconnecting mid-run unable to reclaim it.
    this.attempts += 1

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

    this.state = 'awaiting-confirmA'
    this.deps.sendText({ type: 'pakeB', pB: toBase64Url(pB) })
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

    this.confirmed = true
    this.deps.sendText({ type: 'confirmB', cB: toBase64Url(run.cB) })

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
    this.dialog?.close()
    // The dialog is gone, so the §7.3 pending slot is free — and it must be
    // freed here rather than at `dispose`, or a long-lived paired connection
    // would hold a slot for its whole lifetime and three of them would block
    // every new dialog.
    this.releasePendingSlot()

    await this.issueCredential()
  }

  // -- §6.7 credential issuance -------------------------------------------

  private async issueCredential(): Promise<void> {
    if (this.hello === null) {
      return
    }
    const principal: CredentialPrincipal = {
      browser: this.hello.browser,
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

    this.offeredCredentialId = offer.credentialId
    this.state = 'offer-sent'
    this.sendSealed({
      type: 'credentialOffer',
      credentialId: offer.credentialId,
      mutualKey: offer.mutualKeyB64,
    })
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

  /** A run that reached `pakeA` and ended without mutual confirmation (§7.2). */
  private failRun(): void {
    this.run = null
    if (this.attempts >= MAX_ATTEMPTS) {
      this.fail('rateLimited')
      return
    }
    this.state = 'awaiting-pakeA'
    this.deps.sendText({
      type: 'pairError',
      code: 'codeMismatch',
      attemptsRemaining: MAX_ATTEMPTS - this.attempts,
    })
  }

  private onDismissed(): void {
    if (this.confirmed || this.state === 'closed') {
      return
    }
    this.fail('aborted')
  }

  private expire(): void {
    this.fail('expired')
  }

  private violation(): void {
    this.fail('protocolViolation')
  }

  private fail(code: PairErrorCode): void {
    this.deps.sendText({ type: 'pairError', code })
    this.terminate(code)
  }

  private terminate(reason: string): void {
    if (this.state === 'closed') {
      return
    }
    this.state = 'closed'
    this.discardRunState()
    this.dialog?.close()
    this.releasePendingSlot()
    this.deps.close(reason)
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

  private sendSealed(frame: object): void {
    if (this.channel === null) {
      return
    }
    try {
      this.deps.sendBinary(
        this.channel.sealer.seal(utf8ToBytes(JSON.stringify(frame)))
      )
    } catch {
      this.terminate('envelopeSealFailed')
    }
  }
}

/** Constant-time equality; lengths are public, so an early length exit leaks nothing (§2). */
function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && timingSafeEqual(a, b)
}
