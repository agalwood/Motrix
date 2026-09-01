// A client-side MBP1 implementation for the transport integration tests.
//
// It deliberately composes the SAME `mbp1/` modules the server uses rather
// than re-deriving any encoding: the point is to exercise the server's wiring
// over a real socket, and a hand-rolled client would only prove that two
// hand-rolled implementations agree with each other. Because the primitives are
// shared, this doubles as the in-repo cross-check of the server's role
// assignments — a swapped direction tag, transcript identity, or HKDF label
// fails here even though both sides call the same function.
//
// Test-only. Nothing in `src/` imports this.

import { Buffer } from 'node:buffer'
import { randomBytes } from 'node:crypto'
import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { createMdxpConnection, type MdxpConnection } from '@motrix/mdxp'
import { utf8ToBytes } from '@noble/hashes/utils.js'
import type { Browser } from '@shared/protocol/bridge'
import WebSocket, { type RawData } from 'ws'
import { fromBase64Url, toBase64Url } from '../mbp1/canonical'
import {
  DIR_C2S,
  DIR_S2C,
  EnvelopeOpener,
  EnvelopeSealer,
} from '../mbp1/envelope'
import {
  type EnvelopeChannel,
  wrapWithEnvelope,
} from '../mbp1/envelope-message-stream'
import { normalizePairingCode } from '../mbp1/pairing-code'
import {
  buildRT,
  reconnectMacClient,
  reconnectMacServer,
  reconnectTrafficKeys,
} from '../mbp1/reconnect-mac'
import { deriveW } from '../mbp1/scrypt-w'
import {
  buildTT,
  computePublicA,
  confirmationMacs,
  drawScalar,
  EDWARDS25519_GROUP,
  keySchedule,
  pairTrafficKeys,
  sharedFromA,
} from '../mbp1/spake2-core'
import { buildAad, buildAId, buildBId, ticketDigest } from '../mbp1/transcript'
import {
  type WebSocketLike,
  WebSocketMessageReader,
  WebSocketMessageWriter,
} from '../web-socket-message-stream'

const MBP1_PROTOCOL_VERSION = 1
const FRAME_TIMEOUT_MS = 5_000

export const random = (n: number): Uint8Array => new Uint8Array(randomBytes(n))

export interface WireFrame {
  isBinary: boolean
  bytes: Buffer
}

export interface CloseInfo {
  code: number
  reason: string
}

/**
 * A raw socket with an inbox, so a test can await the next frame instead of
 * racing listeners. `detach()` releases the socket to a later consumer (the
 * envelope stream), mirroring the server's own handover discipline.
 */
export class WireClient {
  private readonly inbox: WireFrame[] = []
  private waiter: ((frame: WireFrame) => void) | null = null
  private attached = true
  /** Every raw frame ever received, including those an envelope stream later
   *  consumes — the seam a test uses to inspect wire-level sequence numbers. */
  readonly rawFrames: WireFrame[] = []
  readonly closed: Promise<CloseInfo>

  private readonly onMessage = (data: RawData, isBinary: boolean): void => {
    const frame: WireFrame = { isBinary, bytes: rawToBuffer(data) }
    const waiter = this.waiter
    if (waiter) {
      this.waiter = null
      waiter(frame)
      return
    }
    this.inbox.push(frame)
  }

  private constructor(readonly ws: WebSocket) {
    this.closed = new Promise((resolve) => {
      ws.once('close', (code, reason) =>
        resolve({ code, reason: reason.toString('utf8') })
      )
    })
    // A rejected upgrade surfaces as an 'error'; without a listener it is an
    // unhandled event.
    ws.on('error', () => {})
    ws.on('message', (data: RawData, isBinary: boolean) => {
      this.rawFrames.push({ isBinary, bytes: rawToBuffer(data) })
    })
    ws.on('message', this.onMessage)
  }

  /**
   * `subprotocol: null` offers none at all. It is deliberately NOT `undefined`:
   * a default parameter is re-applied when the caller passes `undefined`, so
   * `open(url, origin, undefined)` would silently offer `motrix-bridge.v1` and
   * the "missing subprotocol is refused" assertion would test nothing.
   */
  static async open(
    url: string,
    origin: string,
    subprotocol: string | null = 'motrix-bridge.v1',
    hostHeader?: string,
    secureTransport?: { ca: string; servername: string }
  ): Promise<WireClient> {
    const ws = new WebSocket(url, subprotocol === null ? [] : subprotocol, {
      origin,
      ...(hostHeader === undefined ? {} : { headers: { host: hostHeader } }),
      ...secureTransport,
    })
    const client = new WireClient(ws)
    await new Promise<void>((resolve, reject) => {
      ws.once('open', resolve)
      ws.once('error', reject)
      ws.once('unexpected-response', (_req, res) =>
        reject(new Error(`unexpected-response ${res.statusCode}`))
      )
    })
    return client
  }

  /** Release the socket so a later consumer sees every subsequent frame. */
  detach(): void {
    if (!this.attached) return
    this.attached = false
    this.ws.off('message', this.onMessage)
  }

  sendJson(json: object): void {
    this.ws.send(JSON.stringify(json))
  }

  sendBytes(bytes: Uint8Array): void {
    this.ws.send(bytes, { binary: true })
  }

  async take(): Promise<WireFrame> {
    const queued = this.inbox.shift()
    if (queued) return queued
    return new Promise<WireFrame>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error('timed out waiting for a frame')),
        FRAME_TIMEOUT_MS
      )
      this.waiter = (frame) => {
        clearTimeout(timer)
        resolve(frame)
      }
    })
  }

  async takeJson<T>(): Promise<T> {
    const frame = await this.take()
    if (frame.isBinary) {
      throw new Error('expected a text frame, received binary')
    }
    return JSON.parse(frame.bytes.toString('utf8')) as T
  }
}

function rawToBuffer(data: RawData): Buffer {
  if (Buffer.isBuffer(data)) return data
  if (Array.isArray(data)) return Buffer.concat(data)
  return Buffer.from(data)
}

/** An NM attestation ticket plus the binding key the §6.5 proof needs. */
export interface ClientTicket {
  wire: Record<string, unknown>
  bindingKeyB64: string
  sign(message: Uint8Array): Uint8Array
}

export interface PairAttemptOptions {
  port: number
  origin: string
  browser: Browser
  claimedExtensionId: string
  clientInstallationId?: string
  ticket?: ClientTicket
  /** Test-only public surface prefix, such as `/bridge`. */
  routePrefix?: string
  /** Test-only reverse-proxy Host preserved at the raw boundary. */
  hostHeader?: string
  /** Test-only trusted-CA WSS/HTTPS transport through a TLS proxy. */
  secureTransport?: { ca: string; servername: string }
  /**
   * The `verifiedOrigin` this client binds into `A_id`, when it must differ
   * from the origin it actually connects with. Only a misbinding test wants
   * this: `verifiedOrigin` is the ONE transcript input neither side takes from
   * a frame, so making the two disagree is the only way to prove the server
   * binds the header it verified rather than something the client claimed.
   */
  transcriptOrigin?: string
}

/** The state a `/pair` client holds between `pairHello` and channel activation. */
export interface PairHandshake {
  wire: WireClient
  instanceId: string
  pairNonce: string
  aId: Uint8Array
  aad: Uint8Array
  /** The principal this run is pairing, retained so the credential it issues
   *  can carry it into a later reconnect. */
  origin: string
  browser: Browser
}

/** Fetch a nonce the way the native-messaging host does (§4.2). */
export async function fetchNonce(
  port: number,
  options: {
    routePrefix?: string
    hostHeader?: string
    secureTransport?: { ca: string; servername: string }
  } = {}
): Promise<string> {
  const prefix = options.routePrefix ?? ''
  if (
    options.hostHeader !== undefined ||
    options.secureTransport !== undefined
  ) {
    return new Promise((resolve, reject) => {
      const requestFn =
        'secureTransport' in options && options.secureTransport !== undefined
          ? httpsRequest
          : httpRequest
      const request = requestFn(
        {
          host: '127.0.0.1',
          port,
          path: `${prefix}/nonce`,
          method: 'POST',
          headers: {
            'x-motrix-bridge': '1',
            'content-length': '0',
            ...(options.hostHeader === undefined
              ? {}
              : { host: options.hostHeader }),
          },
          ...('secureTransport' in options ? options.secureTransport : {}),
        },
        (response) => {
          let body = ''
          response.setEncoding('utf8')
          response.on('data', (chunk) => {
            body += chunk
          })
          response.once('end', () => {
            if (response.statusCode !== 200) {
              reject(
                new Error(`POST /nonce failed with ${response.statusCode}`)
              )
              return
            }
            try {
              resolve((JSON.parse(body) as { nonce: string }).nonce)
            } catch (error) {
              reject(error)
            }
          })
        }
      )
      request.once('error', reject)
      request.end()
    })
  }
  const res = await fetch(`http://127.0.0.1:${port}${prefix}/nonce`, {
    method: 'POST',
    headers: { 'x-motrix-bridge': '1' },
  })
  if (!res.ok) {
    throw new Error(`POST /nonce failed with ${res.status}`)
  }
  const body = (await res.json()) as { nonce: string }
  return body.nonce
}

/**
 * Open `/pair`, send `pairHello`, and await `pairAccept`. Stops there because
 * the code only exists once the server has queued its dialog — the test reads
 * it from the dialog fake, exactly as a user reads it off the screen.
 */
export async function startPair(
  opts: PairAttemptOptions
): Promise<PairHandshake> {
  const pairNonce = await fetchNonce(opts.port, opts)
  const prefix = opts.routePrefix ?? ''
  const protocol = opts.secureTransport === undefined ? 'ws' : 'wss'
  const wire = await WireClient.open(
    `${protocol}://127.0.0.1:${opts.port}${prefix}/pair?nonce=${pairNonce}`,
    opts.origin,
    'motrix-bridge.v1',
    opts.hostHeader,
    opts.secureTransport
  )
  const clientInstallationId = opts.clientInstallationId ?? 'install-1'

  wire.sendJson({
    type: 'pairHello',
    protocolVersion: MBP1_PROTOCOL_VERSION,
    browser: opts.browser,
    claimedExtensionId: opts.claimedExtensionId,
    clientInstallationId,
    ...(opts.ticket
      ? {
          nmTicket: opts.ticket.wire,
          ticketBindingKey: opts.ticket.bindingKeyB64,
        }
      : {}),
  })

  const accept = await wire.takeJson<{ type: string; instanceId: string }>()
  if (accept.type !== 'pairAccept') {
    throw new PairAborted(accept)
  }

  return {
    wire,
    instanceId: accept.instanceId,
    pairNonce,
    origin: opts.origin,
    browser: opts.browser,
    aId: buildAId({
      browser: opts.browser,
      verifiedOrigin: opts.transcriptOrigin ?? opts.origin,
      claimedExtensionId: opts.claimedExtensionId,
      clientInstallationId,
    }),
    aad: buildAad(
      MBP1_PROTOCOL_VERSION,
      pairNonce,
      opts.ticket ? fromBase64Url(opts.ticket.bindingKeyB64) : null,
      opts.ticket ? digestOf(opts.ticket.wire) : null
    ),
  }
}

/** Thrown when the server answered a handshake step with `pairError`. */
export class PairAborted extends Error {
  constructor(readonly frame: unknown) {
    super(`pairing aborted: ${JSON.stringify(frame)}`)
  }
}

export interface PakeResult {
  /** The activated channel, from the client's point of view. */
  channel: EnvelopeChannel
  cB: Uint8Array
}

/**
 * One §6.3–§6.6 protocol run with `code`. Resolves with the activated channel,
 * or throws {@link PairAborted} carrying the server's `pairError` — which is
 * how a wrong code, an exhausted attempt limit, and a failed ticket proof all
 * surface, indistinguishably except for the code the spec permits.
 */
export interface RunPakeOptions {
  ticket?: ClientTicket
  ticketProofOverride?: string
  /**
   * The `instanceId` this client binds into `B_id`, when it must differ from
   * the one the server announced. The `B_id` half of the misbinding property.
   */
  instanceIdOverride?: string
  /**
   * Send this `pA` instead of the honestly-computed one, while still deriving
   * the client's own key material from its real scalar. Adversarial key
   * generation, for the Appendix A grinder: it lets a caller offer the group
   * identity or a small-order point and check the server refuses to reach a
   * confirmed key either way.
   */
  pAOverride?: Uint8Array
}

export async function runPake(
  hs: PairHandshake,
  code: string,
  opts: RunPakeOptions = {}
): Promise<PakeResult> {
  const normalized = normalizePairingCode(code)
  if (normalized === null) {
    throw new Error(`not a pairing code: ${code}`)
  }
  const w = deriveW(normalized, hs.pairNonce, EDWARDS25519_GROUP.order)
  const x = drawScalar(EDWARDS25519_GROUP.order, random)
  const honestPA = computePublicA(EDWARDS25519_GROUP, w, x)
  const pA = opts.pAOverride ?? honestPA

  hs.wire.sendJson({ type: 'pakeA', pA: toBase64Url(pA) })
  const pakeB = await hs.wire.takeJson<{ type: string; pB: string }>()
  if (pakeB.type !== 'pakeB') {
    throw new PairAborted(pakeB)
  }

  const pB = fromBase64Url(pakeB.pB)
  const k = sharedFromA(EDWARDS25519_GROUP, w, x, pB)
  const bId = buildBId(opts.instanceIdOverride ?? hs.instanceId)
  const tt = buildTT(hs.aId, bId, pA, pB, k, w)
  const keys = keySchedule(tt, hs.aad)
  const macs = confirmationMacs(keys.KcA, keys.KcB, tt)

  const ticketProof =
    opts.ticketProofOverride ??
    (opts.ticket
      ? toBase64Url(opts.ticket.sign(ticketProofMessage(tt)))
      : undefined)

  hs.wire.sendJson({
    type: 'confirmA',
    cA: toBase64Url(macs.cA),
    ...(ticketProof === undefined ? {} : { ticketProof }),
  })

  const confirmB = await hs.wire.takeJson<{ type: string; cB: string }>()
  if (confirmB.type !== 'confirmB') {
    throw new PairAborted(confirmB)
  }
  if (toBase64Url(macs.cB) !== confirmB.cB) {
    throw new Error('server cB did not verify')
  }

  const { kC2S, kS2C } = pairTrafficKeys(keys.Ke)
  return {
    channel: {
      sealer: new EnvelopeSealer(kC2S, DIR_C2S),
      opener: new EnvelopeOpener(kS2C, DIR_S2C),
    },
    cB: macs.cB,
  }
}

export interface IssuedCredential {
  credentialId: string
  mutualKey: Uint8Array
  /**
   * The principal the credential was issued to, as the client persists it
   * alongside the key. §8 builds `RT` from these STORED values on the client
   * side against the LIVE connection's values on the server side, which is
   * exactly what makes a credential replayed from another origin fail the MAC
   * (the misbinding property). Reusing the live origin on both sides would
   * make every misbinding test agree with itself and prove nothing.
   */
  origin: string
  browser: Browser
}

/**
 * The §6.7 credential exchange, inside the freshly activated channel. Returns
 * the credential the client would persist, so a later reconnect can use it.
 */
export async function exchangeCredential(
  hs: PairHandshake,
  channel: EnvelopeChannel
): Promise<IssuedCredential> {
  const offer = await openSealedJson<{
    type: string
    credentialId: string
    mutualKey: string
  }>(hs.wire, channel)
  if (offer.type !== 'credentialOffer') {
    throw new Error(`expected credentialOffer, got ${offer.type}`)
  }

  sendSealedJson(hs.wire, channel, {
    type: 'credentialAck',
    credentialId: offer.credentialId,
  })

  const committed = await openSealedJson<{ type: string }>(hs.wire, channel)
  if (committed.type !== 'credentialCommitted') {
    throw new Error(`expected credentialCommitted, got ${committed.type}`)
  }

  return {
    credentialId: offer.credentialId,
    mutualKey: fromBase64Url(offer.mutualKey),
    origin: hs.origin,
    browser: hs.browser,
  }
}

/**
 * A whole §6 first pair: hello, PAKE, credential exchange. `code` is read
 * AFTER `pairAccept`, because that is when the server queues its dialog and the
 * code first exists — the same moment the user can read it off the screen.
 */
export async function pairAndExchange(
  opts: PairAttemptOptions & { code: () => string }
): Promise<{
  wire: WireClient
  channel: EnvelopeChannel
  credential: IssuedCredential
}> {
  const hs = await startPair(opts)
  const { channel } = await runPake(hs, opts.code(), { ticket: opts.ticket })
  const credential = await exchangeCredential(hs, channel)
  return { wire: hs.wire, channel, credential }
}

/**
 * §8 reconnect: open `/v1`, answer the challenge, activate the channel.
 *
 * `origin` is the LIVE connection's `Origin` header; `RT` is built from the
 * credential's supplied principal. A legitimate client persists those values;
 * security tests may deliberately replace them to model an attacker that has
 * stolen credentialId + mutualKey and recomputes RT for its own live Origin.
 * The server must reject that case by comparing the durable principal, not by
 * assuming the client will preserve it.
 */
export async function reconnect(opts: {
  port: number
  origin: string
  instanceId: string
  credential: IssuedCredential
  /** Overrides the credentialId actually sent, for the unknown-id case. */
  credentialIdOverride?: string
  /** Corrupts the MAC, for the bad-MAC case. */
  corruptMac?: boolean
  query?: string
  routePrefix?: string
  hostHeader?: string
  secureTransport?: { ca: string; servername: string }
}): Promise<{ wire: WireClient; channel: EnvelopeChannel }> {
  const prefix = opts.routePrefix ?? ''
  const protocol = opts.secureTransport === undefined ? 'ws' : 'wss'
  const wire = await WireClient.open(
    `${protocol}://127.0.0.1:${opts.port}${prefix}/v1${opts.query ?? ''}`,
    opts.origin,
    'motrix-bridge.v1',
    opts.hostHeader,
    opts.secureTransport
  )
  const challenge = await wire.takeJson<{ type: string; S: string }>()
  if (challenge.type !== 'reconnectChallenge') {
    throw new PairAborted(challenge)
  }

  const s = fromBase64Url(challenge.S)
  const c = random(32)
  const credentialId = opts.credentialIdOverride ?? opts.credential.credentialId
  const rt = buildRT({
    protocolVersion: MBP1_PROTOCOL_VERSION,
    credentialId,
    // The caller-supplied principal, not automatically `opts.origin` — see the
    // doc comment above. This distinction lets tests model both honest drift
    // and an active stolen-key attacker.
    browser: opts.credential.browser,
    verifiedOrigin: opts.credential.origin,
    instanceId: opts.instanceId,
  })
  const mac = reconnectMacClient(opts.credential.mutualKey, s, c, rt)
  if (opts.corruptMac) {
    mac[0] ^= 0xff
  }

  wire.sendJson({
    type: 'reconnectResponse',
    credentialId,
    C: toBase64Url(c),
    mac: toBase64Url(mac),
  })

  const accept = await wire.takeJson<{ type: string; mac: string }>()
  if (accept.type !== 'reconnectAccept') {
    throw new PairAborted(accept)
  }
  const expected = reconnectMacServer(opts.credential.mutualKey, s, c, rt)
  if (toBase64Url(expected) !== accept.mac) {
    throw new Error('server reconnectAccept mac did not verify')
  }

  const { kC2S, kS2C } = reconnectTrafficKeys(opts.credential.mutualKey, s, c)
  return {
    wire,
    channel: {
      sealer: new EnvelopeSealer(kC2S, DIR_C2S),
      opener: new EnvelopeOpener(kS2C, DIR_S2C),
    },
  }
}

/**
 * Run MDXP over the activated channel, the way the extension does. The wire
 * client is detached first: leaving its raw listener attached would advance the
 * opener twice per frame, which is the same handover rule the server obeys.
 */
export function mdxpOverChannel(
  wire: WireClient,
  channel: EnvelopeChannel
): MdxpConnection {
  wire.detach()
  const wrapped = wrapWithEnvelope(wire.ws as WebSocketLike, channel, () => {})
  const conn = createMdxpConnection(
    new WebSocketMessageReader(wrapped),
    new WebSocketMessageWriter(wrapped)
  )
  conn.listen()
  return conn
}

/** `motrix/initialize` params re-asserting `extensionId` (§5 consistency). */
export function initializeParams(
  extensionId: string,
  browser: Browser = 'chromium'
) {
  return {
    protocolVersion: '1.0' as const,
    client: {
      kind: 'extension' as const,
      name: 'motrix-extension',
      version: '0.1',
      extensionId,
      browser,
      browserVersion: '120',
      locale: 'en',
    },
    capabilities: {},
    adapters: [] as never[],
  }
}

export function sendSealedJson(
  wire: WireClient,
  channel: EnvelopeChannel,
  json: object
): void {
  wire.sendBytes(channel.sealer.seal(utf8ToBytes(JSON.stringify(json))))
}

export async function openSealedJson<T>(
  wire: WireClient,
  channel: EnvelopeChannel
): Promise<T> {
  const frame = await wire.take()
  if (!frame.isBinary) {
    throw new PairAborted(JSON.parse(frame.bytes.toString('utf8')))
  }
  return JSON.parse(
    Buffer.from(channel.opener.open(asBytes(frame.bytes))).toString('utf8')
  ) as T
}

/**
 * A `Buffer` view as a plain `Uint8Array`, which is what every `mbp1/` byte
 * input must be: `@noble`'s `isBytes` is `instanceof Uint8Array`, and under
 * vitest's jsdom environment a `Buffer` fails it because the two come from
 * different realms.
 */
function asBytes(frame: Buffer): Uint8Array {
  return new Uint8Array(frame.buffer, frame.byteOffset, frame.byteLength)
}

/**
 * §6.5's signed message: `"MBP1/ticket-proof/v1" ‖ TT`.
 *
 * A real `Uint8Array`, not the `Buffer` that `Buffer.concat` would answer: this
 * value is signed by `@noble`, whose `isBytes` check compares against the jsdom
 * realm's `Uint8Array` and rejects every `Buffer` as `got type=object`.
 */
export function ticketProofMessage(tt: Uint8Array): Uint8Array {
  const label = utf8ToBytes('MBP1/ticket-proof/v1')
  const message = new Uint8Array(label.length + tt.length)
  message.set(label, 0)
  message.set(tt, label.length)
  return message
}

function digestOf(wire: Record<string, unknown>): Uint8Array {
  return ticketDigest({
    v: wire.v as number,
    purpose: wire.purpose as string,
    protocolVersion: wire.protocolVersion as number,
    serverGeneration: wire.serverGeneration as string,
    browser: wire.browser as string,
    callerId: wire.callerId as string,
    exp: wire.exp as number,
    bindingPub: fromBase64Url(wire.bindingPub as string),
    mac: fromBase64Url(wire.mac as string),
  })
}
