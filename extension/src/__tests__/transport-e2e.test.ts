// @vitest-environment node
// Runs over a real ws server using Node's global WebSocket (undici). jsdom
// replaces the global Event class, which clashes with undici's native Event
// on dispatch ("must be an instance of Event. Received an instance of Event"),
// so this transport e2e suite must run in the node environment, not jsdom.
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { hkdf } from '@noble/hashes/hkdf.js'
import { hmac } from '@noble/hashes/hmac.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { randomBytes } from '@noble/hashes/utils.js'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  type RawData,
  WebSocketServer,
  type WebSocket as WsWebSocket,
} from 'ws'
import {
  ConnectionManager,
  type ConnectionManagerOptions,
} from '@/background/ConnectionManager'
import { EndpointConfigStore } from '@/background/EndpointConfigStore'
import {
  b64uDecode,
  b64uEncode,
  concatBytes,
  enc,
  encU32BE,
  timingSafeEqualBytes,
  utf8,
} from '@/background/mbp1/canonical'
import { DiscoveryService } from '@/background/mbp1/discovery-service'
import { EnvelopeCodec } from '@/background/mbp1/envelope'
import {
  type ConfirmAFrame,
  type CredentialAckFrame,
  confirmAFrameSchema,
  credentialAckFrameSchema,
  MBP1_PROTOCOL_VERSION,
  MBP1_SUBPROTOCOL,
  type Mbp1Browser,
  type PairHelloFrame,
  type PakeAFrame,
  pairHelloFrameSchema,
  pakeAFrameSchema,
  type ReconnectResponseFrame,
  reconnectResponseFrameSchema,
} from '@/background/mbp1/frames'
import { PinStore } from '@/background/mbp1/pin-store'
import { deriveW } from '@/background/mbp1/scrypt-w'
import {
  drawScalar,
  ED25519_GROUP,
  scalarFromBytes,
  sharedSecretFromDifference,
} from '@/background/mbp1/spake2-core'
import { buildAad, buildAId, buildBId } from '@/background/mbp1/transcript'
import { WebSocketClient } from '@/background/WebSocketClient'

declare const browser: {
  storage: {
    local: {
      get: (k: string | string[]) => Promise<Record<string, unknown>>
      set: (items: Record<string, unknown>) => Promise<void>
      remove: (k: string | string[]) => Promise<void>
    }
  }
}

const CLIENT_INFO: ConnectionManagerOptions['clientInfo'] = {
  name: 'motrix-extension',
  version: '0.1.0',
  extensionId: 'abc',
  browser: 'chromium',
  browserVersion: 'jsdom-e2e',
  locale: 'en',
}

/**
 * Stand up a minimal mock Motrix bridge: accepts a WS connection on any
 * route and replies to motrix/initialize with a fake server descriptor. We
 * bypass createMdxpConnection on the server side and just
 * parse/serialize JSON-RPC frames directly — keeps the test self-contained.
 */
async function startMockBridge(): Promise<{
  port: number
  initParamsSeen: () => unknown
  initializedSeen: () => boolean
  close: () => Promise<void>
}> {
  let initParams: unknown = null
  let initialized = false
  const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' })

  wss.on('connection', (ws: WsWebSocket) => {
    ws.on('message', (raw) => {
      const msg = JSON.parse(raw.toString('utf8')) as {
        id?: string | number
        method?: string
        params?: unknown
      }
      if (msg.method === 'motrix/initialize' && msg.id !== undefined) {
        initParams = msg.params
        const response = {
          jsonrpc: '2.0' as const,
          id: msg.id,
          result: {
            protocolVersion: '1.0',
            server: { name: 'motrix', version: '2.0', runtime: 'electron' },
            capabilities: {
              ffmpegAvailable: true,
              selectionKinds: ['direct'],
              progress: true,
              cancellation: true,
            },
            serverAdapters: [],
          },
        }
        ws.send(JSON.stringify(response))
        return
      }
      if (msg.method === 'motrix/initialized') {
        initialized = true
        return
      }
    })
  })

  await new Promise<void>((resolve) => wss.once('listening', () => resolve()))
  const port = (wss.address() as AddressInfo).port

  return {
    port,
    initParamsSeen: () => initParams,
    initializedSeen: () => initialized,
    close: () =>
      new Promise<void>((resolve, reject) => {
        wss.clients.forEach((c) => {
          c.close()
        })
        wss.close((err) => (err ? reject(err) : resolve()))
      }),
  }
}

beforeEach(() => {
  let backing: Record<string, unknown> = {}
  browser.storage.local.get = vi.fn(async (k: string | string[]) => {
    const key = Array.isArray(k) ? k[0] : k
    return key && key in backing ? { [key]: backing[key] } : {}
  })
  browser.storage.local.set = vi.fn(async (items: Record<string, unknown>) => {
    backing = { ...backing, ...items }
  })
  browser.storage.local.remove = vi.fn(async (k: string | string[]) => {
    const keys = Array.isArray(k) ? k : [k]
    for (const key of keys) delete backing[key]
  })
})

describe('transport e2e — ConnectionManager ↔ in-process ws server', () => {
  let bridge: Awaited<ReturnType<typeof startMockBridge>>

  beforeEach(async () => {
    bridge = await startMockBridge()
  })
  afterEach(async () => {
    await bridge.close()
  })

  // Keep a real listener present to prove compatibility rejection happens
  // before any socket is opened.

  it('rejects a remote bridge before opening its real socket', async () => {
    const endpointConfigStore = new EndpointConfigStore()
    await endpointConfigStore.setForTest({
      version: 3,
      activeEndpointId: 'e2e',
      servers: [
        {
          id: 'e2e',
          name: 'E2E',
          url: `wss://127.0.0.1:${bridge.port}`,
          revision: 0,
          state: 'ready',
        },
      ],
      cleanupTombstones: [],
    })
    const mgr = new ConnectionManager({
      clientInfo: CLIENT_INFO,
      client: new WebSocketClient(),
      endpointConfigStore,
    })

    await mgr.connect({ allowLaunch: true, userInitiated: true })
    expect(mgr.getState()).toBe('disconnected')
    expect(mgr.getLastErrorReason()).toBe('remoteDiscoveryUnavailable')
    expect(bridge.initializedSeen()).toBe(false)
    expect(bridge.initParamsSeen()).toBeNull()

    mgr.stop()
  })

  it('ignores retired storage instead of placing it on a route', async () => {
    await browser.storage.local.set({
      'motrix.pairTokens': { version: 1, tokens: { e2e: 'secret-sentinel' } },
    })
    const endpointConfigStore = new EndpointConfigStore()
    await endpointConfigStore.setForTest({
      version: 3,
      activeEndpointId: 'e2e',
      servers: [
        {
          id: 'e2e',
          name: 'E2E',
          url: `wss://127.0.0.1:${bridge.port}`,
          revision: 0,
          state: 'ready',
        },
      ],
      cleanupTombstones: [],
    })
    const mgr = new ConnectionManager({
      clientInfo: CLIENT_INFO,
      client: new WebSocketClient(),
      endpointConfigStore,
    })

    await mgr.connect({ allowLaunch: true, userInitiated: true })
    expect(mgr.getState()).toBe('disconnected')
    expect(mgr.getLastErrorReason()).toBe('remoteDiscoveryUnavailable')
    expect(mgr.lastConnectUrl).toBeNull()
    expect(bridge.initParamsSeen()).toBeNull()

    mgr.stop()
  })
})

// ============================================================================
// MBP1 e2e — a mock bridge that actually speaks the protocol
// ============================================================================
//
// IMPORTANT, read before trusting this suite: an e2e against a mock this
// project wrote is a system-level mirror test. If this mock and the real
// `ConnectionManager`/`PairingFlow`/`ReconnectFlow` share a misunderstanding
// of the protocol, they agree with each other here and the test goes green
// while a real Motrix would reject every frame. This suite reduces that risk
// two ways, and each has a limit:
//
// 1. Inbound client frames are validated with the real, shipped
//    `.strict()` zod schemas from `frames.ts` (`pairHelloFrameSchema` etc.),
//    not hand-transcribed checks. That rules out this mock silently
//    tolerating an extra/missing property the real server would reject. But
//    it does NOT rule out the schemas themselves being wrong: this validates
//    the client's frames with the client's own schemas, the same artifact
//    the client encodes with. A field-by-field diff of those five schemas
//    against the peer's real validator in Line A's shipped source found
//    **zero divergences** — every field
//    name, optionality, byte length, and the `reconnectResponse`-has-no-
//    `protocolVersion` rule all matched exactly. That diff, not this test,
//    is the actual cross-implementation evidence; record it in the task
//    report, not just here.
// 2. Every piece of §6/§8 crypto this mock performs (`serverKeySchedule` and
//    `serverPairTrafficKeys` for the §6.6 SPAKE2 B-side, and
//    `serverReconnectTranscript`/`serverReconnectMacs`/
//    `serverReconnectTrafficKeys` for §8) is a deliberate *re-derivation*
//    from the documented formulas, using only the shared low-level
//    primitives (`ED25519_GROUP`'s point operations,
//    `sharedSecretFromDifference`, noble's `sha256`/`hmac`/`hkdf`,
//    `canonical.ts`'s `enc`/`concatBytes`) — never spake2-core.ts's private
//    `keyScheduleFrom` or its own exported `pairTrafficKeys`, and never
//    `reconnect-mac.ts`'s own exported `reconnectTranscript`/
//    `reconnectMacs`/`reconnectTrafficKeys`, even though all four genuinely
//    are importable. Importing any of them would make this mock share the
//    client's exact composition rather than an independent one: corrupt a
//    label or a field order in either module and a mock that calls it back
//    would corrupt identically and still agree — the same failure this
//    file exists to avoid throughout. A mistake in either side's
//    independent derivation surfaces as a genuine MAC/confirmation
//    mismatch, not a silent pass. It is still true that both were written
//    by whoever wrote the production module reading the same spec, so a
//    shared misreading of the *spec itself* (as opposed to the *code*)
//    would not be caught here.
//
// What this suite does NOT prove: interop with the real Motrix desktop
// build. That is Line A's own test suite and the shared §13 normative
// vectors' job.

const MOCK_VERIFIED_ORIGIN = 'chrome-extension://test-extension-id'

interface Mbp1MockCapturedFrames {
  pairHello: PairHelloFrame | null
  pakeA: PakeAFrame | null
  confirmA: ConfirmAFrame | null
  credentialAck: CredentialAckFrame | null
  reconnectResponse: ReconnectResponseFrame | null
}

interface Mbp1MockBridge {
  port: number
  frames: Mbp1MockCapturedFrames
  /** How many times each route was actually driven to completion. A failed
   *  §8 reconnect (e.g. a bad `reconnectAccept.mac`) makes
   *  `ConnectionManager` fall through to a *fresh* first pairing rather than
   *  surfacing an error — which would also reach 'connected' and would also
   *  leave `frames.reconnectResponse` populated from the failed attempt.
   *  Asserting exactly one of each is what actually proves the reconnect
   *  succeeded as a reconnect, not just that the state machine recovered by
   *  some path or other. */
  sessionCounts: () => { pair: number; reconnect: number }
  /** Forcibly ends the current live connection, so the client falls back to
   *  a fresh §8 reconnect over a new socket. */
  dropConnection: () => void
  close: () => Promise<void>
}

/** `I2OSP(w, 32)` (§2) — the same big-endian, zero-padded encoding
 *  spake2-core.ts's private `i2osp32` documents. Reimplemented rather than
 *  imported because it isn't exported; the composition is a fixed,
 *  unambiguous standard (RFC 9382 §3.3), not a place independent
 *  transcription risks drift. */
function i2osp32(w: bigint): Uint8Array {
  const out = new Uint8Array(32)
  let remaining = w
  for (let i = 31; i >= 0; i--) {
    out[i] = Number(remaining & 0xffn)
    remaining >>= 8n
  }
  return out
}

/** See the suite header comment (§6.4-§6.5's key schedule, B's side) for why
 *  this exists instead of calling spake2-core.ts's private
 *  `keyScheduleFrom`. */
function serverKeySchedule(args: {
  aId: Uint8Array
  bId: Uint8Array
  pA: Uint8Array
  pB: Uint8Array
  K: Uint8Array
  w: bigint
  aad: Uint8Array
}): { Ke: Uint8Array; cA: Uint8Array; cB: Uint8Array } {
  const TT = concatBytes(
    enc(args.aId),
    enc(args.bId),
    enc(args.pA),
    enc(args.pB),
    enc(args.K),
    enc(i2osp32(args.w))
  )
  const digest = sha256(TT)
  const Ke = digest.slice(0, 16)
  const Ka = digest.slice(16, 32)
  const confirmationKeys = hkdf(
    sha256,
    Ka,
    new Uint8Array(0),
    concatBytes(utf8('ConfirmationKeys'), args.aad),
    32
  )
  const KcA = confirmationKeys.slice(0, 16)
  const KcB = confirmationKeys.slice(16, 32)
  return { Ke, cA: hmac(sha256, KcA, TT), cB: hmac(sha256, KcB, TT) }
}

const PAIR_TRAFFIC_SALT = utf8('MBP1/pair/v1')
const PAIR_TRAFFIC_INFO_C2S = utf8('MBP1-pair-traffic-c2s')
const PAIR_TRAFFIC_INFO_S2C = utf8('MBP1-pair-traffic-s2c')
const PAIR_TRAFFIC_KEY_BYTES = 32

/** See the suite header comment for why this re-derives the §6.6 pair
 *  traffic keys from their documented formula instead of importing
 *  spake2-core.ts's own exported `pairTrafficKeys` — importing it would
 *  make this half of the mock share the client's exact key schedule rather
 *  than an independent one, the same mirror this suite avoids everywhere
 *  else. */
function serverPairTrafficKeys(Ke: Uint8Array): {
  c2s: Uint8Array
  s2c: Uint8Array
} {
  return {
    c2s: hkdf(
      sha256,
      Ke,
      PAIR_TRAFFIC_SALT,
      PAIR_TRAFFIC_INFO_C2S,
      PAIR_TRAFFIC_KEY_BYTES
    ),
    s2c: hkdf(
      sha256,
      Ke,
      PAIR_TRAFFIC_SALT,
      PAIR_TRAFFIC_INFO_S2C,
      PAIR_TRAFFIC_KEY_BYTES
    ),
  }
}

const RECONNECT_MAC_CLIENT_LABEL = utf8('MBP1-R/c')
const RECONNECT_MAC_SERVER_LABEL = utf8('MBP1-R/s')
const RECONNECT_TRAFFIC_C2S_INFO = utf8('MBP1-traffic-c2s')
const RECONNECT_TRAFFIC_S2C_INFO = utf8('MBP1-traffic-s2c')
const RECONNECT_TRAFFIC_KEY_BYTES = 32

/** See the suite header comment for why this re-derives §8's transcript
 *  from its documented formula instead of importing `reconnect-mac.ts`'s
 *  own exported `reconnectTranscript`. */
function serverReconnectTranscript(a: {
  protocolVersion: number
  credentialId: string
  browser: string
  verifiedOrigin: string
  instanceId: string
}): Uint8Array {
  return concatBytes(
    enc('MBP1/reconnect/v1'),
    encU32BE(a.protocolVersion),
    enc(a.credentialId),
    enc(a.browser),
    enc(a.verifiedOrigin),
    enc(a.instanceId)
  )
}

/** See the suite header comment for why this re-derives both §8 MACs from
 *  their documented formula instead of importing `reconnect-mac.ts`'s own
 *  exported `reconnectMacs`. */
function serverReconnectMacs(
  mutualKey: Uint8Array,
  S: Uint8Array,
  C: Uint8Array,
  RT: Uint8Array
): { client: Uint8Array; server: Uint8Array } {
  return {
    client: hmac(
      sha256,
      mutualKey,
      concatBytes(RECONNECT_MAC_CLIENT_LABEL, S, C, RT)
    ),
    server: hmac(
      sha256,
      mutualKey,
      concatBytes(RECONNECT_MAC_SERVER_LABEL, S, C, RT)
    ),
  }
}

/** See the suite header comment for why this re-derives both §8 traffic
 *  keys from their documented formula instead of importing
 *  `reconnect-mac.ts`'s own exported `reconnectTrafficKeys`. */
function serverReconnectTrafficKeys(
  mutualKey: Uint8Array,
  S: Uint8Array,
  C: Uint8Array
): { c2s: Uint8Array; s2c: Uint8Array } {
  const salt = concatBytes(S, C)
  return {
    c2s: hkdf(
      sha256,
      mutualKey,
      salt,
      RECONNECT_TRAFFIC_C2S_INFO,
      RECONNECT_TRAFFIC_KEY_BYTES
    ),
    s2c: hkdf(
      sha256,
      mutualKey,
      salt,
      RECONNECT_TRAFFIC_S2C_INFO,
      RECONNECT_TRAFFIC_KEY_BYTES
    ),
  }
}

function sendFrame(ws: WsWebSocket, frame: object): void {
  ws.send(JSON.stringify(frame))
}

function onceText(ws: WsWebSocket): Promise<string> {
  return new Promise((resolve, reject) => {
    function cleanup(): void {
      ws.off('message', onMessage)
      ws.off('close', onClose)
    }
    function onMessage(data: RawData, isBinary: boolean): void {
      cleanup()
      if (isBinary) {
        reject(new Error('mock bridge: expected a text frame, got binary'))
        return
      }
      resolve(data.toString())
    }
    function onClose(): void {
      cleanup()
      reject(new Error('mock bridge: socket closed awaiting a text frame'))
    }
    ws.once('message', onMessage)
    ws.once('close', onClose)
  })
}

function onceBinary(ws: WsWebSocket): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    function cleanup(): void {
      ws.off('message', onMessage)
      ws.off('close', onClose)
    }
    function onMessage(data: RawData, isBinary: boolean): void {
      cleanup()
      if (!isBinary || Array.isArray(data)) {
        reject(new Error('mock bridge: expected a binary frame'))
        return
      }
      resolve(new Uint8Array(data as ArrayBuffer | Buffer))
    }
    function onClose(): void {
      cleanup()
      reject(new Error('mock bridge: socket closed awaiting a binary frame'))
    }
    ws.once('message', onMessage)
    ws.once('close', onClose)
  })
}

async function sealedSend(
  ws: WsWebSocket,
  envelope: EnvelopeCodec,
  frame: object
): Promise<void> {
  ws.send(await envelope.seal(utf8(JSON.stringify(frame))))
}

async function sealedReceive(
  ws: WsWebSocket,
  envelope: EnvelopeCodec
): Promise<unknown> {
  const plaintext = await envelope.open(await onceBinary(ws))
  return JSON.parse(new TextDecoder().decode(plaintext))
}

/**
 * A `ws` server (+ sibling `http.Server`) that speaks the **server** side of
 * MBP1 for exactly one simulated Motrix instance: `GET /discovery` and
 * `POST /nonce` over plain HTTP, `/pair` and `/v1` as real WebSocket
 * handshakes running the actual §6/§8/§10 crypto against the real
 * `ConnectionManager`/`PairingFlow`/`ReconnectFlow` on the other end.
 *
 * See the suite header comment for what reusing real crypto here does and
 * does not prove.
 */
async function startMbp1MockBridge(opts: {
  code: string
  instanceId?: string
  appVersion?: string
}): Promise<Mbp1MockBridge> {
  const instanceId = opts.instanceId ?? 'mock-motrix-1'
  const appVersion = opts.appVersion ?? '9.9.9'
  const { code } = opts

  const frames: Mbp1MockCapturedFrames = {
    pairHello: null,
    pakeA: null,
    confirmA: null,
    credentialAck: null,
    reconnectResponse: null,
  }
  // credentialId -> mutualKey (raw bytes): this mock's own durable record of
  // what it offered during first-pair, consulted again on /v1.
  const credentials = new Map<string, Uint8Array>()
  let currentSocket: WsWebSocket | null = null
  let pairedBrowser: Mbp1Browser = 'chromium'
  // Counts a session as completed only once it reaches the point where the
  // channel is authenticated (post-`confirmB` for pairing, post-`reconnectAccept`-
  // sent for reconnect) — a session the peer rejects earlier doesn't count as
  // "this route ran", which is the distinction `sessionCounts()` exists for.
  let completedPairSessions = 0
  let completedReconnectSessions = 0

  async function runMdxpLoop(
    ws: WsWebSocket,
    envelope: EnvelopeCodec,
    kind: 'pair' | 'reconnect'
  ): Promise<void> {
    return new Promise((resolve) => {
      ws.on('message', (data: RawData, isBinary: boolean) => {
        if (!isBinary || Array.isArray(data)) return
        void (async () => {
          let plaintext: Uint8Array
          try {
            plaintext = await envelope.open(new Uint8Array(data as Buffer))
          } catch {
            return
          }
          const msg = JSON.parse(new TextDecoder().decode(plaintext)) as {
            id?: unknown
            method?: string
          }
          if (msg.method === 'motrix/initialize' && msg.id !== undefined) {
            // `motrix/initialize` only arrives here once the client's own
            // PairingFlow/ReconnectFlow has already verified mutual
            // authentication and handed the envelope to MDXP — a client that
            // rejected `confirmB`/`reconnectAccept` never gets this far on
            // this socket, so this is the actual "this route succeeded"
            // signal `sessionCounts()` reports, not just "a session opened".
            if (kind === 'pair') completedPairSessions += 1
            else completedReconnectSessions += 1
            const response = {
              jsonrpc: '2.0' as const,
              id: msg.id,
              result: {
                protocolVersion: '1.0',
                server: { name: 'motrix', version: '2.0', runtime: 'electron' },
                capabilities: {
                  ffmpegAvailable: true,
                  selectionKinds: ['direct'],
                  progress: true,
                  cancellation: true,
                },
                serverAdapters: [],
              },
            }
            ws.send(await envelope.seal(utf8(JSON.stringify(response))))
          }
        })()
      })
      ws.on('close', () => resolve())
    })
  }

  async function runPairSession(ws: WsWebSocket, nonce: string): Promise<void> {
    // Reused from frames.ts rather than hand-transcribed — see the suite
    // header comment for what this does and does not prove.
    const hello = pairHelloFrameSchema.parse(JSON.parse(await onceText(ws)))
    frames.pairHello = hello
    pairedBrowser = hello.browser

    sendFrame(ws, {
      type: 'pairAccept',
      protocolVersion: MBP1_PROTOCOL_VERSION,
      instanceId,
    })

    const w = scalarFromBytes(deriveW(code, nonce))
    const y = drawScalar(ED25519_GROUP.order)
    const pB = ED25519_GROUP.addPoints(
      ED25519_GROUP.mulPoint(ED25519_GROUP.N, w),
      ED25519_GROUP.mulBase(y)
    )

    const pakeA = pakeAFrameSchema.parse(JSON.parse(await onceText(ws)))
    frames.pakeA = pakeA
    const pA = b64uDecode(pakeA.pA)

    // B's view: K = h·y·(pA - w·M) (§6.3).
    const d = ED25519_GROUP.addPoints(
      pA,
      ED25519_GROUP.negPoint(ED25519_GROUP.mulPoint(ED25519_GROUP.M, w))
    )
    const K = sharedSecretFromDifference(ED25519_GROUP, d, y)

    const aId = buildAId({
      browser: hello.browser,
      verifiedOrigin: MOCK_VERIFIED_ORIGIN,
      claimedExtensionId: hello.claimedExtensionId,
      clientInstallationId: hello.clientInstallationId,
    })
    const bId = buildBId(instanceId)
    // Ticketless only: this suite never presents an nmTicket.
    const aad = buildAad({
      protocolVersion: MBP1_PROTOCOL_VERSION,
      pairNonce: nonce,
      ticketBindingKey: null,
      ticket: null,
    })
    const schedule = serverKeySchedule({ aId, bId, pA, pB, K, w, aad })

    sendFrame(ws, { type: 'pakeB', pB: b64uEncode(pB) })

    const confirmA = confirmAFrameSchema.parse(JSON.parse(await onceText(ws)))
    frames.confirmA = confirmA
    if (!timingSafeEqualBytes(b64uDecode(confirmA.cA), schedule.cA)) {
      ws.close(1002)
      return
    }

    sendFrame(ws, { type: 'confirmB', cB: b64uEncode(schedule.cB) })

    const traffic = serverPairTrafficKeys(schedule.Ke)
    const envelope = await EnvelopeCodec.create(
      traffic.c2s,
      traffic.s2c,
      'server'
    )

    const credentialId = Buffer.from(randomBytes(16)).toString('hex')
    const mutualKey = randomBytes(32)
    credentials.set(credentialId, mutualKey)

    await sealedSend(ws, envelope, {
      type: 'credentialOffer',
      credentialId,
      mutualKey: b64uEncode(mutualKey),
    })
    const ack = credentialAckFrameSchema.parse(
      await sealedReceive(ws, envelope)
    )
    frames.credentialAck = ack
    if (ack.credentialId !== credentialId) {
      ws.close(1002)
      return
    }
    await sealedSend(ws, envelope, { type: 'credentialCommitted' })

    await runMdxpLoop(ws, envelope, 'pair')
  }

  async function runReconnectSession(ws: WsWebSocket): Promise<void> {
    const S = randomBytes(32)
    sendFrame(ws, {
      type: 'reconnectChallenge',
      protocolVersion: MBP1_PROTOCOL_VERSION,
      S: b64uEncode(S),
    })

    const resp = reconnectResponseFrameSchema.parse(
      JSON.parse(await onceText(ws))
    )
    frames.reconnectResponse = resp

    const mutualKey = credentials.get(resp.credentialId)
    if (mutualKey === undefined) {
      sendFrame(ws, { type: 'pairError', code: 'authFailed' })
      ws.close()
      return
    }
    const C = b64uDecode(resp.C)
    const RT = serverReconnectTranscript({
      protocolVersion: MBP1_PROTOCOL_VERSION,
      credentialId: resp.credentialId,
      browser: pairedBrowser,
      verifiedOrigin: MOCK_VERIFIED_ORIGIN,
      instanceId,
    })
    const macs = serverReconnectMacs(mutualKey, S, C, RT)
    if (!timingSafeEqualBytes(b64uDecode(resp.mac), macs.client)) {
      sendFrame(ws, { type: 'pairError', code: 'authFailed' })
      ws.close()
      return
    }
    sendFrame(ws, { type: 'reconnectAccept', mac: b64uEncode(macs.server) })

    const traffic = serverReconnectTrafficKeys(mutualKey, S, C)
    const envelope = await EnvelopeCodec.create(
      traffic.c2s,
      traffic.s2c,
      'server'
    )
    await runMdxpLoop(ws, envelope, 'reconnect')
  }

  const httpServer = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    if (req.method === 'GET' && url.pathname === '/discovery') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(
        JSON.stringify({
          app: 'motrix-bridge',
          apiVersion: 1,
          instanceId,
          appVersion,
          runtime: 'electron',
          extensionPairing: { protocol: 'mbp1', versions: [1] },
          applicationProtocols: { mdxp: ['1.0'] },
        })
      )
      return
    }
    if (req.method === 'POST' && url.pathname === '/nonce') {
      if (req.headers['x-motrix-bridge'] !== '1') {
        res.writeHead(400)
        res.end()
        return
      }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(
        JSON.stringify({ nonce: Buffer.from(randomBytes(16)).toString('hex') })
      )
      return
    }
    res.writeHead(404)
    res.end()
  })

  const wss = new WebSocketServer({
    noServer: true,
    handleProtocols: () => MBP1_SUBPROTOCOL,
  })

  httpServer.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    if (req.headers['sec-websocket-protocol'] !== MBP1_SUBPROTOCOL) {
      // Mirrors Line A: no subprotocol, no upgrade.
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n')
      socket.destroy()
      return
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      currentSocket = ws
      if (url.pathname === '/pair') {
        void runPairSession(ws, url.searchParams.get('nonce') ?? '').catch(
          () => {
            try {
              ws.close(1002)
            } catch {
              // best-effort
            }
          }
        )
      } else if (url.pathname === '/v1') {
        void runReconnectSession(ws).catch(() => {
          try {
            ws.close(1002)
          } catch {
            // best-effort
          }
        })
      } else {
        ws.close(1002)
      }
    })
  })

  await new Promise<void>((resolve) =>
    httpServer.listen(0, '127.0.0.1', resolve)
  )
  const port = (httpServer.address() as AddressInfo).port

  return {
    port,
    frames,
    sessionCounts: () => ({
      pair: completedPairSessions,
      reconnect: completedReconnectSessions,
    }),
    dropConnection: () => currentSocket?.terminate(),
    close: () =>
      new Promise<void>((resolve) => {
        wss.clients.forEach((c) => {
          c.terminate()
        })
        wss.close(() => httpServer.close(() => resolve()))
      }),
  }
}

const MOCK_PAIRING_CODE = 'MTX7K2Q9'

describe('MBP1 e2e — first pair then reconnect', () => {
  it('pairs with a code and reconnects with the issued credential', async () => {
    const bridge = await startMbp1MockBridge({
      code: MOCK_PAIRING_CODE,
      instanceId: 'mock-motrix-1',
      appVersion: '9.9.9',
    })
    try {
      const pinStore = new PinStore()
      const discoveryService = new DiscoveryService({
        pins: pinStore,
        candidatePorts: [bridge.port],
      })
      const cm = new ConnectionManager({
        clientInfo: CLIENT_INFO,
        endpointConfigStore: new EndpointConfigStore(),
        pinStore,
        discoveryService,
        pairingCodeSource: MOCK_PAIRING_CODE,
      })

      await cm.clearGateAndStart()
      expect(cm.getState()).toBe('connected')

      // A green connection is the part that can lie — assert the exact
      // property set of every frame the mock actually received, not just
      // that the state machine reached 'connected'.
      expect(Object.keys(bridge.frames.pairHello ?? {}).sort()).toEqual(
        [
          'browser',
          'claimedExtensionId',
          'clientInstallationId',
          'protocolVersion',
          'type',
        ].sort()
      )
      expect(bridge.frames.pairHello?.protocolVersion).toBe(1)
      expect(bridge.frames.pairHello?.browser).toBe('chromium')
      // Ticketless: both fields omitted, not sent as null.
      expect(bridge.frames.pairHello).not.toHaveProperty('nmTicket')
      expect(bridge.frames.pairHello).not.toHaveProperty('ticketBindingKey')

      expect(Object.keys(bridge.frames.pakeA ?? {}).sort()).toEqual(
        ['pA', 'type'].sort()
      )

      expect(Object.keys(bridge.frames.confirmA ?? {}).sort()).toEqual(
        ['cA', 'type'].sort()
      )
      // ticketProof present iff a ticket was sent — none was.
      expect(bridge.frames.confirmA).not.toHaveProperty('ticketProof')

      expect(Object.keys(bridge.frames.credentialAck ?? {}).sort()).toEqual(
        ['credentialId', 'type'].sort()
      )

      // Drop the live socket: the stored, now-committed credential must
      // drive a §8 /v1 challenge-response on a fresh connection.
      //
      // Polling `getState()` for "back to connected" is racy here: a poll
      // that lands before the close event has even propagated would read
      // the *stale* pre-drop 'connected' and pass trivially, proving
      // nothing. `onStateChange` fires on actual transitions rather than on
      // a timer, so waiting for a real *departure* from 'connected'
      // followed by a real *return* to it is race-free by construction.
      let sawDeparture = false
      const reconnected = new Promise<void>((resolve) => {
        cm.onStateChange((s) => {
          if (s !== 'connected') {
            sawDeparture = true
          } else if (sawDeparture) {
            resolve()
          }
        })
      })
      bridge.dropConnection()
      await Promise.race([
        reconnected,
        new Promise((_resolve, reject) =>
          setTimeout(
            () => reject(new Error('timed out waiting for the §8 reconnect')),
            2000
          )
        ),
      ])
      expect(cm.getState()).toBe('connected')
      // A failed §8 reconnect (e.g. a bad reconnectAccept.mac) makes
      // ConnectionManager fall through to a *fresh* first pairing rather
      // than surfacing an error — which would also reach 'connected' and
      // would also leave `reconnectResponse` populated from the failed
      // attempt. This is the assertion that actually distinguishes "the
      // reconnect succeeded" from "the state machine recovered somehow".
      expect(bridge.sessionCounts()).toEqual({ pair: 1, reconnect: 1 })

      expect(Object.keys(bridge.frames.reconnectResponse ?? {}).sort()).toEqual(
        ['C', 'credentialId', 'mac', 'type'].sort()
      )
      // reconnectChallenge carries protocolVersion; this frame must not.
      expect(bridge.frames.reconnectResponse).not.toHaveProperty(
        'protocolVersion'
      )

      cm.stop()
    } finally {
      await bridge.close()
    }
  })
})
