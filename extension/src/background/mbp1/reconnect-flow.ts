/**
 * MBP1 reconnect state machine (bridge-pairing-protocol.md §8, §6.7, §12).
 *
 * The code path a browser walks on every restart once it already holds a
 * committed credential: a short challenge-response on `/v1` that mutually
 * authenticates both sides against the stored `mutualKey`, with no code entry
 * and no user interaction.
 *
 * ```
 * open /v1 (no query credentials) -> reconnectChallenge { S }
 *   -> reconnectResponse { credentialId, C, mac: client } -> reconnectAccept { mac }
 *                                                              |
 *                     verify mac === server, constant-time, BEFORE anything else
 *                                                              |
 *                              traffic keys -> EnvelopeCodec (role 'client')
 *                                                              |
 *                    finalizeAndPrune -> clear pins -> pin
 * ```
 *
 * ## The one rule that makes this endpoint safe against an impostor
 *
 * §8 requires the client to send **no application data** — not even MDXP
 * `motrix/initialize` — until `reconnectAccept.mac` has been verified against
 * the locally computed `server` MAC, in constant time. A listener that is not
 * the real Motrix (something else bound to the port, or a stale process) would
 * otherwise learn whatever the first application frame reveals for free. That
 * verification happens before a single byte of §6.7's post-auth transaction is
 * touched, and before the caller ever sees the returned `EnvelopeCodec`.
 *
 * ## Two failure modes that look identical on the wire and need opposite handling
 *
 * The server answers an unknown `credentialId` and a bad client MAC with the
 * **same** `pairError {code:"authFailed"}`, deliberately, so the surface is
 * never a credential-ID oracle (§8, §11). That frame proves nothing about the
 * endpoint — it is pre-channel and any listener can forge it — so §12 forbids
 * deleting the credential on it, and the pin is left alone too: the endpoint
 * answered correctly, so it is still worth trying again with a different
 * credential.
 *
 * A `reconnectAccept` whose `mac` fails to verify is ambiguous, not proof of
 * an impostor: `RT` binds `credentialId`, `browser`, `verifiedOrigin`, AND
 * `instanceId`, and the orchestrator may supply `instanceId` from an
 * untrusted `/discovery` hint when no pin exists yet for this credential —
 * so a wrong hint against the *genuine* Motrix produces the identical
 * mismatch as a real "not my Motrix" impostor. Either way the
 * credential was never disproved — only this pin's claim about where it
 * lives was — so the credential is kept and only the **pin** is cleared: a
 * later attempt sweeps for the real instance instead of reusing an unproven
 * one. See `serverMacMismatch`'s own doc comment for why clearing is correct
 * under both readings.
 *
 * `ReconnectFlowError.reason` is how the caller (the connection orchestrator)
 * tells these apart; see the doc comment on each `ReconnectFailureReason` for the
 * disposition it implies.
 *
 * ## A third case the server never sends a frame for
 *
 * §8's per-origin and global reconnect throttle, and the pre-authentication
 * table's own capacity limit, are both enforced by rejecting the WebSocket
 * *upgrade* itself (or closing immediately after it, before a single frame is
 * sent) — there is no `pairError` for either, because no pre-auth session
 * object exists yet to send one from. The WebSocket API does not expose
 * handshake status codes to script, so this side cannot tell "the upgrade was
 * throttled" from "nothing is listening on this port" or "the process is
 * gone" — all three look like `channelUnavailable` here. That is why walking
 * to the next stored credential on a `channelUnavailable` is actively harmful
 * rather than merely useless: every attempt (regardless of which credential it
 * carries) counts against the same per-origin counter, so retrying only makes
 * a real throttle worse while learning nothing. See the reason's own doc
 * comment for the exact caller obligation.
 *
 * ## Logging
 *
 * Nothing here logs at any level (§11). `mutualKey`, `S`, `C`, both
 * reconnect MACs, and both derived traffic keys are all in scope in this
 * module and must never appear in a thrown message — the messages below name
 * a step, never a value.
 */

import { randomBytes } from '@noble/hashes/utils.js'
import {
  assertAscii,
  b64uDecode,
  b64uEncode,
  timingSafeEqualBytes,
} from '@/background/mbp1/canonical'
import type {
  CredentialLifecycleSource,
  CredentialLifecycleStore,
  Principal,
  StoredCredential,
} from '@/background/mbp1/credential-store'
import { resolveCredentialLifecycleStore } from '@/background/mbp1/credential-store'
import type { DiscoveryResult } from '@/background/mbp1/discovery-service'
import { EnvelopeCodec } from '@/background/mbp1/envelope'
import {
  assertProtocolVersion,
  buildReconnectResponse,
  type FrameChannel,
  FrameError,
  MBP1_PROTOCOL_VERSION,
  type PairErrorCode,
  type PairErrorFrame,
  parseTextFrame,
  type ReconnectAcceptFrame,
  type ReconnectChallengeFrame,
  reconnectUrl,
  type ServerFrame,
} from '@/background/mbp1/frames'
import type { PinStore } from '@/background/mbp1/pin-store'
import {
  reconnectMacs,
  reconnectTrafficKeys,
  reconnectTranscript,
} from '@/background/mbp1/reconnect-mac'

/**
 * §8: the challenge-response on `/v1` must complete within 10 s of the
 * upgrade. This is the number Line A's spec designs against — the server's
 * own session times out on the same 10 s internally, and its 15 s
 * pre-authentication backstop exists only so that *server-side* 10 s timeout
 * fires first and the peer receives a uniform `pairError{authFailed}` rather
 * than a bare socket close. That is a statement about what Line A sends when
 * its own budget runs out, not a guarantee about what this client observes:
 * `FrameChannel.receiveText` cannot distinguish a timeout from a close (see
 * `channelUnavailable`'s doc comment), so a real 10 s stall on this side is
 * far more likely to surface as `channelUnavailable`/`channelClosed` than as
 * `deadlineExceeded` — see that reason's own doc comment for what it actually
 * detects. Budgeting against 15 s would still blow the real deadline, so this
 * stays 10 s regardless.
 */
export const RECONNECT_DEADLINE_MS = 10_000

/** §8: the client-generated nonce `C` is 32 CSPRNG bytes. */
const C_BYTES = 32

/**
 * Why a reconnect attempt failed, and — since the two authentication failure
 * modes require opposite handling (see the module doc comment) — what the
 * caller must do about the stored credential and pin in each case.
 */
export type ReconnectFailureReason =
  /**
   * §11: `pairError {code:"authFailed"}` — the peer's uniform answer for
   * either an unrecognized `credentialId` or a bad client MAC; this side
   * cannot tell which. **Keep the credential and the pin.** §12 forbids
   * deleting a credential on a pre-channel frame any listener could forge,
   * and the pin identified the right endpoint — it is the credential that is
   * in question. The caller should fall through to the next stored
   * credential for this principal, not fall back to fresh pairing.
   */
  | 'authFailed'
  /**
   * `reconnectAccept.mac` did not match the locally computed server MAC.
   * This is **not proof of an impostor**: `RT` binds `credentialId`,
   * `browser`, `verifiedOrigin`, AND `instanceId`, and the orchestrator may
   * supply `instanceId` from an untrusted `/discovery` hint when no pin
   * exists yet for this credential — so a wrong hint against the *genuine*
   * Motrix produces the identical mismatch as a real "not my Motrix"
   * impostor. This flow has already cleared the pin by the
   * time it throws this, and that is correct under either reading: if the
   * `instanceId` came from the pin, the pin's claim is disproved and
   * clearing it is right; if it came from the untrusted hint, there was no
   * pin to begin with and `clear` no-oped. **Keep the credential** — it was
   * never disproved — and do not reuse *this pin* without
   * re-authenticating; fall back to a discovery sweep or fresh pairing.
   */
  | 'serverMacMismatch'
  /**
   * `budget()` found the 10 s window already exhausted **before** a receive
   * was even issued (only reachable via a clock jump between two receives,
   * e.g. a service-worker suspend/resume) — not "a receive stalled for
   * 10 s". `FrameChannel.receiveText` cannot distinguish a timeout from a
   * close (its contract rejects on either), so a real mid-receive stall
   * surfaces as `channelUnavailable` or `channelClosed` instead, never this.
   * Not evidence against either side either way. **Keep the credential and
   * the pin**; the caller may retry.
   */
  | 'deadlineExceeded'
  /**
   * `deps.isCurrent()` went false mid-flow: a newer connection attempt
   * superseded this one. The caller must not use anything this run
   * returned — there is nothing to use, since this always throws — but it
   * is not evidence that nothing happened: `ensureCurrent()` runs *after*
   * each of `finalizeAndPrune` and `pins.commit`,
   * so a `superseded` thrown late in `session()` can follow a fully-landed
   * §6.7/§12 transaction. Treat this run's own outcome as abandoned; do not
   * assume its side effects did not occur.
   */
  | 'superseded'
  /**
   * A malformed frame, an unexpected frame type or order (for example
   * `reconnectAccept` arriving before `reconnectChallenge`), a non-ASCII
   * `instanceId` that cannot be fed to `enc()`, or a `pairError` code other
   * than `authFailed`/`unsupportedVersion`. **Keep the credential and the
   * pin** — nothing here is verified evidence against either; the caller may
   * retry.
   */
  | 'protocolViolation'
  /**
   * §11: the peer speaks a `protocolVersion` this client does not implement.
   * **Keep the credential and the pin** — this is a version mismatch, not an
   * authentication failure.
   */
  | 'unsupportedVersion'
  /**
   * The channel closed, or the deadline ran out, strictly *after* the peer
   * had already sent at least one frame (i.e. after `reconnectChallenge`
   * arrived). **Keep the credential and the pin**; the caller may retry,
   * including against another stored credential — this is an ordinary
   * per-connection failure, not evidence of a throttle.
   */
  | 'channelClosed'
  /**
   * The channel never produced a single frame: `FrameChannel.open` itself
   * rejected, or the first `receiveText` (waiting for `reconnectChallenge`)
   * rejected with nothing pending. That rejection covers a close *and* a
   * timeout identically (`FrameChannel`'s own contract), so this reason also
   * covers "the socket is open and a live peer simply never spoke within
   * 10 s" — this side cannot tell that apart from a close, an upgrade
   * rejection, or nothing listening at all. §8's per-origin and global
   * reconnect throttle (and the pre-authentication table's capacity limit)
   * are enforced by rejecting the WebSocket upgrade with no frame ever sent,
   * which is one more thing this reason cannot distinguish from the others.
   * **Keep the credential and the pin, and do NOT iterate to another stored
   * credential on this port** — every attempt counts against the same
   * throttle counter regardless of which credential it carries, so retrying
   * only makes a real throttle worse while proving nothing. Back off
   * instead.
   */
  | 'channelUnavailable'
  /**
   * A non-`ReconnectFlowError` escaped from somewhere in this flow — a
   * storage rejection (quota, MV3 service-worker teardown),
   * `CredentialStore` throwing because a concurrent attempt's prune already
   * removed this credential between the orchestrator's read and this
   * write, or any other error this flow did not itself classify. **Keep
   * the credential and the pin, and do not iterate** — the failure carries
   * no more specific information than that.
   */
  | 'internalError'

interface ReconnectFlowErrorDetails {
  pairErrorCode?: PairErrorCode
}

/**
 * A reconnect failure. Modelled on `PairingFlowError`: `reason` is what the
 * caller switches on, and `pairErrorCode` — present only when the failure
 * came from an actual `pairError` frame — is carried for display/diagnostics
 * only and never drives any decision here.
 */
export class ReconnectFlowError extends Error {
  readonly reason: ReconnectFailureReason
  readonly pairErrorCode: PairErrorCode | null

  constructor(
    reason: ReconnectFailureReason,
    message: string,
    details: ReconnectFlowErrorDetails = {}
  ) {
    super(message)
    this.name = 'ReconnectFlowError'
    this.reason = reason
    this.pairErrorCode = details.pairErrorCode ?? null
  }
}

export interface ReconnectFlowDeps {
  channel: FrameChannel
  creds: CredentialLifecycleSource
  pins: PinStore
  /**
   * False once a newer connection attempt has superseded this one. Threaded
   * after **every** await, the same way `PairingFlow.ensureCurrent()` is —
   * two reconnects racing to authenticate the same stored credential is
   * exactly how one gets an orphaned durable write.
   */
  isCurrent: () => boolean
  /** Injectable clock. Defaults to `Date.now`. */
  now?: () => number
  /** Injectable CSPRNG for `C` (§8). Defaults to the platform CSPRNG. */
  random?: (n: number) => Uint8Array
}

type ResolvedReconnectFlowDeps = Omit<ReconnectFlowDeps, 'creds'> & {
  creds: CredentialLifecycleStore
}

export interface ReconnectFlowRunArgs {
  credential: StoredCredential
  discovery: DiscoveryResult
  principal: Principal
  /**
   * §8's `RT` needs `enc(instanceId)`, and `StoredCredential` carries no such
   * field. This is deliberately a `run` parameter rather than something read
   * off `discovery`: `DiscoveryResult.instanceId` is only the §4.1 routing
   * hint and is never trustworthy, while the pin's `instanceId` was proved by
   * an earlier verified `confirmB` or `reconnectAccept`. The orchestrator
   * (`ConnectionManager`) owns the recovery order and the pin lookup, so it
   * decides which source to pass here — this flow does not silently prefer
   * either one.
   */
  instanceId: string
  /** Explicit WS/WSS route for a configured remote authority. When present no
   * local-port pin is read, cleared, or committed. */
  remoteV1Url?: string
}

export interface ReconnectFlowResult {
  /** The §8 channel, for MDXP `motrix/initialize` to run inside. */
  envelope: EnvelopeCodec
}

export class ReconnectFlow {
  private readonly deps: ResolvedReconnectFlowDeps
  private readonly now: () => number

  constructor(deps: ReconnectFlowDeps) {
    this.deps = {
      ...deps,
      creds: resolveCredentialLifecycleStore(deps.creds),
    }
    this.now = deps.now ?? Date.now
  }

  async run(args: ReconnectFlowRunArgs): Promise<ReconnectFlowResult> {
    // Decided before the channel ever opens: `reconnectTranscript` (§8) feeds
    // exactly these four strings to `enc()`, which throws on non-ASCII input.
    // Guarding all four here turns that into a diagnosable
    // `protocolViolation` instead of an unhandled crash deep inside
    // transcript construction, and no channel needs closing if any rejects.
    this.assertAsciiField(args.credential.credentialId, 'credentialId')
    this.assertAsciiField(args.principal.browser, 'browser')
    this.assertAsciiField(args.principal.verifiedOrigin, 'verifiedOrigin')
    this.assertAsciiField(args.instanceId, 'instanceId')

    try {
      return await this.session(args)
    } catch (error) {
      // Closed on every failure path. On success the caller owns the socket
      // from here on — MDXP `motrix/initialize` runs inside the envelope this
      // returns.
      this.deps.channel.close()
      throw error instanceof ReconnectFlowError
        ? error
        : this.wrapUnknownError(error)
    }
  }

  private async session(
    args: ReconnectFlowRunArgs
  ): Promise<ReconnectFlowResult> {
    const { credential, discovery, principal, instanceId } = args

    await this.openChannel(args.remoteV1Url ?? reconnectUrl(discovery.wsPort))
    this.ensureCurrent()

    // §8: the 10 s budget starts at the upgrade, not at any later frame.
    const deadline = this.now() + RECONNECT_DEADLINE_MS

    const challenge = await this.receiveChallenge(deadline)
    const S = b64uDecode(challenge.S)
    const C = this.deps.random?.(C_BYTES) ?? randomBytes(C_BYTES)
    let mutualKey: Uint8Array
    try {
      mutualKey = b64uDecode(credential.mutualKey)
    } catch {
      // b64uDecode's own error interpolates the offending character — fine
      // for an ordinary wire frame, but this decodes a *stored credential*
      // field, so that character is drawn from key material. `internalError`
      // must never forward it (see `wrapUnknownError`'s own doc on this
      // constraint), so this is caught here with a fixed message instead of
      // letting the raw decode error reach it.
      throw new ReconnectFlowError(
        'internalError',
        'stored credential mutualKey is not valid base64url'
      )
    }
    const RT = reconnectTranscript({
      protocolVersion: MBP1_PROTOCOL_VERSION,
      credentialId: credential.credentialId,
      browser: principal.browser,
      verifiedOrigin: principal.verifiedOrigin,
      instanceId,
    })
    const macs = reconnectMacs(mutualKey, S, C, RT)

    let responseFrame: ReturnType<typeof buildReconnectResponse>
    try {
      // `buildReconnectResponse` self-validates against its own `.strict()`
      // schema; by this point `credentialId` has already passed
      // `assertAsciiField`, so this is defence in depth against a corrupted
      // stored value, not a live path.
      responseFrame = buildReconnectResponse({
        credentialId: credential.credentialId,
        C: b64uEncode(C),
        mac: b64uEncode(macs.client),
      })
    } catch (error) {
      throw this.toFlowError(error)
    }
    await this.deps.channel.sendText(responseFrame)
    this.ensureCurrent()

    const accept = await this.receiveAccept(deadline)

    // §8: verify in constant time, and before anything else goes out ON THE
    // WIRE. The pin-clear immediately below persists locally — that is
    // exactly what a proven mismatch requires — but no application data
    // leaves this side until this check passes.
    if (!timingSafeEqualBytes(b64uDecode(accept.mac), macs.server)) {
      // "Not my Motrix": the endpoint is disproved, not the credential.
      if (args.remoteV1Url === undefined) {
        await this.deps.pins.clear(credential.credentialId)
      }
      throw new ReconnectFlowError(
        'serverMacMismatch',
        'reconnectAccept.mac did not verify against the mutual key'
      )
    }

    const traffic = reconnectTrafficKeys(mutualKey, S, C)
    const envelope = await EnvelopeCodec.create(
      traffic.c2s,
      traffic.s2c,
      'client'
    )
    this.ensureCurrent()

    // §6.7/§12: a successful reconnect is an authenticated ack. Promotion,
    // active-pointer update, and pruning share one serialized transaction;
    // pins are cleared while every credential in the deletion plan is still
    // present, making an interruption recoverable rather than orphaning pins.
    await this.deps.creds.finalizeAndPrune(
      credential.credentialId,
      principal,
      instanceId,
      async (staleIds) => {
        if (args.remoteV1Url !== undefined) return
        for (const staleId of staleIds) {
          await this.deps.pins.clear(staleId)
        }
      }
    )
    this.ensureCurrent()

    if (args.remoteV1Url === undefined) {
      await this.deps.pins.commit(credential.credentialId, {
        port: discovery.wsPort,
        instanceId,
      })
    }
    this.ensureCurrent()

    return { envelope }
  }

  // -- transport helpers ----------------------------------------------------

  private async openChannel(url: string): Promise<void> {
    try {
      await this.deps.channel.open(url)
    } catch {
      throw new ReconnectFlowError(
        'channelUnavailable',
        'the /v1 upgrade did not complete'
      )
    }
  }

  private async receiveChallenge(
    deadline: number
  ): Promise<ReconnectChallengeFrame> {
    const frame = await this.receiveFrame(deadline, 'channelUnavailable')
    if (frame.type === 'pairError') {
      throw this.pairErrorToFlowError(frame)
    }
    if (frame.type !== 'reconnectChallenge') {
      throw new ReconnectFlowError(
        'protocolViolation',
        `expected reconnectChallenge but the peer sent ${frame.type}`
      )
    }
    this.assertProtocolVersionOrThrow(frame.protocolVersion)
    return frame
  }

  private async receiveAccept(deadline: number): Promise<ReconnectAcceptFrame> {
    // A frame has already arrived on this channel (the challenge), so any
    // close from here on is `channelClosed`, not `channelUnavailable`.
    const frame = await this.receiveFrame(deadline, 'channelClosed')
    if (frame.type === 'pairError') {
      throw this.pairErrorToFlowError(frame)
    }
    if (frame.type !== 'reconnectAccept') {
      throw new ReconnectFlowError(
        'protocolViolation',
        `expected reconnectAccept but the peer sent ${frame.type}`
      )
    }
    return frame
  }

  private async receiveFrame(
    deadline: number,
    closeReason: 'channelUnavailable' | 'channelClosed'
  ): Promise<ServerFrame> {
    const timeoutMs = this.budget(deadline)
    let raw: string
    try {
      raw = await this.deps.channel.receiveText(timeoutMs)
    } catch {
      // `FrameChannel.receiveText` rejects identically for a close and for a
      // timeout, so neither message may assert a close as fact.
      throw new ReconnectFlowError(
        closeReason,
        closeReason === 'channelUnavailable'
          ? 'no frame arrived — either the channel closed or the peer never spoke within the budget'
          : 'no further frame arrived after the peer had already sent one — either a close or a stall'
      )
    }
    this.ensureCurrent()
    try {
      return parseTextFrame(raw)
    } catch (error) {
      throw this.toFlowError(error)
    }
  }

  private budget(deadline: number): number {
    const remaining = deadline - this.now()
    if (remaining <= 0) {
      throw new ReconnectFlowError(
        'deadlineExceeded',
        'the §8 challenge-response did not complete within 10 s of the upgrade'
      )
    }
    return remaining
  }

  // -- error mapping ---------------------------------------------------------

  private pairErrorToFlowError(frame: PairErrorFrame): ReconnectFlowError {
    if (frame.code === 'authFailed') {
      return new ReconnectFlowError(
        'authFailed',
        'the peer rejected this credentialId or client MAC',
        { pairErrorCode: frame.code }
      )
    }
    if (frame.code === 'unsupportedVersion') {
      return new ReconnectFlowError(
        'unsupportedVersion',
        'the peer rejected this protocol version',
        { pairErrorCode: frame.code }
      )
    }
    return new ReconnectFlowError(
      'protocolViolation',
      `the peer refused reconnect with ${frame.code}`,
      { pairErrorCode: frame.code }
    )
  }

  private assertProtocolVersionOrThrow(protocolVersion: number): void {
    try {
      assertProtocolVersion(protocolVersion)
    } catch (error) {
      throw this.toFlowError(error)
    }
  }

  /** §11: keeps `unsupportedVersion` distinct from a generic `protocolViolation`. */
  private toFlowError(error: unknown): unknown {
    if (!(error instanceof FrameError)) return error
    if (error.kind === 'unsupportedVersion') {
      return new ReconnectFlowError('unsupportedVersion', error.message)
    }
    return new ReconnectFlowError('protocolViolation', error.message)
  }

  private assertAsciiField(value: string, field: string): void {
    try {
      assertAscii(value, field)
    } catch {
      throw new ReconnectFlowError(
        'protocolViolation',
        `${field} is not ASCII and cannot be fed to enc() for the §8 transcript`
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
   * This forwards `error.message` verbatim rather than a fixed generic
   * string, because "which step failed" is the whole diagnosis for exactly
   * the errors that reach here — a durable-write rejection or a corrupted
   * store. That is only safe because of a constraint on this flow's own
   * dependencies, not a property of this function: **nothing this flow
   * depends on may interpolate a value into a thrown message.** The two
   * current sources honour it — `canonical.ts`'s decoders name only a
   * length, a single offending character, or a fixed string, never
   * key material, and `credential-store.ts`'s own module doc states its
   * thrown messages never interpolate a `credentialId`. If a future
   * dependency's error can carry a secret or other sensitive value, this
   * function needs a message allowlist before that dependency is wired in
   * here, not after.
   */
  private wrapUnknownError(error: unknown): ReconnectFlowError {
    return new ReconnectFlowError(
      'internalError',
      error instanceof Error ? error.message : 'an unclassified error occurred'
    )
  }

  private ensureCurrent(): void {
    if (!this.deps.isCurrent()) {
      throw new ReconnectFlowError(
        'superseded',
        'a newer connection attempt superseded this reconnect'
      )
    }
  }
}
