// MBP1 reconnect session state machine
// (docs/bridge-pairing-protocol.md §8, §6.7's durable-promotion paragraph,
// §11).
//
// This is the `/v1` counterpart to `pair-session.ts`: a returning extension
// authenticates through a challenge–response, never a bearer token on the
// wire. The whole exchange is one round trip — the server speaks first with
// `reconnectChallenge`, the client answers with exactly one `reconnectResponse`,
// and the server either promotes-then-accepts or fails uniformly. Every byte
// leaves through the injected `sendText`/`close`, matching `pair-session.ts`'s
// transport-neutral shape.
//
// Two orderings here are load-bearing:
//
//   1. **§6.7 durable promotion precedes the accept.** When the authenticating
//      credential is `provisional`, `promoteOnReconnect` — the store's single
//      durable transaction that CAS-promotes the successor and revokes the
//      predecessor together — MUST resolve before `reconnectAccept` reaches
//      the wire. A crash between "verified" and "promoted" would otherwise
//      leave a just-authenticated credential merely provisional, where it can
//      later expire and strand the client. An already-`committed` credential
//      needs no promotion and is never passed to `promoteOnReconnect` — the
//      store rejects anything that is not a live provisional (mirrors
//      `commitFromPair`'s contract in `credential-store.ts`), so calling it
//      unconditionally would break the ordinary, no-rotation reconnect.
//
//   2. **Unknown-`credentialId` and bad-MAC are the same code path.** The MAC
//      is verified against a real key when the id is known and a fixed-length
//      dummy key when it is not, and the verify call happens exactly once
//      either way — no short-circuit `return` before it — so a stored-id
//      oracle never opens up (§8, §11).
//
// This module logs nothing at any level: `mutualKey`, the reconnect MACs, and
// the traffic keys are all in scope here and all forbidden from any log
// (§11).

import { timingSafeEqual } from 'node:crypto'
import type { Browser } from '@shared/protocol/bridge'
import type { StoredCredential } from '../credential-store'
import { fromBase64Url, toBase64Url } from './canonical'
import { DIR_C2S, DIR_S2C, EnvelopeOpener, EnvelopeSealer } from './envelope'
import {
  frameEnvelopeSchema,
  MAX_PRE_AUTH_FRAME_BYTES,
  MBP1_PROTOCOL_VERSION,
  type PairErrorCode,
  type PairErrorFrame,
  pairErrorFrameSchema,
  reconnectAcceptFrameSchema,
  reconnectChallengeFrameSchema,
  reconnectResponseFrameSchema,
} from './frames'
import {
  buildRT,
  reconnectMacClient,
  reconnectMacServer,
  reconnectTrafficKeys,
} from './reconnect-mac'

/** The whole challenge–response must complete within this many ms of `start()` (§8). */
const RECONNECT_DEADLINE_MS = 10_000

/** `S`'s length: 32 CSPRNG bytes (§8). */
const CHALLENGE_BYTES = 32

/**
 * Fixed-length stand-in for an unknown credential's `mutualKey` (§8): keeps
 * the HMAC verify's cost identical whether or not `credentialId` exists, so
 * the surface never becomes a credential-ID oracle. Never a real key, so its
 * fixed (not random) value carries no risk.
 */
const DUMMY_MUTUAL_KEY = new Uint8Array(32)

/**
 * The two `Mbp1CredentialStore` operations §8's reconnect flow needs.
 * Narrowed to what this module calls, matching `pair-session.ts`'s
 * `PairCredentialIssuer`: `Mbp1CredentialStore` is a class with private
 * state, so a test double is not structurally assignable to it, while the
 * real store satisfies this narrower shape without any change.
 */
export interface ReconnectCredentialAuthenticator {
  /** Looks up a credential for authentication, provisional or committed (§8). */
  findForAuth(credentialId: string): StoredCredential | null
  /**
   * Durable CAS promote-new+revoke-old, run as one transaction, for a
   * `provisional` credential (§6.7). Must be called only for a credential
   * whose `state` is `provisional` — the store rejects anything else.
   */
  promoteOnReconnect(credentialId: string): Promise<void>
}

export interface ReconnectSessionDeps {
  /** The `Origin` header value, never a self-reported field (§5, §8). */
  verifiedOrigin: string
  browser: Browser
  instanceId: string
  credentials: ReconnectCredentialAuthenticator
  sendText(json: object): void
  close(reason: string): void
  /**
   * Fires once `reconnectAccept` is on the wire, handing over the *live*
   * envelope endpoints and the credential that authenticated — already
   * promoted, if this run promoted it.
   */
  onAuthenticated(
    channel: { sealer: EnvelopeSealer; opener: EnvelopeOpener },
    credential: StoredCredential
  ): void
  now(): number
  random(n: number): Uint8Array
}

type ReconnectState =
  | 'awaiting-response'
  | 'processing'
  | 'authenticated'
  | 'closed'

export class ReconnectSession {
  private readonly deps: ReconnectSessionDeps
  private state: ReconnectState = 'awaiting-response'
  private challengeS: Uint8Array | null = null
  private deadlineAt = 0

  constructor(deps: ReconnectSessionDeps) {
    this.deps = deps
  }

  /** Server speaks first on `/v1`: `reconnectChallenge` with a fresh `S` (§8). */
  start(): void {
    this.challengeS = this.deps.random(CHALLENGE_BYTES)
    this.deadlineAt = this.deps.now() + RECONNECT_DEADLINE_MS
    const challengeFrame = {
      type: 'reconnectChallenge',
      protocolVersion: MBP1_PROTOCOL_VERSION,
      S: toBase64Url(this.challengeS),
    }
    if (!reconnectChallengeFrameSchema.safeParse(challengeFrame).success) {
      this.terminate('reconnectChallengeInvalid')
      return
    }
    this.deps.sendText(challengeFrame)
  }

  async handleText(raw: string, byteLength: number): Promise<void> {
    if (this.state === 'closed' || this.state === 'authenticated') {
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
      case 'reconnectResponse':
        await this.onReconnectResponse(body)
        return
      default:
        this.violation()
    }
  }

  /**
   * Ends the session without writing to the socket: the peer is gone, the
   * wiring's own pre-authentication deadline table is closing it, or explicit
   * credential revocation is cancelling same-Origin handshakes. Mirrors
   * `PairSession.dispose`.
   */
  dispose(_reason: 'socket-closed' | 'timeout' | 'access-revoked'): void {
    if (this.state === 'closed') {
      return
    }
    this.state = 'closed'
    this.challengeS = null
  }

  // -- §8 reconnectResponse -------------------------------------------------

  private async onReconnectResponse(body: unknown): Promise<void> {
    if (this.state !== 'awaiting-response' || this.challengeS === null) {
      this.violation()
      return
    }
    // A response that arrives after the 10 s deadline is treated exactly
    // like a failed challenge–response (§8): the whole exchange did not
    // complete in time, and this must not be distinguishable from a bad MAC.
    if (this.deps.now() >= this.deadlineAt) {
      this.fail('authFailed')
      return
    }

    const parsed = reconnectResponseFrameSchema.safeParse(body)
    if (!parsed.success) {
      this.violation()
      return
    }

    // Reject any further frame from here on — including a second
    // `reconnectResponse` racing the `await` below — before doing any of the
    // (synchronous) verification work.
    this.state = 'processing'

    const c = fromBase64Url(parsed.data.C)
    const presentedMac = fromBase64Url(parsed.data.mac)

    // §8: `browser`/`verifiedOrigin` in RT are the live connection's values,
    // never anything the client claims. That protects against an honest client
    // replaying a credential with its stored transcript, but it is NOT enough
    // when an attacker has stolen the key and recomputes the MAC for its own
    // Origin; the explicit stored-principal comparison below closes that gap.
    const credential = this.deps.credentials.findForAuth(
      parsed.data.credentialId
    )

    // `buildRT`'s `enc()` throws on a non-ASCII `verifiedOrigin`/`instanceId`
    // — deps-supplied, unlike the frame's own fields, and not schema-validated
    // the way `credentialId`/`C`/`mac` are — and a corrupted `mutualKeyB64`
    // fails `fromBase64Url`'s canonical check. Neither is the peer's fault in
    // a way §11 has a code for, so both collapse into the same uniform
    // authFailed + close as every other reconnect authentication failure —
    // never an uncaught rejection escaping this handler (mirrors
    // `pair-session.ts`'s guarded `buildAad`/`buildAId`/`generatePairingCode`).
    let rt: Uint8Array
    let key: Uint8Array
    try {
      rt = buildRT({
        protocolVersion: MBP1_PROTOCOL_VERSION,
        credentialId: parsed.data.credentialId,
        browser: this.deps.browser,
        verifiedOrigin: this.deps.verifiedOrigin,
        instanceId: this.deps.instanceId,
      })
      key =
        credential === null
          ? DUMMY_MUTUAL_KEY
          : fromBase64Url(credential.mutualKeyB64)
    } catch {
      this.fail('authFailed')
      return
    }

    // Called exactly once regardless of whether `credentialId` was known —
    // no short-circuit before it — so an unknown id costs the same work as a
    // bad MAC and the surface is never an oracle for which ids exist (§8, §11).
    const macOk = this.verifyClientMac(
      key,
      this.challengeS,
      c,
      rt,
      presentedMac
    )
    const principalMatches =
      credential !== null && this.matchesLivePrincipal(credential)

    if (credential === null || !macOk || !principalMatches) {
      this.fail('authFailed')
      return
    }

    let authenticated: StoredCredential = credential
    if (credential.state === 'provisional') {
      try {
        // §6.7: durable first — a single transaction that promotes the
        // successor and revokes the predecessor together — and only then may
        // `reconnectAccept` exist. Never awaited-and-forgotten: a crash
        // between these two steps must not be possible.
        await this.deps.credentials.promoteOnReconnect(credential.credentialId)
      } catch {
        // A store-side fault (e.g. a lost single-flight CAS race). Local, not
        // the peer's — no frame, matching `pair-session.ts`'s
        // `credentialCommitFailed`/`credentialPersistFailed`.
        this.terminate('reconnectPromoteFailed')
        return
      }
      // The `await` above is the only yield point in this method. A
      // `dispose` or another frame's `violation()` during it already moved
      // `state` off `'processing'`; do not resurrect a session that ended
      // while we waited.
      if (this.state !== 'processing') {
        return
      }

      // Re-read after promotion: `findForAuth` returns the live stored
      // object, and the credential's `state` (and `committedAt`) changed
      // under us during the `await` above, so the pre-promotion reference is
      // stale.
      const promoted = this.deps.credentials.findForAuth(
        credential.credentialId
      )
      if (promoted === null) {
        // Unreachable in a correct store: a credential this call just
        // promoted must still be findable. Fail closed rather than hand the
        // wiring a channel with no credential to attach. Distinct reason from
        // the real promotion failure above, so a future diagnosis can tell
        // "the store rejected the promote" from "the store accepted it but
        // then lost the record" apart.
        this.terminate('reconnectPromotedCredentialMissing')
        return
      }
      if (!this.matchesLivePrincipal(promoted)) {
        // A store replacement/race must not change the principal between MAC
        // verification and adoption. Keep the peer-facing result uniform with
        // every other credential authentication failure.
        this.fail('authFailed')
        return
      }
      authenticated = promoted
    }

    // §8's 10 s deadline covers the whole exchange, including the durable
    // promotion await above — never send an accept the client's own deadline
    // has already abandoned. The promotion itself stands either way (§6.7
    // durable-first), so the next reconnect finds a committed credential;
    // this attempt just fails with the same uniform code a late response gets.
    if (this.deps.now() >= this.deadlineAt) {
      this.fail('authFailed')
      return
    }

    const macServer = reconnectMacServer(key, this.challengeS, c, rt)
    const acceptFrame = {
      type: 'reconnectAccept',
      mac: toBase64Url(macServer),
    }
    if (!reconnectAcceptFrameSchema.safeParse(acceptFrame).success) {
      this.terminate('reconnectAcceptInvalid')
      return
    }
    this.deps.sendText(acceptFrame)

    const { kC2S, kS2C } = reconnectTrafficKeys(key, this.challengeS, c)
    const channel = {
      sealer: new EnvelopeSealer(kS2C, DIR_S2C),
      opener: new EnvelopeOpener(kC2S, DIR_C2S),
    }
    this.state = 'authenticated'
    this.challengeS = null
    this.deps.onAuthenticated(channel, authenticated)
  }

  // -- shared helpers ---------------------------------------------------------

  /**
   * The constant-time MAC verify seam: computes `reconnectMacClient` and
   * compares in constant time. Kept as its own method (rather than inlined)
   * so both the known-id and unknown-id paths visibly funnel through the
   * same single call.
   */
  private verifyClientMac(
    mutualKey: Uint8Array,
    s: Uint8Array,
    c: Uint8Array,
    rt: Uint8Array,
    presentedMac: Uint8Array
  ): boolean {
    const expected = reconnectMacClient(mutualKey, s, c, rt)
    return constantTimeEqual(expected, presentedMac)
  }

  private matchesLivePrincipal(credential: StoredCredential): boolean {
    return (
      credential.principal.browser === this.deps.browser &&
      credential.principal.verifiedOrigin === this.deps.verifiedOrigin
    )
  }

  private violation(): void {
    this.fail('protocolViolation')
  }

  private fail(code: PairErrorCode): void {
    const frame: PairErrorFrame = { type: 'pairError', code }
    // Validated for the same reason `pair-session.ts`'s `sendPairError` is:
    // `frames.ts` claims one schema describes both directions, and a
    // construction bug in this locally-built frame is ours, not the peer's —
    // there is nowhere left to report it, so this terminates silently rather
    // than risk sending a second, possibly-also-broken `pairError`.
    if (!pairErrorFrameSchema.safeParse(frame).success) {
      this.terminate('pairErrorFrameInvalid')
      return
    }
    this.deps.sendText(frame)
    this.terminate(code)
  }

  private terminate(reason: string): void {
    if (this.state === 'closed') {
      return
    }
    this.state = 'closed'
    this.challengeS = null
    this.deps.close(reason)
  }
}

/** Constant-time equality; lengths are public, so an early length exit leaks nothing (§2). */
function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && timingSafeEqual(a, b)
}
