/**
 * MBP1 first-pair state machine (bridge-pairing-protocol.md §6.1, §6.5-§6.7,
 * §7.2, §7.3).
 *
 * The code path a user actually walks through when pairing a browser to Motrix
 * for the first time, and the one an online guessing attack targets.
 *
 * ```
 * backoff.check  ->  open /pair?nonce=  ->  pairHello  ->  pairAccept
 *   |                                                        |
 *   | refused: "try again later" (§7.3), socket never opened  | up to 3 runs (§6.5)
 *   v                                                        v
 * PairingFlowError                       pakeA -> pakeB -> confirmA -> confirmB
 *                                                                        |
 *                            === AEAD channel active (§6.6) ============ v
 *                            credentialOffer -> [durable write-ahead] -> credentialAck
 *                                                                     -> credentialCommitted
 *                                            -> finalizeAndPrune -> pin
 * ```
 *
 * ## Three things that are easy to get subtly, dangerously wrong
 *
 * **1. `pairAccept` carries no approval semantics.** It means "the server
 * queued the dialog" and nothing more — the user may still be reading it, or
 * may dismiss it. Only a `confirmB` that verifies proves the user approved. So
 * nothing is persisted, nothing is reported as success, and no state this flow
 * returns can read "paired" until that verification passes. Line A's own frame
 * comment says the same thing from the other side.
 *
 * **2. `attemptsRemaining` is untrusted display data.** §6.5 requires the
 * extension to enforce *its own* ceiling of 3 runs per session and its own
 * 180 s session deadline "regardless of what the peer reports". A fake or
 * relaying listener will happily answer `codeMismatch` with
 * `attemptsRemaining: 99` forever, harvesting one password test per induced
 * run; the local ceiling is the only thing that stops it. The value is
 * forwarded to the code provider for display and is never read by any
 * control-flow decision.
 *
 * **3. The write-ahead ordering is not a nicety.** §6.7 step 2: the durable
 * `unacked → commit-uncertain` flip MUST land **before** `credentialAck` is
 * transmitted, so that `commit-uncertain` can mean "the ack *may* have been
 * sent". A crash in that gap then lands in the retain-forever state instead of
 * the age-out state, which is the difference between a client that can recover
 * and one that is stranded on a credential the server already committed.
 *
 * ## Failure accounting (§7.2, §7.3)
 *
 * A §7.3 failure is any session that **reached `pakeA`** and ended without
 * mutual confirmation, *for any reason* — bad `cA`, identity `K`, a malformed
 * frame, a protocol abort, the socket closing mid-run, or this flow abandoning
 * the attempt itself. §7.3 names the self-abandoned case explicitly so a
 * guesser cannot dodge the counter by hanging up before exhausting a code, so
 * the accounting lives in `run`'s exit path rather than at any individual
 * failure site.
 *
 * A session that never reached `pakeA` — refused by the local gate, a bad
 * nonce, `busy`, a malformed `pairAccept` — records nothing. That is the
 * documented asymmetry with the server, which increments as soon as a
 * code-bearing dialog is queued (§7.3: "the two count at slightly different
 * points").
 *
 * ## Logging
 *
 * Nothing here logs at any level (§11). The pairing code, `w`, `x`, `K`,
 * `Ke`/`Ka`, `KcA`/`KcB`, the confirmation MACs, the §6.6 traffic keys,
 * `mutualKey`, `bindingPriv` and the ticket are all in scope in this module,
 * and §11 additionally forbids logging `pairError` codes. The thrown messages
 * below name a step, never a value.
 */

import {
  b64uDecode,
  b64uEncode,
  timingSafeEqualBytes,
  utf8,
} from '@/background/mbp1/canonical'
import type {
  CredentialLifecycleSource,
  CredentialLifecycleStore,
  Principal,
} from '@/background/mbp1/credential-store'
import {
  OfferContradictsSlotError,
  resolveCredentialLifecycleStore,
} from '@/background/mbp1/credential-store'
import type { DiscoveryResult } from '@/background/mbp1/discovery-service'
import { EnvelopeCodec } from '@/background/mbp1/envelope'
import type { FirstPairBackoff } from '@/background/mbp1/first-pair-backoff'
import {
  assertProtocolVersion,
  buildConfirmA,
  buildCredentialAck,
  buildPairHello,
  buildPakeA,
  type FrameChannel,
  FrameError,
  isMbp1Browser,
  MBP1_PROTOCOL_VERSION,
  type Mbp1Browser,
  type PairErrorCode,
  type PairErrorFrame,
  pairUrl,
  parseNmTicket,
  parseTextFrame,
  type ServerFrame,
} from '@/background/mbp1/frames'
import { normalizePairingCode } from '@/background/mbp1/pairing-code'
import type { PinStore } from '@/background/mbp1/pin-store'
import { deriveW } from '@/background/mbp1/scrypt-w'
import {
  drawScalar,
  ED25519_GROUP,
  pairTrafficKeys,
  type Spake2ClientResult,
  Spake2IdentityKError,
  scalarFromBytes,
  spake2ClientRun,
  spake2ClientShare,
} from '@/background/mbp1/spake2-core'
import {
  type BindingKeypair,
  signTicketProof,
} from '@/background/mbp1/ticket-bootstrap'
import {
  buildAad,
  buildAId,
  buildBId,
  type ParsedTicket,
} from '@/background/mbp1/transcript'

/** §6.5: the extension's own ceiling on protocol runs per pairing session. */
export const MAX_RUNS_PER_SESSION = 3

/** §6.5: the extension's own absolute session deadline, from `pairHello`. */
export const SESSION_DEADLINE_MS = 180_000

/**
 * §7.2: the code dies 120 s after it is generated, which is when the dialog is
 * queued — i.e. when `pairAccept` arrives.
 *
 * This is the **inner** bound and the one to design against. `/pair`'s
 * pre-authentication table deadline of 150 s is a longer *backstop* that exists
 * so the session's own `expired` branch is reachable in production rather than
 * being pre-empted by a socket close; budgeting against 150 s would blow the
 * real deadline.
 */
export const CODE_LIFETIME_MS = 120_000

export type PairingFailureReason =
  /** §7.3 lockout: `/pair` was never opened. `retryAtMs` says when to retry. */
  | 'backoffLocked'
  /** `deps.isCurrent()` went false — a newer attempt superseded this one. */
  | 'staleAttempt'
  /** `abort()` was called from outside — the caller gave up on this run
   *  (e.g. the code-entry UI closed, or a service-worker teardown is under
   *  way) rather than a newer attempt superseding it (`staleAttempt`). */
  | 'aborted'
  /** §6.5's 180 s session deadline or §7.2's 120 s code lifetime elapsed. */
  | 'deadlineExceeded'
  /** All `MAX_RUNS_PER_SESSION` runs failed key confirmation. */
  | 'runsExhausted'
  /** The code failed §7.1 local normalization; no attempt was consumed. */
  | 'invalidCode'
  /** No §4.2 nonce available, so `/pair` cannot be opened at all. */
  | 'missingNonce'
  /** The WebSocket could not be opened; the browser exposes no safe detail. */
  | 'channelUnavailable'
  /** `principal.browser` is not defined by the MBP1 wire schema. */
  | 'unsupportedBrowser'
  /** A ticket was supplied with no binding keypair to bind it to (§9.1). */
  | 'ticketWithoutBindingKeypair'
  /** The ticket's `bindingPub` is not the `bindingPub` sent to the host (§9.2). */
  | 'ticketBindingKeyMismatch'
  /** The host's ticket is not a well-formed ticket object (§9.2). */
  | 'malformedTicket'
  /** §6.1/§6.3: a malformed frame, unknown type, or bad point encoding. */
  | 'protocolViolation'
  /** §11: the peer speaks a `protocolVersion` this client does not implement. */
  | 'unsupportedVersion'
  /** A `pairError` this flow cannot retry through. `pairErrorCode` carries it. */
  | 'peerRejected'
  /** §11 `busy`/`rateLimited`: the peer asks for patience, not a refusal —
   *  kept distinct so the UI can say "try again later" instead of
   *  "declined". `pairErrorCode` carries which of the two it was. */
  | 'peerBusy'
  /** §6.3/§7.2: the shared secret `K` was the identity element. */
  | 'identityK'
  /** The peer accepted `cA` but its `confirmB` did not verify. */
  | 'peerNotAuthentic'
  /** §6.7 failed after mutual confirmation (envelope, storage, or transport). */
  | 'credentialPhaseFailed'
  /**
   * A non-`PairingFlowError` escaped from somewhere in this flow — a storage
   * rejection (quota, MV3 service-worker teardown), `CredentialStore`
   * throwing because a concurrent attempt's prune already removed this
   * credential between the orchestrator's read and this write, or any other
   * error this flow did not itself classify. **Keep the credential and the
   * pin, and do not iterate** — the failure carries no more specific
   * information than that.
   */
  | 'internalError'

interface PairingFlowErrorDetails {
  pairErrorCode?: PairErrorCode
  retryAtMs?: number
  attemptsRemaining?: number
}

/**
 * A first-pair failure. The optional detail fields are `null` rather than
 * absent so callers can read them without `exactOptionalPropertyTypes` dances,
 * and so a `PairingFlowError` is a plain data record the UI can switch on.
 *
 * `attemptsRemaining`, when present, is the peer's last claim and is **display
 * data only** — it never influenced any decision this flow made.
 */
export class PairingFlowError extends Error {
  readonly reason: PairingFailureReason
  readonly pairErrorCode: PairErrorCode | null
  readonly retryAtMs: number | null
  readonly attemptsRemaining: number | null

  constructor(
    reason: PairingFailureReason,
    message: string,
    details: PairingFlowErrorDetails = {}
  ) {
    super(message)
    this.name = 'PairingFlowError'
    this.reason = reason
    this.pairErrorCode = details.pairErrorCode ?? null
    this.retryAtMs = details.retryAtMs ?? null
    this.attemptsRemaining = details.attemptsRemaining ?? null
  }
}

/** What the flow can tell the UI when it asks the user for a code. */
export interface PairingCodeRequest {
  /** The §4.1 routing hint from `pairAccept`. Display only, never a signal. */
  instanceId: string
  /**
   * Milliseconds left before the code dies (§7.2). The provider MUST settle
   * within this — the flow cannot interrupt it, and a provider that waits
   * forever holds the session open past every deadline the spec sets.
   */
  timeoutMs: number
  /** 1-based run index, at most `MAX_RUNS_PER_SESSION`. */
  run: number
  /** The peer's last `attemptsRemaining`. Untrusted; for display only. */
  attemptsRemaining: number | null
}

export type PairingCodeProvider = (
  request: PairingCodeRequest
) => Promise<string>

/**
 * Where the pairing code comes from.
 *
 * A **provider** is the real shape: the code does not exist until the server
 * has queued its dialog, which happens in response to `pairHello`, so the
 * socket is necessarily already open when the user starts typing. A provider is
 * also what lets a mistyped code be re-entered on the next run.
 *
 * A plain **string** is accepted for the case where the code is known up front
 * (tests, and the e2e mock bridge). It is reused unchanged across runs, which
 * is correct: §6.5 allows a fresh run with the "same code while it lives".
 */
export type PairingCodeSource = string | PairingCodeProvider

export interface PairingFlowDeps {
  channel: FrameChannel
  creds: CredentialLifecycleSource
  pins: PinStore
  backoff: FirstPairBackoff
  /**
   * False once a newer connection attempt has superseded this one. Threaded
   * after **every** await: an MV3 worker can be driving a second attempt by the
   * time any of these promises resolve, and two flows racing to write a
   * credential for the same principal is exactly how one gets orphaned.
   */
  isCurrent: () => boolean
  /** Injectable clock. Defaults to `Date.now`. */
  now?: () => number
  /** Injectable CSPRNG for `x`. Defaults to the platform CSPRNG (§6.3). */
  random?: (n: number) => Uint8Array
}

type ResolvedPairingFlowDeps = Omit<PairingFlowDeps, 'creds'> & {
  creds: CredentialLifecycleStore
}

export interface PairingFlowRunArgs {
  code: PairingCodeSource
  discovery: DiscoveryResult
  principal: Principal
  /**
   * `pairHello.claimedExtensionId` and the fourth field of `A_id` (§6.4).
   *
   * Not part of `Principal`, and not derivable from `verifiedOrigin`: on
   * Firefox the origin is `moz-extension://<UUID>`, which maps to no Gecko id.
   * Injected rather than read from `browser.runtime.id` here so the flow stays
   * testable without an extension context.
   */
  claimedExtensionId: string
  /**
   * The §9.1 ephemeral keypair, generated once per pairing attempt by the
   * connection orchestrator and shared with the NM bootstrap. `pub` MUST be
   * byte-identical to the `bindingPub` sent to the host — Line A requires
   * `nmTicket.bindingPub === ticketBindingKey` and aborts under §9.2 otherwise,
   * so this flow checks it rather than letting the pairing die at the peer.
   */
  bindingKeypair?: BindingKeypair
  /**
   * The host's attestation ticket, passed through **unchanged**. Defaults to
   * `discovery.nmTicket` when omitted.
   *
   * Never omitted or stripped to get a better-looking dialog. §6.4 and the
   * §5 outcome table make a *downgraded* ticket land in `unverified`, which is
   * a **worse** identity than presenting none — so dropping a ticket that looks
   * stale would game the identity display, and that display is the user's only
   * signal about what the server actually verified. If the host returned a
   * ticket it goes on the wire; if the host degraded to ticketless, both this
   * and `ticketBindingKey` are absent.
   */
  nmTicket?: unknown
  /** Explicit WS/WSS route for a configured remote authority. When present no
   * local-port pin is read, cleared, or committed. */
  remotePairUrl?: string
}

export interface PairingFlowResult {
  credentialId: string
  /** The §6.6 channel, for MDXP `motrix/initialize` to run inside. */
  envelope: EnvelopeCodec
  /**
   * The peer's `instanceId`. Safe to use *here* — unlike a `/discovery` hint —
   * because `B_id` binds it into `TT` (§6.4), so a verified `confirmB` proves
   * the peer that holds the code claimed this exact id.
   */
  instanceId: string
}

/** Everything validated before a single byte moves. */
interface PreparedSession {
  port: number
  url: string
  persistLocalPins: boolean
  pairNonce: string
  browser: Mbp1Browser
  ticket: ParsedTicket | null
  rawTicket: unknown
  bindingKeypair: BindingKeypair | null
}

/** Mutable accounting for one `run` call, read by the exit path. */
interface SessionState {
  reachedPakeA: boolean
  confirmed: boolean
}

const textDecoder = new TextDecoder()

export class PairingFlow {
  private readonly deps: ResolvedPairingFlowDeps
  private readonly now: () => number
  private aborted = false

  constructor(deps: PairingFlowDeps) {
    this.deps = {
      ...deps,
      creds: resolveCredentialLifecycleStore(deps.creds),
    }
    this.now = deps.now ?? Date.now
  }

  async run(args: PairingFlowRunArgs): Promise<PairingFlowResult> {
    // Everything that can be decided locally is decided before the §7.3 gate,
    // so a caller error never consumes a lockout slot or an attempt.
    const prepared = this.prepare(args)

    const gate = await this.deps.backoff.check(this.now())
    this.ensureCurrent()
    if (!gate.allowed) {
      // §7.3: refuse to open `/pair` at all. Opening it and failing later would
      // still put a dialog on the user's screen, which is what the lockout
      // exists to prevent.
      throw new PairingFlowError(
        'backoffLocked',
        'first-pair backoff is active; try again later',
        gate.retryAtMs === undefined ? {} : { retryAtMs: gate.retryAtMs }
      )
    }

    const state: SessionState = { reachedPakeA: false, confirmed: false }
    try {
      return await this.session(args, prepared, state)
    } catch (error) {
      if (state.reachedPakeA && !state.confirmed) {
        // §7.3, including the case where this flow itself abandoned the run.
        // A storage failure here must not replace the caller's diagnostic: it
        // cannot be attacker-induced, and the next `check` reads whatever did
        // land.
        try {
          await this.deps.backoff.recordFailure(this.now())
        } catch {
          // Intentionally swallowed; see above.
        }
      }
      // Closed on **every** failure path, and only on failure: a socket left
      // open past a failed run holds one of the server's three pending dialog
      // slots (§7.3), while on success the caller owns the socket from here on
      // — MDXP `motrix/initialize` runs inside the envelope this returns, so
      // closing it would tear down the session that was just established.
      this.deps.channel.close()
      throw error instanceof PairingFlowError
        ? error
        : this.wrapUnknownError(error)
    }
  }

  /**
   * Discards this run at its next checkpoint. Does **not** zeroize anything —
   * it cannot. The SPAKE2 scalars (`w`, `x`) and every key this run derives
   * are locals inside `runAttempts`/`session`, never promoted to a field of
   * this class specifically so that a method with no access to another call
   * frame's locals is never tempted to overwrite them in place. This just
   * flips a flag `ensureCurrent()` already checks after every await, so the
   * run's next checkpoint throws and that call frame unwinds; the scalars and
   * derived keys become unreachable — and therefore GC-eligible — at that
   * point, on whatever schedule the engine chooses. JavaScript offers no way
   * to erase them sooner, and a `bigint` in particular cannot be erased at
   * all: it is immutable, so overwriting the variable only drops this
   * reference while the original value stays wherever the engine put it.
   *
   * Also closes the channel, so a run currently blocked inside `receiveText`/
   * `receiveBinary` — waiting on a peer that will never answer, for instance
   * — unblocks immediately instead of waiting out the full §6.5/§7.2 deadline
   * first. `FrameChannel.close()` is documented to make a pending receive
   * reject rather than hang, which is what turns the flag flip into an
   * immediate rejection instead of one deferred until the next natural I/O.
   */
  abort(): void {
    this.aborted = true
    this.deps.channel.close()
  }

  // -- local validation ----------------------------------------------------

  private prepare(args: PairingFlowRunArgs): PreparedSession {
    const { discovery, principal } = args
    if (discovery.nonce === undefined || discovery.nonce.length === 0) {
      throw new PairingFlowError(
        'missingNonce',
        '/pair requires a §4.2 nonce; call DiscoveryService.ensureNonce first'
      )
    }
    if (!isMbp1Browser(principal.browser)) {
      throw new PairingFlowError(
        'unsupportedBrowser',
        'pairHello.browser must be chromium, firefox, or safari'
      )
    }

    // `args.nmTicket` wins only because an explicit argument is the more
    // specific statement; `discovery.nmTicket` is the normal source and the
    // fallback keeps a caller from silently downgrading to ticketless by
    // forgetting to forward it.
    const rawTicket = args.nmTicket ?? discovery.nmTicket
    const bindingKeypair = args.bindingKeypair ?? null

    if (rawTicket === undefined || rawTicket === null) {
      return {
        port: discovery.wsPort,
        url: args.remotePairUrl ?? pairUrl(discovery.wsPort, discovery.nonce),
        persistLocalPins: args.remotePairUrl === undefined,
        pairNonce: discovery.nonce,
        browser: principal.browser,
        ticket: null,
        rawTicket: undefined,
        // A binding key exists only to prove possession of a host ticket.
        // Carrying it into ticketless AAD would make the client bind bytes
        // that never appeared in pairHello, so discard it defensively even if
        // a caller accidentally supplied one after NM degraded to no ticket.
        bindingKeypair: null,
      }
    }

    if (bindingKeypair === null) {
      // Fail closed rather than stripping the ticket. Sending it without a
      // `ticketBindingKey` is a `protocolViolation` at the peer, and dropping
      // it would silently downgrade the identity the user is shown.
      throw new PairingFlowError(
        'ticketWithoutBindingKeypair',
        'an nmTicket was supplied without the §9.1 binding keypair that signs its proof'
      )
    }

    let ticket: ParsedTicket
    try {
      ticket = parseNmTicket(rawTicket)
    } catch {
      // §9.2 aborts on a structurally broken ticket, so this pairing could not
      // succeed anyway; refusing here costs no attempt and no backoff.
      throw new PairingFlowError(
        'malformedTicket',
        'the host returned a ticket this client cannot parse into §6.4 digest fields'
      )
    }
    if (!timingSafeEqualBytes(ticket.bindingPub, bindingKeypair.pub)) {
      // Line A requires `nmTicket.bindingPub === ticketBindingKey` and aborts
      // under §9.2 otherwise. Catching it locally turns "every ticketed pairing
      // mysteriously aborts" into one named error at the one place the
      // invariant is checkable.
      throw new PairingFlowError(
        'ticketBindingKeyMismatch',
        'the ticket is bound to a different key than this attempt holds'
      )
    }

    return {
      port: discovery.wsPort,
      url: args.remotePairUrl ?? pairUrl(discovery.wsPort, discovery.nonce),
      persistLocalPins: args.remotePairUrl === undefined,
      pairNonce: discovery.nonce,
      browser: principal.browser,
      ticket,
      rawTicket,
      bindingKeypair,
    }
  }

  // -- the session ---------------------------------------------------------

  private async session(
    args: PairingFlowRunArgs,
    prepared: PreparedSession,
    state: SessionState
  ): Promise<PairingFlowResult> {
    try {
      await this.deps.channel.open(prepared.url)
    } catch {
      throw new PairingFlowError(
        'channelUnavailable',
        'the pairing channel could not be opened'
      )
    }
    this.ensureCurrent()

    const helloFrame = buildPairHello({
      browser: prepared.browser,
      claimedExtensionId: args.claimedExtensionId,
      clientInstallationId: args.principal.clientInstallationId,
      ...(prepared.ticket === null
        ? {}
        : {
            nmTicket: prepared.rawTicket,
            ticketBindingKey: b64uEncode(
              // The exact bytes the host was sent, not a re-derived key.
              (prepared.bindingKeypair as BindingKeypair).pub
            ),
          }),
    })
    // §6.5's session deadline runs from `pairHello`, so it starts here.
    const sessionDeadline = this.now() + SESSION_DEADLINE_MS
    await this.deps.channel.sendText(helloFrame)
    this.ensureCurrent()

    const accept = await this.expect('pairAccept', sessionDeadline)
    assertProtocolVersionOrThrow(accept.protocolVersion)
    // §7.2: the code was generated when the dialog was queued, which is what
    // this frame reports. `pairAccept` proves nothing else — not approval, not
    // that a code will ever be typed.
    const codeDeadline = this.now() + CODE_LIFETIME_MS
    const instanceId = accept.instanceId

    const aId = buildAId({
      browser: prepared.browser,
      verifiedOrigin: args.principal.verifiedOrigin,
      claimedExtensionId: args.claimedExtensionId,
      clientInstallationId: args.principal.clientInstallationId,
    })
    const bId = buildBId(instanceId)
    const aad = buildAad({
      protocolVersion: MBP1_PROTOCOL_VERSION,
      pairNonce: prepared.pairNonce,
      ticketBindingKey: prepared.bindingKeypair?.pub ?? null,
      ticket: prepared.ticket,
    })

    const confirmed = await this.runAttempts({
      args,
      prepared,
      state,
      instanceId,
      aId,
      bId,
      aad,
      // Both deadlines bind during the code-bearing phase; the tighter one is
      // §7.2's code lifetime, since the code dies before the session does.
      deadline: Math.min(sessionDeadline, codeDeadline),
    })

    // §7.3 counts failures only until mutual confirmation. Reset immediately
    // after a verified confirmB, before envelope/credential persistence: a
    // later storage failure is an operational error, not another bad-code
    // attempt, and must not leave the user locked out on their next retry.
    await this.deps.backoff.recordSuccess()
    this.ensureCurrent()

    // §6.6: the channel is live in both directions from here. Only now has the
    // user provably approved.
    const traffic = pairTrafficKeys(confirmed.Ke)
    const envelope = await EnvelopeCodec.create(
      traffic.c2s,
      traffic.s2c,
      'client'
    )
    this.ensureCurrent()

    const credentialId = await this.issueCredential({
      envelope,
      principal: args.principal,
      instanceId,
      port: prepared.port,
      persistLocalPins: prepared.persistLocalPins,
      // The code is dead once confirmed (Line A drops it at the same point), so
      // only §6.5's absolute session deadline still applies. The server's own
      // 150 s pre-authentication backstop may close first; that surfaces as a
      // rejected receive.
      deadline: sessionDeadline,
    })

    return { credentialId, envelope, instanceId }
  }

  /**
   * §6.5/§7.2: up to `MAX_RUNS_PER_SESSION` protocol runs on one socket, each
   * with a **fresh `x`**, retrying only through `codeMismatch`.
   *
   * The ceiling is this side's own and is enforced by the loop bound alone —
   * nothing the peer sends can extend it. `attemptsRemaining` is carried along
   * only to be handed to the code provider for display.
   */
  private async runAttempts(ctx: {
    args: PairingFlowRunArgs
    prepared: PreparedSession
    state: SessionState
    instanceId: string
    aId: Uint8Array
    bId: Uint8Array
    aad: Uint8Array
    deadline: number
  }): Promise<Spake2ClientResult> {
    const { prepared, state, aId, bId, aad, deadline } = ctx
    let attemptsRemaining: number | null = null
    // `deriveW` is a 2^14 scrypt; cache it per normalized code so three runs on
    // the same code pay it once, exactly as Line A caches `w` per code.
    let cachedCode: string | null = null
    let cachedW: bigint | null = null

    for (let run = 1; run <= MAX_RUNS_PER_SESSION; run++) {
      const code = await this.resolveCode(ctx.args.code, {
        instanceId: ctx.instanceId,
        timeoutMs: this.budget(deadline),
        run,
        attemptsRemaining,
      })
      // The provider is trusted to settle within the `timeoutMs` just
      // handed to it (the shipped `pairing-code-source.ts` enforces this
      // itself), but this flow cannot cancel a pending call and has no way
      // to verify a non-conforming provider actually honoured it. Without
      // this re-check, an overrunning provider would let `pakeA` be sent —
      // and consume a §7.3 failure on both sides — for a code the server
      // has already destroyed under §7.2's 120 s lifetime.
      this.budget(deadline)

      if (code !== cachedCode) {
        cachedCode = code
        cachedW = scalarFromBytes(deriveW(code, prepared.pairNonce))
      }
      const w = cachedW as bigint
      // §6.3: `x` MUST be fresh per protocol run and never reused.
      const x = drawScalar(ED25519_GROUP.order, this.deps.random)
      const pA = spake2ClientShare(ED25519_GROUP, w, x)

      // From this line on the session owes §7.3 a failure unless it reaches
      // mutual confirmation. Set *before* the send, so a send that throws
      // mid-flight still counts: the server may have received the frame.
      state.reachedPakeA = true
      await this.deps.channel.sendText(buildPakeA(b64uEncode(pA)))
      this.ensureCurrent()

      const pakeB = await this.expectOrCodeMismatch('pakeB', deadline)
      if (pakeB === null) {
        attemptsRemaining = this.lastAttemptsRemaining
        continue
      }

      let result: Spake2ClientResult
      try {
        result = spake2ClientRun(ED25519_GROUP, {
          aId,
          bId,
          w,
          x,
          pB: b64uDecode(pakeB.pB),
          aad,
        })
      } catch (error) {
        if (error instanceof Spake2IdentityKError) {
          // §6.3/§7.2: a failed attempt. Not retried on this socket — the peer
          // is in `awaiting-confirmA` and would read a fresh `pakeA` as a
          // protocol violation, and `pB = w·N` cannot happen with an honest
          // peer (its `y` is drawn from `[1, ℓ)`), so there is nothing to
          // recover for a legitimate user.
          throw new PairingFlowError(
            'identityK',
            'the SPAKE2 shared secret was the identity element'
          )
        }
        // A non-canonical or off-curve `pB` (§6.3).
        throw new PairingFlowError(
          'protocolViolation',
          'the peer sent a share that is not a canonical curve point'
        )
      }

      const ticketProof =
        prepared.ticket === null || prepared.bindingKeypair === null
          ? undefined
          : // `signTicketProof` prepends the label as raw UTF-8 bytes, NOT
            // `enc()`-wrapped (§6.5). Verified identical on both sides.
            b64uEncode(signTicketProof(prepared.bindingKeypair.priv, result.TT))
      // §6.5's cross-frame rule: `ticketProof` present iff an `nmTicket` was
      // sent. A schema cannot express it — only the session remembers.
      await this.deps.channel.sendText(
        buildConfirmA(b64uEncode(result.cA), ticketProof)
      )
      this.ensureCurrent()

      const confirmB = await this.expectOrCodeMismatch('confirmB', deadline)
      if (confirmB === null) {
        attemptsRemaining = this.lastAttemptsRemaining
        continue
      }

      // §6.5: A MUST verify `cB` before sending anything further, in constant
      // time.
      if (!timingSafeEqualBytes(b64uDecode(confirmB.cB), result.cB)) {
        // Not a retry. The peer accepted our `cA`, so it had the code — but
        // then failed to prove it holds the matching confirmation key, which no
        // honest Motrix can do. A wrong *code* never reaches this branch; it
        // comes back as `codeMismatch` above.
        throw new PairingFlowError(
          'peerNotAuthentic',
          'the peer accepted confirmA but its confirmB did not verify'
        )
      }

      state.confirmed = true
      return result
    }

    // §6.5: the local ceiling, hit regardless of what the peer reported.
    throw new PairingFlowError(
      'runsExhausted',
      `key confirmation failed on all ${MAX_RUNS_PER_SESSION} runs of this session`,
      {
        pairErrorCode: 'codeMismatch',
        ...(attemptsRemaining === null ? {} : { attemptsRemaining }),
      }
    )
  }

  /**
   * §6.7 inside the AEAD channel, in the one order that survives a crash at
   * every point:
   *
   * ```
   * credentialOffer -> writeProvisionalUnacked -> markCommitUncertain (durable)
   *   -> credentialAck -> credentialCommitted -> finalizeAndPrune
   *   -> clear each pruned pin -> commit this pin
   * ```
   *
   * The write-ahead before `credentialAck` is mandatory (§6.7 step 2).
   * `finalizeAndPrune`'s deletion callback is mandatory too: §12 requires
   * deleting the other credentials **and their pins** in the same serialized
   * plan/apply transaction.
   */
  private async issueCredential(ctx: {
    envelope: EnvelopeCodec
    principal: Principal
    instanceId: string
    port: number
    persistLocalPins: boolean
    deadline: number
  }): Promise<string> {
    const { envelope, principal, instanceId } = ctx
    const offer = await this.receiveSealed(envelope, ctx.deadline)
    if (offer.type !== 'credentialOffer') {
      throw new PairingFlowError(
        'credentialPhaseFailed',
        'expected credentialOffer inside the channel'
      )
    }
    const credentialId = offer.credentialId

    // Last gate before anything durable exists. After this point a superseded
    // attempt must NOT delete what it wrote — see below — so the check has to
    // happen here.
    this.ensureCurrent()
    try {
      await this.deps.creds.writeProvisionalUnacked(
        principal,
        {
          credentialId,
          mutualKey: offer.mutualKey,
        },
        instanceId
      )
    } catch (error) {
      // §6.7 requires a repeat offer for the same
      // `{principal, currentCommittedCredentialId}` to re-send the identical
      // `{credentialId, mutualKey}`. A different id while a live successor is
      // held contradicts that, so the store refuses it — and this is where that
      // becomes a wire verdict rather than an internal error, because the peer
      // is the one that broke the rule.
      if (error instanceof OfferContradictsSlotError) {
        throw new PairingFlowError('protocolViolation', error.message)
      }
      throw error
    }
    // A stale signal from here on aborts without deleting. §6.7 is explicit
    // that `commit-uncertain` may never be age-deleted and that an `unacked`
    // entry ages out on its own after 10 minutes, so the store's own recovery
    // paths (`ageOutUnacked`, `cleanupFirstPairOrphans`) are what clean up —
    // deleting by hand here would be the stranding the write-ahead prevents.
    this.ensureCurrent()

    // THE ordering that makes a crash survivable: this durable flip must land
    // before `credentialAck` is transmitted, so `commit-uncertain` means "the
    // ack MAY have been sent" and a crash in the gap retains the credential
    // instead of ageing it out.
    await this.deps.creds.markCommitUncertain(credentialId)
    this.ensureCurrent()

    await this.sendSealed(envelope, buildCredentialAck(credentialId))
    this.ensureCurrent()

    const committed = await this.receiveSealed(envelope, ctx.deadline)
    if (committed.type !== 'credentialCommitted') {
      throw new PairingFlowError(
        'credentialPhaseFailed',
        'expected credentialCommitted inside the channel'
      )
    }
    this.ensureCurrent()

    // §6.7/§12: promotion, active-pointer update, and post-authentication
    // pruning are one serialized transaction and one durable write.
    //
    // Pins are cleared BEFORE the credentials are deleted, and the order is the
    // point. `PinStore` is addressed by credentialId and cannot enumerate, so
    // deleting the credentials first puts their ids only in this call's local
    // array — and `ensureCurrent` throwing here (a newer attempt superseded
    // this one, no crash required) would strand every one of those pins
    // permanently. Clearing first makes the interruptible half the recoverable
    // half: a pin cleared while its credential still exists costs one candidate
    // sweep, and the next run re-derives the same list and re-clears it.
    await this.deps.creds.finalizeAndPrune(
      credentialId,
      principal,
      instanceId,
      async (staleIds) => {
        if (!ctx.persistLocalPins) return
        for (const staleId of staleIds) {
          await this.deps.pins.clear(staleId)
        }
      }
    )
    this.ensureCurrent()

    // §12: a pin is committed only after a mutually-authenticated session on
    // that port — which this is, and which is why it happens here and not when
    // `/discovery` first named the port.
    if (ctx.persistLocalPins) {
      await this.deps.pins.commit(credentialId, {
        port: ctx.port,
        instanceId: ctx.instanceId,
      })
    }
    this.ensureCurrent()
    return credentialId
  }

  // -- transport helpers ---------------------------------------------------

  private lastAttemptsRemaining: number | null = null

  /**
   * Awaits one text frame and requires it to be `type`.
   *
   * A `pairError` here is terminal: the caller that can retry through
   * `codeMismatch` uses `expectOrCodeMismatch` instead.
   */
  private async expect<T extends ServerFrame['type']>(
    type: T,
    deadline: number
  ): Promise<Extract<ServerFrame, { type: T }>> {
    const frame = await this.receiveText(deadline)
    if (frame.type === 'pairError') {
      throw this.pairErrorToFlowError(frame)
    }
    if (frame.type !== type) {
      throw new PairingFlowError(
        'protocolViolation',
        `expected ${type} but the peer sent another frame`
      )
    }
    return frame as Extract<ServerFrame, { type: T }>
  }

  /**
   * As `expect`, but returns `null` on `pairError {code:"codeMismatch"}` — the
   * one error §6.5 lets a fresh run follow. Every other code is terminal.
   */
  private async expectOrCodeMismatch<T extends ServerFrame['type']>(
    type: T,
    deadline: number
  ): Promise<Extract<ServerFrame, { type: T }> | null> {
    const frame = await this.receiveText(deadline)
    if (frame.type === 'pairError') {
      if (frame.code !== 'codeMismatch') {
        throw this.pairErrorToFlowError(frame)
      }
      this.lastAttemptsRemaining = frame.attemptsRemaining ?? null
      return null
    }
    if (frame.type !== type) {
      throw new PairingFlowError(
        'protocolViolation',
        `expected ${type} but the peer sent another frame`
      )
    }
    return frame as Extract<ServerFrame, { type: T }>
  }

  private async receiveText(deadline: number): Promise<ServerFrame> {
    const raw = await this.deps.channel.receiveText(this.budget(deadline))
    this.ensureCurrent()
    try {
      return parseTextFrame(raw)
    } catch (error) {
      throw toFlowError(error)
    }
  }

  private async sendSealed(
    envelope: EnvelopeCodec,
    frame: object
  ): Promise<void> {
    const sealed = await envelope.seal(utf8(JSON.stringify(frame)))
    this.ensureCurrent()
    await this.deps.channel.sendBinary(sealed)
  }

  private async receiveSealed(
    envelope: EnvelopeCodec,
    deadline: number
  ): Promise<ServerFrame> {
    const raw = await this.deps.channel.receiveBinary(this.budget(deadline))
    this.ensureCurrent()
    let plaintext: Uint8Array
    try {
      plaintext = await envelope.open(raw)
    } catch {
      // §10: any gap, repeat, or GCM failure closes the connection. Attribution
      // follows the method that threw — this one is the peer's frame.
      throw new PairingFlowError(
        'credentialPhaseFailed',
        'an envelope frame failed to open'
      )
    }
    this.ensureCurrent()
    try {
      return parseTextFrame(textDecoder.decode(plaintext))
    } catch (error) {
      throw toFlowError(error)
    }
  }

  private budget(deadline: number): number {
    const remaining = deadline - this.now()
    if (remaining <= 0) {
      throw new PairingFlowError(
        'deadlineExceeded',
        'the pairing session ran out of time (§6.5 / §7.2)'
      )
    }
    return remaining
  }

  private async resolveCode(
    source: PairingCodeSource,
    request: PairingCodeRequest
  ): Promise<string> {
    const raw = typeof source === 'string' ? source : await source(request)
    this.ensureCurrent()
    // §7.1 local normalization. A string that fails it consumes no attempt —
    // the popup is the real gate, this is defense in depth for any other caller.
    const normalized = normalizePairingCode(raw)
    if (normalized === null) {
      throw new PairingFlowError(
        'invalidCode',
        'the pairing code failed §7.1 local normalization'
      )
    }
    return normalized
  }

  private pairErrorToFlowError(frame: PairErrorFrame): PairingFlowError {
    if (frame.code === 'unsupportedVersion') {
      return new PairingFlowError(
        'unsupportedVersion',
        'the peer rejected this protocol version',
        { pairErrorCode: frame.code }
      )
    }
    return new PairingFlowError(
      frame.code === 'busy' || frame.code === 'rateLimited'
        ? 'peerBusy'
        : 'peerRejected',
      frame.code === 'busy' || frame.code === 'rateLimited'
        ? 'the peer is rate-limiting pairing; try again later'
        : 'the peer refused the pairing',
      {
        pairErrorCode: frame.code,
        ...(frame.attemptsRemaining === undefined
          ? {}
          : { attemptsRemaining: frame.attemptsRemaining }),
      }
    )
  }

  private ensureCurrent(): void {
    if (this.aborted) {
      throw new PairingFlowError('aborted', 'the run was aborted')
    }
    if (!this.deps.isCurrent()) {
      throw new PairingFlowError(
        'staleAttempt',
        'a newer connection attempt superseded this one'
      )
    }
  }

  /**
   * Wraps any error this flow did not itself classify — a storage rejection
   * (quota, MV3 service-worker teardown), `CredentialStore` throwing because
   * a concurrent attempt's prune already removed this credential between the
   * orchestrator's read and this write, or anything else unmodelled. A
   * caller switching on `error.reason` seeing `undefined` is a worse outcome
   * than a coarse `internalError`.
   *
   * `abort()` takes priority over everything else here. Closing the channel
   * is what unblocks a receive that was already pending when `abort()` ran,
   * and that unblocking surfaces as a plain rejection from the channel
   * itself (never a `PairingFlowError`) — arriving here, not at
   * `ensureCurrent()`'s own checkpoint, since the channel's rejection is what
   * threw, not the checkpoint that never got a chance to run. Once the
   * caller has aborted, every failure downstream of that is a consequence of
   * the abort, whatever its proximate shape — reporting one as `internalError`
   * would say something actually went wrong when the honest answer is just
   * that the caller gave up.
   *
   * This forwards `error.message` verbatim rather than a fixed generic
   * string, because "which step failed" is the whole diagnosis for exactly
   * the errors that reach here — a durable-write rejection or a corrupted
   * store. That is only safe because of a constraint on this flow's own
   * dependencies, not a property of this function: **nothing this flow
   * depends on may interpolate a value into a thrown message.** The current
   * sources all honour it: `canonical.ts`'s decoders name only a length, a
   * single offending character, or a fixed string, never key material;
   * `credential-store.ts`'s own module doc states its thrown messages never
   * interpolate a `credentialId`; `scrypt-w.ts` has one throw site with a
   * fixed string; `spake2-core.ts`'s throws are fixed strings or interpolate
   * only a scalar's fixed label (`'w'`/`'x'`/`'y'`), never its value; and
   * `ticket-bootstrap.ts` and `first-pair-backoff.ts` throw nothing of their
   * own at all. If a future dependency's error can carry a secret or other
   * sensitive value, this function needs a message allowlist before that
   * dependency is wired in here, not after.
   */
  private wrapUnknownError(error: unknown): PairingFlowError {
    if (this.aborted) {
      return new PairingFlowError('aborted', 'the run was aborted')
    }
    return new PairingFlowError(
      'internalError',
      error instanceof Error ? error.message : 'an unclassified error occurred'
    )
  }
}

/** §11: a version mismatch is `unsupportedVersion`, never a generic violation. */
function assertProtocolVersionOrThrow(protocolVersion: number): void {
  try {
    assertProtocolVersion(protocolVersion)
  } catch (error) {
    throw toFlowError(error)
  }
}

/**
 * Maps a `FrameError` onto the §11 code it belongs to, keeping
 * `unsupportedVersion` distinct from `protocolViolation` on this side of the
 * wire too.
 */
function toFlowError(error: unknown): unknown {
  if (!(error instanceof FrameError)) return error
  if (error.kind === 'unsupportedVersion') {
    return new PairingFlowError('unsupportedVersion', error.message)
  }
  return new PairingFlowError('protocolViolation', error.message)
}
