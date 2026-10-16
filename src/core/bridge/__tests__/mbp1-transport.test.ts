import { createServer as createHttpServer } from 'node:http'
import { connect as netConnect } from 'node:net'
import { MAX_ENVELOPE_PLAINTEXT_BYTES } from '@core/bridge/mbp1/envelope'
import type { EnvelopeChannel } from '@core/bridge/mbp1/envelope-message-stream'
import type { PairDialogRequest } from '@core/bridge/mbp1/pair-session'
import type { PairingPromptEnqueueResult } from '@core/bridge/pairing-prompt-controller'
import {
  BRIDGE_CANDIDATE_PORTS,
  MAX_WEBSOCKET_PAYLOAD_BYTES,
  WebSocketBridgeServer,
} from '@core/bridge/web-socket-bridge-server'
import { ErrorCodes, Notifications } from '@motrix/mdxp'
import { utf8ToBytes } from '@noble/hashes/utils.js'
import type { Browser, ClientIdentity } from '@shared/protocol/bridge'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  type FakeDialogs,
  makeAllowlist,
  makeFakeDialogs,
  makeFakeRegistry,
  makeStatefulFakePairing,
  makeTempCredentialStore,
} from './fakes'
import {
  exchangeCredential,
  fetchNonce,
  type IssuedCredential,
  initializeParams,
  mdxpOverChannel,
  openSealedJson,
  PairAborted,
  reconnect,
  runPake,
  sendSealedJson,
  startPair,
  WireClient,
} from './mbp1-client'
import { mintTicket } from './mbp1-ticket'

const INSTANCE_ID = 'instance-abcdef'
const SERVER_GENERATION = 'gen-1'
const APP_VERSION = '2.0.0-beta.20'
const LOCAL_TOKEN = 'local-token-for-tests'

const OFFICIAL_ID = 'officialextensionidaaaaaaaaaaaaa'
const OFFICIAL_ORIGIN = `chrome-extension://${OFFICIAL_ID}`
const SIDELOADED_ID = 'sideloadedextensionidbbbbbbbbbbb'
const SIDELOADED_ORIGIN = `chrome-extension://${SIDELOADED_ID}`
const FIREFOX_UUID = 'a1b2c3d4-e5f6-4708-9a0b-1c2d3e4f5061'
const FIREFOX_ORIGIN = `moz-extension://${FIREFOX_UUID}`

interface Harness {
  server: WebSocketBridgeServer
  port: number
  dialogs: FakeDialogs
  credentials: Awaited<ReturnType<typeof makeTempCredentialStore>>
  authenticated: Array<{
    identity: ClientIdentity & { kind: 'extension' }
    credentialId: string
  }>
}

async function makeHarness(
  overrides: {
    allowlist?: ReadonlyArray<[Browser, string]>
    host?: string
    queueMbp1Dialog?: (
      args: PairDialogRequest,
      dialogs: FakeDialogs
    ) => PairingPromptEnqueueResult
    extensionMbp1RoutesEnabled?: boolean
  } = {}
): Promise<Harness> {
  const dialogs = makeFakeDialogs()
  const authenticated: Harness['authenticated'] = []
  const credentials = await makeTempCredentialStore()
  const server = new WebSocketBridgeServer({
    pairing: makeStatefulFakePairing(),
    registry: makeFakeRegistry(),
    motrixVersion: '2.0',
    runtime: 'electron',
    ffmpegAvailable: true,
    localToken: LOCAL_TOKEN,
    instanceId: INSTANCE_ID,
    serverGeneration: SERVER_GENERATION,
    appVersion: APP_VERSION,
    credentials,
    isOfficialId: makeAllowlist(
      overrides.allowlist ?? [['chromium', OFFICIAL_ID]]
    ),
    queueMbp1Dialog: (args) =>
      overrides.queueMbp1Dialog?.(args, dialogs) ?? dialogs.queue(args),
    extensionMbp1RoutesEnabled: overrides.extensionMbp1RoutesEnabled,
    onExtensionAuthenticated: (identity, credentialId) =>
      authenticated.push({ identity, credentialId }),
  })
  server.registerReadMethods({
    taskManager: { getAll: () => [], getById: () => undefined },
    statsAggregator: {
      getStats: () => ({
        totalDownloadSpeed: 0,
        totalUploadSpeed: 0,
        activeTasks: 0,
        waitingTasks: 0,
        stoppedTasks: 0,
      }),
    },
    supervisor: {
      getState: () => 'ready' as never,
      getFeatureReport: () => null,
    },
  })
  const port = await server.start(overrides.host ?? '127.0.0.1', 0)
  return { server, port, dialogs, credentials, authenticated }
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

/** Send one raw HTTP request with a chosen `Host`, returning the status line. */
function rawRequest(
  port: number,
  lines: string[]
): Promise<{ status: number; head: string }> {
  return new Promise((resolve, reject) => {
    const socket = netConnect(port, '127.0.0.1', () => {
      socket.write(`${lines.join('\r\n')}\r\n\r\n`)
    })
    let head = ''
    socket.on('data', (chunk) => {
      head += chunk.toString('utf8')
      if (head.includes('\r\n\r\n')) {
        socket.destroy()
        const match = /^HTTP\/1\.\d (\d{3})/.exec(head)
        resolve({ status: match ? Number(match[1]) : 0, head })
      }
    })
    socket.on('error', reject)
    socket.on('close', () => {
      if (head === '') reject(new Error('socket closed with no response'))
    })
  })
}

function upgradeWithHost(
  port: number,
  path: string,
  host: string
): Promise<{ status: number; head: string }> {
  return rawRequest(port, [
    `GET ${path} HTTP/1.1`,
    `Host: ${host}`,
    'Upgrade: websocket',
    'Connection: Upgrade',
    'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==',
    'Sec-WebSocket-Version: 13',
    'Sec-WebSocket-Protocol: motrix-bridge.v1',
    `Origin: ${OFFICIAL_ORIGIN}`,
  ])
}

/** Drive a complete first pair and return the credential the client stored. */
async function pairFully(
  h: Harness,
  opts: { origin?: string; browser?: Browser; claimedExtensionId?: string } = {}
): Promise<{
  wire: WireClient
  credential: IssuedCredential
  channel: EnvelopeChannel
}> {
  const hs = await startPair({
    port: h.port,
    origin: opts.origin ?? OFFICIAL_ORIGIN,
    browser: opts.browser ?? 'chromium',
    claimedExtensionId: opts.claimedExtensionId ?? OFFICIAL_ID,
  })
  const { channel } = await runPake(hs, h.dialogs.latestCode())
  const credential = await exchangeCredential(hs, channel)
  return { wire: hs.wire, credential, channel }
}

/** A distinct Chromium peer whose origin host matches its claimed id (§5). */
function peerFor(index: number): { origin: string; id: string } {
  const id = `peer${String(index).padStart(2, '0')}extensionidaaaaaaaaaa`
  return { origin: `chrome-extension://${id}`, id }
}

// ---------------------------------------------------------------------------
// §4.1 / §4.2 — the unauthenticated HTTP surfaces
// ---------------------------------------------------------------------------

describe('MBP1 HTTP surfaces', () => {
  let h: Harness

  beforeEach(async () => {
    h = await makeHarness()
  })

  afterEach(async () => {
    await h.server.stop()
  })

  it('GET /discovery answers routing and compatibility hints with no-store, pre-auth', async () => {
    const res = await fetch(`http://127.0.0.1:${h.port}/discovery`)

    expect(res.status).toBe(200)
    expect(res.headers.get('cache-control')).toBe('no-store')
    expect(await res.json()).toEqual({
      app: 'motrix-bridge',
      apiVersion: 1,
      instanceId: INSTANCE_ID,
      appVersion: APP_VERSION,
      runtime: 'electron',
      extensionPairing: { protocol: 'mbp1', versions: [1] },
      applicationProtocols: { mdxp: ['1.0'] },
    })
  })

  it('POST /nonce requires X-Motrix-Bridge and answers { nonce, ttlSeconds }', async () => {
    const refused = await fetch(`http://127.0.0.1:${h.port}/nonce`, {
      method: 'POST',
    })
    expect(refused.status).toBe(403)

    const res = await fetch(`http://127.0.0.1:${h.port}/nonce`, {
      method: 'POST',
      headers: { 'x-motrix-bridge': '1' },
    })
    expect(res.status).toBe(200)
    expect(res.headers.get('cache-control')).toBe('no-store')
    const body = (await res.json()) as { nonce: string; ttlSeconds: number }
    expect(body.ttlSeconds).toBe(60)
    expect(body.nonce).toMatch(/^[A-Za-z0-9_-]{16,}$/)
  })

  it('GET /nonce is gone and falls through to 404', async () => {
    const res = await fetch(`http://127.0.0.1:${h.port}/nonce`)
    expect(res.status).toBe(404)
  })

  it('rate-limits nonce issuance rather than issuing past its cap', async () => {
    // 32 outstanding is the §4.2 default; the 33rd must be refused.
    const statuses: number[] = []
    for (let i = 0; i < 33; i++) {
      const res = await fetch(`http://127.0.0.1:${h.port}/nonce`, {
        method: 'POST',
        headers: { 'x-motrix-bridge': '1' },
      })
      statuses.push(res.status)
      await res.arrayBuffer()
    }
    expect(statuses.slice(0, 32)).toEqual(Array(32).fill(200))
    expect(statuses[32]).toBe(429)
  })
})

// ---------------------------------------------------------------------------
// R1 — §4.3 Host-header validation (DNS rebinding)
// ---------------------------------------------------------------------------

describe('§4.3 Host validation', () => {
  let h: Harness

  beforeEach(async () => {
    h = await makeHarness()
  })

  afterEach(async () => {
    await h.server.stop()
  })

  it('rejects a rebound Host on every surface', async () => {
    const discovery = await rawRequest(h.port, [
      'GET /discovery HTTP/1.1',
      'Host: evil.example',
    ])
    expect(discovery.status).toBe(403)

    const nonce = await rawRequest(h.port, [
      'POST /nonce HTTP/1.1',
      'Host: evil.example',
      'X-Motrix-Bridge: 1',
      'Content-Length: 0',
    ])
    expect(nonce.status).toBe(403)

    expect(
      (await upgradeWithHost(h.port, '/pair', 'evil.example')).status
    ).toBe(403)
    expect((await upgradeWithHost(h.port, '/v1', 'evil.example')).status).toBe(
      403
    )
  })

  it('accepts every loopback spelling, with the bound port', async () => {
    for (const host of [
      `127.0.0.1:${h.port}`,
      `localhost:${h.port}`,
      `[::1]:${h.port}`,
      `LOCALHOST:${h.port}`,
    ]) {
      const res = await rawRequest(h.port, [
        'GET /discovery HTTP/1.1',
        `Host: ${host}`,
      ])
      expect(res.status, `Host: ${host}`).toBe(200)
    }
  })

  it('requires the port, and requires it to be the bound one', async () => {
    for (const host of [
      '127.0.0.1',
      'localhost',
      `127.0.0.1:${h.port + 1}`,
      `127.0.0.2:${h.port}`,
      `[::2]:${h.port}`,
    ]) {
      const res = await rawRequest(h.port, [
        'GET /discovery HTTP/1.1',
        `Host: ${host}`,
      ])
      expect(res.status, `Host: ${host}`).toBe(403)
    }
  })

  it('does not break the loopback CLI on POST /mdxp', async () => {
    const res = await fetch(`http://127.0.0.1:${h.port}/mdxp`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${LOCAL_TOKEN}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'task/list',
        params: {},
      }),
    })
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ result: { tasks: [], total: 0 } })
  })

  it('runs BEFORE the nonce is consumed, so a rejected upgrade wastes none', async () => {
    // The ordering control for R1: if the Host check sat after consumption, a
    // rebound page could burn every nonce a legitimate pairing needs.
    const nonce = await fetchNonce(h.port)

    const rejected = await rawRequest(h.port, [
      `GET /pair?nonce=${nonce} HTTP/1.1`,
      'Host: evil.example',
      'Upgrade: websocket',
      'Connection: Upgrade',
      'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==',
      'Sec-WebSocket-Version: 13',
      'Sec-WebSocket-Protocol: motrix-bridge.v1',
      `Origin: ${OFFICIAL_ORIGIN}`,
    ])
    expect(rejected.status).toBe(403)

    // The same nonce still opens a real /pair connection.
    const wire = await WireClient.open(
      `ws://127.0.0.1:${h.port}/pair?nonce=${nonce}`,
      OFFICIAL_ORIGIN
    )
    expect(wire.ws.readyState).toBe(wire.ws.OPEN)
    wire.ws.close()
  })

  it('is inert while bound to a non-loopback host', async () => {
    // §4.3 scopes itself to loopback; the server shell's configured bind keeps
    // its token + reverse-proxy model, where Host is the operator's hostname.
    const remote = await makeHarness({ host: '0.0.0.0' })
    try {
      const res = await rawRequest(remote.port, [
        'GET /discovery HTTP/1.1',
        'Host: motrix.example.com',
      ])
      expect(res.status).toBe(200)
    } finally {
      await remote.server.stop()
    }
  })
})

// ---------------------------------------------------------------------------
// §4 — ingress demultiplexing
// ---------------------------------------------------------------------------

describe('§4 ingress demux', () => {
  let h: Harness

  beforeEach(async () => {
    h = await makeHarness()
  })

  afterEach(async () => {
    await h.server.stop()
  })

  it('rejects a non-extension origin and a missing subprotocol', async () => {
    await expect(
      WireClient.open(`ws://127.0.0.1:${h.port}/v1`, 'https://evil.example')
    ).rejects.toThrow()
    await expect(
      WireClient.open(`ws://127.0.0.1:${h.port}/v1`, OFFICIAL_ORIGIN, null)
    ).rejects.toThrow()
  })

  it('rejects an unknown path', async () => {
    await expect(
      WireClient.open(`ws://127.0.0.1:${h.port}/nope`, OFFICIAL_ORIGIN)
    ).rejects.toThrow()
  })

  it('refuses /pair with an unknown or replayed nonce', async () => {
    await expect(
      WireClient.open(
        `ws://127.0.0.1:${h.port}/pair?nonce=never-issued`,
        OFFICIAL_ORIGIN
      )
    ).rejects.toThrow()

    const nonce = await fetchNonce(h.port)
    const first = await WireClient.open(
      `ws://127.0.0.1:${h.port}/pair?nonce=${nonce}`,
      OFFICIAL_ORIGIN
    )
    await expect(
      WireClient.open(
        `ws://127.0.0.1:${h.port}/pair?nonce=${nonce}`,
        OFFICIAL_ORIGIN
      )
    ).rejects.toThrow()
    first.ws.close()
  })

  it('ignores a ?token= query on /v1 and still speaks first', async () => {
    const wire = await WireClient.open(
      `ws://127.0.0.1:${h.port}/v1?token=whatever`,
      OFFICIAL_ORIGIN
    )
    const challenge = await wire.takeJson<{
      type: string
      protocolVersion: number
      S: string
    }>()

    expect(challenge.type).toBe('reconnectChallenge')
    expect(challenge.protocolVersion).toBe(1)
    wire.ws.close()
  })

  it('closes an unauthenticated socket before buffering past the active-envelope payload cap', async () => {
    const wire = await WireClient.open(
      `ws://127.0.0.1:${h.port}/v1`,
      OFFICIAL_ORIGIN
    )
    await wire.takeJson()

    wire.ws.send(Buffer.alloc(MAX_WEBSOCKET_PAYLOAD_BYTES + 1))

    await expect(wire.closed).resolves.toMatchObject({ code: 1009 })
  })

  it('refuses all four Extension routes when MBP1 is not wired', async () => {
    const bare = new WebSocketBridgeServer({
      pairing: makeStatefulFakePairing(),
      registry: makeFakeRegistry(),
      motrixVersion: '2.0',
      runtime: 'server',
      ffmpegAvailable: false,
      localToken: LOCAL_TOKEN,
    })
    const port = await bare.start('127.0.0.1', 0)
    try {
      const nonce = bare.issuePairNonce()
      await expect(
        WireClient.open(
          `ws://127.0.0.1:${port}/pair?nonce=${nonce}`,
          OFFICIAL_ORIGIN
        )
      ).rejects.toThrow()
      await expect(
        WireClient.open(`ws://127.0.0.1:${port}/v1`, OFFICIAL_ORIGIN)
      ).rejects.toThrow()
      expect((await fetch(`http://127.0.0.1:${port}/discovery`)).status).toBe(
        404
      )
      expect(
        (
          await fetch(`http://127.0.0.1:${port}/nonce`, {
            method: 'POST',
            headers: { 'X-Motrix-Bridge': '1' },
          })
        ).status
      ).toBe(404)
    } finally {
      await bare.stop()
    }
  })

  it('keeps all four routes closed behind the composition-root kill switch', async () => {
    const closed = await makeHarness({ extensionMbp1RoutesEnabled: false })
    try {
      const nonce = closed.server.issuePairNonce()
      await expect(
        WireClient.open(
          `ws://127.0.0.1:${closed.port}/pair?nonce=${nonce}`,
          OFFICIAL_ORIGIN
        )
      ).rejects.toThrow()
      await expect(
        WireClient.open(`ws://127.0.0.1:${closed.port}/v1`, OFFICIAL_ORIGIN)
      ).rejects.toThrow()
      expect(
        (await fetch(`http://127.0.0.1:${closed.port}/discovery`)).status
      ).toBe(404)
      expect(
        (
          await fetch(`http://127.0.0.1:${closed.port}/nonce`, {
            method: 'POST',
            headers: { 'X-Motrix-Bridge': '1' },
          })
        ).status
      ).toBe(404)
    } finally {
      await closed.server.stop()
    }
  })
})

// ---------------------------------------------------------------------------
// §5 — the identity tri-state, resolved against a real allowlist
// ---------------------------------------------------------------------------

describe('§5 identity tri-state', () => {
  let h: Harness

  beforeEach(async () => {
    h = await makeHarness()
  })

  afterEach(async () => {
    await h.server.stop()
  })

  it('official: an allowlisted id proven by the Chromium origin', async () => {
    const hs = await startPair({
      port: h.port,
      origin: OFFICIAL_ORIGIN,
      browser: 'chromium',
      claimedExtensionId: OFFICIAL_ID,
    })

    expect(h.dialogs.latest()).toMatchObject({
      browser: 'chromium',
      claimedExtensionId: OFFICIAL_ID,
      identity: 'official',
    })
    hs.wire.ws.close()
  })

  it('attested-non-official: a ticketless Chromium id that is NOT allowlisted', async () => {
    const hs = await startPair({
      port: h.port,
      origin: SIDELOADED_ORIGIN,
      browser: 'chromium',
      claimedExtensionId: SIDELOADED_ID,
    })

    expect(h.dialogs.latest().identity).toBe('attested-non-official')
    hs.wire.ws.close()
  })

  it('unverified: a ticketless Firefox peer, whose UUID maps to no Gecko id', async () => {
    const hs = await startPair({
      port: h.port,
      origin: FIREFOX_ORIGIN,
      browser: 'firefox',
      claimedExtensionId: 'motrix@example.org',
    })

    expect(h.dialogs.latest().identity).toBe('unverified')
    hs.wire.ws.close()
  })

  it('rejects a Chromium claim that disagrees with its verified origin', async () => {
    await expect(
      startPair({
        port: h.port,
        origin: OFFICIAL_ORIGIN,
        browser: 'chromium',
        claimedExtensionId: SIDELOADED_ID,
      })
    ).rejects.toThrow(PairAborted)
    expect(h.dialogs.requests).toHaveLength(0)
  })

  it('shows the display-grouped code, never the normalized one', async () => {
    const hs = await startPair({
      port: h.port,
      origin: OFFICIAL_ORIGIN,
      browser: 'chromium',
      claimedExtensionId: OFFICIAL_ID,
    })

    expect(h.dialogs.latestCode()).toMatch(
      /^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/
    )
    expect(h.dialogs.latest().pairingNonce).toBe(hs.pairNonce)
    hs.wire.ws.close()
  })
})

// ---------------------------------------------------------------------------
// §9 — attested Firefox, and the §6.5 ticketProof disposition split
// ---------------------------------------------------------------------------

describe('§9 NM attestation over the wire', () => {
  let h: Harness

  beforeEach(async () => {
    // The Gecko id, not the moz-extension UUID, is what a ticket attests.
    h = await makeHarness({
      allowlist: [
        ['firefox', 'motrix@example.org'],
        ['chromium', OFFICIAL_ID],
      ],
    })
  })

  afterEach(async () => {
    await h.server.stop()
  })

  it('attests a Firefox caller a ticket proves, raising it out of unverified', async () => {
    const ticket = mintTicket({
      localToken: LOCAL_TOKEN,
      serverGeneration: SERVER_GENERATION,
      browser: 'firefox',
      callerId: 'motrix@example.org',
    })
    const hs = await startPair({
      port: h.port,
      origin: FIREFOX_ORIGIN,
      browser: 'firefox',
      claimedExtensionId: 'motrix@example.org',
      ticket,
    })

    expect(h.dialogs.latest().identity).toBe('official')
    hs.wire.ws.close()
  })

  it('leaves an attested-but-unlisted caller at attested-non-official', async () => {
    const ticket = mintTicket({
      localToken: LOCAL_TOKEN,
      serverGeneration: SERVER_GENERATION,
      browser: 'firefox',
      callerId: 'other@example.org',
    })
    const hs = await startPair({
      port: h.port,
      origin: FIREFOX_ORIGIN,
      browser: 'firefox',
      claimedExtensionId: 'other@example.org',
      ticket,
    })

    expect(h.dialogs.latest().identity).toBe('attested-non-official')
    hs.wire.ws.close()
  })

  it('keeps a Firefox unknown-generation downgrade at unverified: its origin cannot raise it', async () => {
    const ticket = mintTicket({
      localToken: LOCAL_TOKEN,
      serverGeneration: 'gen-from-a-previous-start',
      browser: 'firefox',
      callerId: 'motrix@example.org',
    })
    const hs = await startPair({
      port: h.port,
      origin: FIREFOX_ORIGIN,
      browser: 'firefox',
      claimedExtensionId: 'motrix@example.org',
      ticket,
    })

    expect(h.dialogs.latest().identity).toBe('unverified')
    hs.wire.ws.close()
  })

  it('resolves a Chromium unknown-generation downgrade from its verified origin: allowlisted stays official (§9.2 only-raise)', async () => {
    const ticket = mintTicket({
      localToken: LOCAL_TOKEN,
      serverGeneration: 'gen-from-a-previous-start',
      browser: 'chromium',
      callerId: OFFICIAL_ID,
    })
    const hs = await startPair({
      port: h.port,
      origin: OFFICIAL_ORIGIN,
      browser: 'chromium',
      claimedExtensionId: OFFICIAL_ID,
      ticket,
    })

    expect(h.dialogs.latest().identity).toBe('official')
    hs.wire.ws.close()
  })

  it('aborts a forged ticket without saying which row it hit', async () => {
    const ticket = mintTicket({
      localToken: 'a-different-token-entirely',
      serverGeneration: SERVER_GENERATION,
      browser: 'firefox',
      callerId: 'motrix@example.org',
    })

    await expect(
      startPair({
        port: h.port,
        origin: FIREFOX_ORIGIN,
        browser: 'firefox',
        claimedExtensionId: 'motrix@example.org',
        ticket,
      })
    ).rejects.toMatchObject({
      // Every §9.2 abort row collapses to this one code, with no detail field.
      frame: { type: 'pairError', code: 'protocolViolation' },
    })
    expect(h.dialogs.requests).toHaveLength(0)
  })

  it('splits §6.5: a wrong-LENGTH proof is a protocolViolation', async () => {
    const ticket = mintTicket({
      localToken: LOCAL_TOKEN,
      serverGeneration: SERVER_GENERATION,
      browser: 'firefox',
      callerId: 'motrix@example.org',
    })
    const hs = await startPair({
      port: h.port,
      origin: FIREFOX_ORIGIN,
      browser: 'firefox',
      claimedExtensionId: 'motrix@example.org',
      ticket,
    })

    await expect(
      runPake(hs, h.dialogs.latestCode(), {
        ticket,
        // 32 bytes where §6.5 requires 64: a malformed frame, not a failed
        // cryptographic check, so it must NOT read as a wrong code.
        ticketProofOverride: 'A'.repeat(43),
      })
    ).rejects.toMatchObject({
      frame: { type: 'pairError', code: 'protocolViolation' },
    })
  })

  it('splits §6.5: a well-formed proof that does not verify is a codeMismatch', async () => {
    const ticket = mintTicket({
      localToken: LOCAL_TOKEN,
      serverGeneration: SERVER_GENERATION,
      browser: 'firefox',
      callerId: 'motrix@example.org',
    })
    const hs = await startPair({
      port: h.port,
      origin: FIREFOX_ORIGIN,
      browser: 'firefox',
      claimedExtensionId: 'motrix@example.org',
      ticket,
    })

    // A valid signature over the WRONG message: 64 bytes, so the schema
    // accepts it and the verifier is the one that refuses.
    const wrongProof = ticket.sign(new Uint8Array(8))
    await expect(
      runPake(hs, h.dialogs.latestCode(), {
        ticket,
        ticketProofOverride: Buffer.from(wrongProof).toString('base64url'),
      })
    ).rejects.toMatchObject({
      frame: {
        type: 'pairError',
        code: 'codeMismatch',
        attemptsRemaining: 2,
      },
    })
  })
})

// ---------------------------------------------------------------------------
// §6 / §10 — the full first pair, then MDXP inside the envelope
// ---------------------------------------------------------------------------

describe('§6 first pair over the wire', () => {
  let h: Harness

  beforeEach(async () => {
    h = await makeHarness()
  })

  afterEach(async () => {
    await h.server.stop()
  })

  it('pairs, then runs motrix/initialize inside the AEAD channel', async () => {
    const hs = await startPair({
      port: h.port,
      origin: OFFICIAL_ORIGIN,
      browser: 'chromium',
      claimedExtensionId: OFFICIAL_ID,
    })
    const { channel } = await runPake(hs, h.dialogs.latestCode())
    const credential = await exchangeCredential(hs, channel)

    expect(credential.credentialId).not.toBe('')
    expect(credential.mutualKey).toHaveLength(32)
    // The dialog is closed at key confirmation, not left on screen.
    expect(h.dialogs.closed).toBe(1)

    const conn = mdxpOverChannel(hs.wire, channel)
    const result = await conn.sendRequest(
      'motrix/initialize',
      initializeParams(OFFICIAL_ID)
    )

    expect(result.server.name).toBe('motrix')
    // The token mint is gone: extensions never receive one again.
    expect(result.pairToken).toBeUndefined()

    const session = h.server.getSession(`chromium:${OFFICIAL_ID}`)
    expect(session).toBeDefined()
    expect(Array.from(h.server.iterSessions())).toHaveLength(1)
    expect(h.authenticated).toEqual([
      {
        identity: {
          kind: 'extension',
          browser: 'chromium',
          extensionId: OFFICIAL_ID,
        },
        credentialId: credential.credentialId,
      },
    ])

    conn.dispose()
    hs.wire.ws.close()
  })

  it('continues the handed-over sequence rather than restarting at zero', async () => {
    // R2's mirror failure: a fresh EnvelopeSealer looks like a working
    // connection until sequence numbers matter. /pair has already sealed
    // credentialOffer (seq 0) and credentialCommitted (seq 1), so the first
    // post-handover server frame MUST carry seq 2.
    const hs = await startPair({
      port: h.port,
      origin: OFFICIAL_ORIGIN,
      browser: 'chromium',
      claimedExtensionId: OFFICIAL_ID,
    })
    const { channel } = await runPake(hs, h.dialogs.latestCode())
    await exchangeCredential(hs, channel)
    const framesBefore = hs.wire.rawFrames.length

    const conn = mdxpOverChannel(hs.wire, channel)
    await conn.sendRequest('motrix/initialize', initializeParams(OFFICIAL_ID))

    const firstAfter = hs.wire.rawFrames[framesBefore]
    expect(firstAfter).toBeDefined()
    expect(firstAfter?.isBinary).toBe(true)
    expect(firstAfter?.bytes.subarray(0, 8).toString('hex')).toBe(
      '0000000000000002'
    )

    conn.dispose()
    hs.wire.ws.close()
  })

  it('exposes the §10 outbound usage counters on the live session', async () => {
    const hs = await startPair({
      port: h.port,
      origin: OFFICIAL_ORIGIN,
      browser: 'chromium',
      claimedExtensionId: OFFICIAL_ID,
    })
    const { channel } = await runPake(hs, h.dialogs.latestCode())
    await exchangeCredential(hs, channel)
    const conn = mdxpOverChannel(hs.wire, channel)
    await conn.sendRequest('motrix/initialize', initializeParams(OFFICIAL_ID))

    const session = h.server.getSession(`chromium:${OFFICIAL_ID}`)
    // The sealer arrived with two frames already spent on the credential
    // exchange, and the initialize response is the third.
    expect(session?.envelope.usage.frames).toBe(3)
    expect(session?.envelope.usage.blocks).toBeGreaterThan(0)

    conn.dispose()
    hs.wire.ws.close()
  })

  it('accepts the largest valid active envelope while capping larger WebSocket messages', async () => {
    const paired = await pairFully(h)
    const initialized = utf8ToBytes(
      JSON.stringify({
        jsonrpc: '2.0',
        method: 'motrix/initialized',
      })
    )
    const plaintext = new Uint8Array(MAX_ENVELOPE_PLAINTEXT_BYTES).fill(0x20)
    plaintext.set(initialized)

    paired.wire.sendBytes(paired.channel.sealer.seal(plaintext))
    await vi.waitFor(() =>
      expect(
        h.server.getSession(`chromium:${OFFICIAL_ID}`)?.conn.isReady()
      ).toBe(true)
    )

    const conn = mdxpOverChannel(paired.wire, paired.channel)
    await expect(
      conn.sendRequest('system/ping', { sentAt: 17 })
    ).resolves.toMatchObject({ sentAt: 17 })

    conn.dispose()
    paired.wire.ws.close()
  })

  it('closes on a text frame injected after channel activation (§10)', async () => {
    // Note what this does NOT pin: a wrapper discriminating on `typeof data`
    // instead of `isBinary` also closes 1002 here, because injected plaintext
    // fails GCM. The §10 rule itself is pinned by the unit test — see the case
    // below for why the sharp form cannot be written against a real socket.
    const hs = await startPair({
      port: h.port,
      origin: OFFICIAL_ORIGIN,
      browser: 'chromium',
      claimedExtensionId: OFFICIAL_ID,
    })
    const { channel } = await runPake(hs, h.dialogs.latestCode())
    await exchangeCredential(hs, channel)
    mdxpOverChannel(hs.wire, channel)

    hs.wire.ws.send(
      JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'task/list', params: {} })
    )

    const closed = await hs.wire.closed
    expect(closed.code).toBe(1002)
  })

  it('refuses a sealed frame that arrives flagged as text, at the transport', async () => {
    // The sharp form of the case above — a payload that WOULD open cleanly, so
    // that only reading `isBinary` can refuse it — is not expressible here, and
    // that is itself the finding: `ws`'s own receiver validates that a TEXT
    // frame is valid UTF-8 and closes 1007 before our wrapper is consulted.
    // Ciphertext is not valid UTF-8, so a sealed frame can never arrive flagged
    // as text through a real socket at all.
    //
    // The §10 rule is therefore pinned by the unit test that CAN deliver
    // arbitrary bytes flagged as text (`mbp1/envelope-message-stream.test.ts`,
    // "refuses a well-formed envelope that arrives flagged as text"); this case
    // records the transport-level bound that makes the rule defence in depth.
    const hs = await startPair({
      port: h.port,
      origin: OFFICIAL_ORIGIN,
      browser: 'chromium',
      claimedExtensionId: OFFICIAL_ID,
    })
    const { channel } = await runPake(hs, h.dialogs.latestCode())
    await exchangeCredential(hs, channel)
    hs.wire.detach()

    const sealed = channel.sealer.seal(
      new Uint8Array(Buffer.from('{"jsonrpc":"2.0","method":"x"}', 'utf8'))
    )
    // `binary: false` puts those exact bytes in a TEXT frame.
    hs.wire.ws.send(Buffer.from(sealed), { binary: false })

    const closed = await Promise.race([
      hs.wire.closed,
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 2_000)),
    ])
    expect(closed?.code).toBe(1007)
  })

  it('closes on a replayed sealed frame after activation (§10)', async () => {
    const hs = await startPair({
      port: h.port,
      origin: OFFICIAL_ORIGIN,
      browser: 'chromium',
      claimedExtensionId: OFFICIAL_ID,
    })
    const { channel } = await runPake(hs, h.dialogs.latestCode())
    await exchangeCredential(hs, channel)
    hs.wire.detach()

    const frame = channel.sealer.seal(
      Buffer.from(
        JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'system/ping',
          params: { sentAt: 1 },
        }),
        'utf8'
      )
    )
    hs.wire.sendBytes(frame)
    hs.wire.sendBytes(frame)

    const closed = await hs.wire.closed
    expect(closed.code).toBe(1002)
  })

  it('serves an initialize pipelined behind credentialAck without dropping it', async () => {
    // R3(c): the client does not wait for credentialCommitted. The request is
    // already queued in the pre-authentication pump when the handover happens,
    // and the session's post-commit guards DROP such frames -- so the pump has
    // to release its unread tail to the new consumer, or the request vanishes
    // and the envelope opener falls a sequence behind.
    const hs = await startPair({
      port: h.port,
      origin: OFFICIAL_ORIGIN,
      browser: 'chromium',
      claimedExtensionId: OFFICIAL_ID,
    })
    const { channel } = await runPake(hs, h.dialogs.latestCode())

    const offer = await openSealedJson<{ credentialId: string }>(
      hs.wire,
      channel
    )
    sendSealedJson(hs.wire, channel, {
      type: 'credentialAck',
      credentialId: offer.credentialId,
    })
    // Immediately, with no round trip in between.
    sendSealedJson(hs.wire, channel, {
      jsonrpc: '2.0',
      id: 7,
      method: 'motrix/initialize',
      params: initializeParams(OFFICIAL_ID),
    })

    const committed = await openSealedJson<{ type: string }>(hs.wire, channel)
    expect(committed.type).toBe('credentialCommitted')

    const response = await openSealedJson<{
      id: number
      result?: { server: { name: string } }
      error?: unknown
    }>(hs.wire, channel)
    expect(response.error).toBeUndefined()
    expect(response.id).toBe(7)
    expect(response.result?.server.name).toBe('motrix')

    hs.wire.ws.close()
  })

  it('leaves exactly one raw message listener attached after adoption', async () => {
    // R3(b): a surviving pre-authentication listener would advance the opener a
    // second time, and the mismatch would surface as a benign parse error.
    const hs = await startPair({
      port: h.port,
      origin: OFFICIAL_ORIGIN,
      browser: 'chromium',
      claimedExtensionId: OFFICIAL_ID,
    })
    const { channel } = await runPake(hs, h.dialogs.latestCode())
    await exchangeCredential(hs, channel)
    const conn = mdxpOverChannel(hs.wire, channel)
    await conn.sendRequest('motrix/initialize', initializeParams(OFFICIAL_ID))

    const session = h.server.getSession(`chromium:${OFFICIAL_ID}`)
    expect(session).toBeDefined()
    for (const ws of (
      h.server as unknown as {
        wss: { clients: Set<{ listenerCount(e: string): number }> }
      }
    ).wss.clients) {
      expect(ws.listenerCount('message')).toBe(1)
    }

    conn.dispose()
    hs.wire.ws.close()
  })

  it('refuses a wrong code three times and then rate-limits', async () => {
    const hs = await startPair({
      port: h.port,
      origin: OFFICIAL_ORIGIN,
      browser: 'chromium',
      claimedExtensionId: OFFICIAL_ID,
    })
    const wrong =
      h.dialogs.latestCode() === 'AAAA-AAAA' ? 'BBBB-BBBB' : 'AAAA-AAAA'

    await expect(runPake(hs, wrong)).rejects.toMatchObject({
      frame: { code: 'codeMismatch', attemptsRemaining: 2 },
    })
    await expect(runPake(hs, wrong)).rejects.toMatchObject({
      frame: { code: 'codeMismatch', attemptsRemaining: 1 },
    })
    await expect(runPake(hs, wrong)).rejects.toMatchObject({
      frame: { code: 'rateLimited' },
    })
    await hs.wire.closed
  })

  it('reports an authenticated operator denial distinctly from shutdown', async () => {
    const hs = await startPair({
      port: h.port,
      origin: OFFICIAL_ORIGIN,
      browser: 'chromium',
      claimedExtensionId: OFFICIAL_ID,
    })

    h.dialogs.dismissLatest()

    const frame = await hs.wire.takeJson<{ type: string; code: string }>()
    expect(frame).toMatchObject({ type: 'pairError', code: 'denied' })
    await hs.wire.closed
  })

  it('refuses a second pairHello on the same connection', async () => {
    const hs = await startPair({
      port: h.port,
      origin: OFFICIAL_ORIGIN,
      browser: 'chromium',
      claimedExtensionId: OFFICIAL_ID,
    })
    // The §7.3 pending slot was taken by the first hello. A second one must be
    // a protocol violation, not a second admission — otherwise one socket could
    // hold an unbounded number of slots.
    hs.wire.sendJson({
      type: 'pairHello',
      protocolVersion: 1,
      browser: 'chromium',
      claimedExtensionId: OFFICIAL_ID,
      clientInstallationId: 'install-1',
    })

    const frame = await hs.wire.takeJson<{ type: string; code: string }>()
    expect(frame).toMatchObject({
      type: 'pairError',
      code: 'protocolViolation',
    })
    expect(h.dialogs.requests).toHaveLength(1)
    await hs.wire.closed
  })

  it('never puts a reason string on a close frame (§11)', async () => {
    // Every close is bare. A reason names the internal step that produced it —
    // dismissal, a ticket row, a wrong code — so it would be exactly the
    // failure oracle §9.2 and §11 forbid, on the one channel a peer always sees.
    const hs = await startPair({
      port: h.port,
      origin: OFFICIAL_ORIGIN,
      browser: 'chromium',
      claimedExtensionId: OFFICIAL_ID,
    })
    h.dialogs.dismissLatest()

    const closed = await hs.wire.closed
    expect(closed.reason).toBe('')
  })
})

// ---------------------------------------------------------------------------
// R3 — the adoption boundary
// ---------------------------------------------------------------------------

describe('R3 adoption boundary', () => {
  let h: Harness

  beforeEach(async () => {
    h = await makeHarness()
  })

  afterEach(async () => {
    await h.server.stop()
  })

  it('does not let a mid-flight /pair evict a live authenticated session', async () => {
    // The vulnerability the pre-authentication table exists to close: the old
    // wiring disposed a same-key session at ATTACH time, so merely opening an
    // unauthenticated socket kicked a live one.
    const live = await pairFully(h)
    const liveConn = mdxpOverChannel(live.wire, live.channel)
    await liveConn.sendRequest(
      'motrix/initialize',
      initializeParams(OFFICIAL_ID)
    )
    const liveSession = h.server.getSession(`chromium:${OFFICIAL_ID}`)
    expect(liveSession).toBeDefined()

    // A second /pair for the SAME principal, driven only to mid-handshake.
    const intruder = await startPair({
      port: h.port,
      origin: OFFICIAL_ORIGIN,
      browser: 'chromium',
      claimedExtensionId: OFFICIAL_ID,
    })

    expect(Array.from(h.server.iterSessions())).toEqual([liveSession])
    // Still alive, not merely still listed.
    const pong = await liveConn.sendRequest('system/ping', { sentAt: 11 })
    expect(pong.sentAt).toBe(11)

    intruder.wire.ws.close()
    liveConn.dispose()
    live.wire.ws.close()
  })

  it('replaces a live session atomically, and the old close does not undo it', async () => {
    const first = await pairFully(h)
    const firstConn = mdxpOverChannel(first.wire, first.channel)
    await firstConn.sendRequest(
      'motrix/initialize',
      initializeParams(OFFICIAL_ID)
    )
    const firstSession = h.server.getSession(`chromium:${OFFICIAL_ID}`)

    const second = await pairFully(h)
    const secondSession = h.server.getSession(`chromium:${OFFICIAL_ID}`)

    expect(second.credential.credentialId).not.toBe(
      first.credential.credentialId
    )
    expect(h.authenticated.map(({ credentialId }) => credentialId)).toEqual([
      first.credential.credentialId,
      second.credential.credentialId,
    ])

    // The key never went empty, and it now holds the newcomer.
    expect(secondSession).toBeDefined()
    expect(secondSession).not.toBe(firstSession)
    expect(Array.from(h.server.iterSessions())).toHaveLength(1)

    // The replaced socket's close must not delete the replacement's entry.
    first.wire.ws.close()
    await first.wire.closed
    await new Promise((r) => setTimeout(r, 20))
    expect(h.server.getSession(`chromium:${OFFICIAL_ID}`)).toBe(secondSession)

    const secondConn = mdxpOverChannel(second.wire, second.channel)
    const pong = await secondConn.sendRequest('system/ping', { sentAt: 5 })
    expect(pong.sentAt).toBe(5)

    firstConn.dispose()
    secondConn.dispose()
    second.wire.ws.close()
  })

  it('drops a session from the map when its own socket closes', async () => {
    const paired = await pairFully(h)
    const conn = mdxpOverChannel(paired.wire, paired.channel)
    await conn.sendRequest('motrix/initialize', initializeParams(OFFICIAL_ID))
    expect(h.server.getSession(`chromium:${OFFICIAL_ID}`)).toBeDefined()

    conn.dispose()
    paired.wire.ws.close()
    await paired.wire.closed
    await new Promise((r) => setTimeout(r, 20))

    expect(h.server.getSession(`chromium:${OFFICIAL_ID}`)).toBeUndefined()
  })

  it('keys a Firefox session by its moz-extension UUID, not the claimed id', async () => {
    // Keying by the self-reported Gecko id would let one Firefox extension
    // evict another's live session just by claiming its id.
    const paired = await pairFully(h, {
      origin: FIREFOX_ORIGIN,
      browser: 'firefox',
      claimedExtensionId: 'motrix@example.org',
    })
    const conn = mdxpOverChannel(paired.wire, paired.channel)
    await conn.sendRequest(
      'motrix/initialize',
      initializeParams('motrix@example.org', 'firefox')
    )

    expect(h.server.getSession(`firefox:${FIREFOX_UUID}`)).toBeDefined()
    expect(h.server.getSession('firefox:motrix@example.org')).toBeUndefined()

    conn.dispose()
    paired.wire.ws.close()
  })
})

// ---------------------------------------------------------------------------
// R4 — §7.3 flood control
// ---------------------------------------------------------------------------

describe('R4 §7.3 flood control', () => {
  let h: Harness

  beforeEach(async () => {
    h = await makeHarness()
  })

  afterEach(async () => {
    await h.server.stop()
  })

  it('counts a session that queued a dialog and then just disconnected', async () => {
    // §7.3 names the early disconnect explicitly, because it is the obvious
    // dodge: without `recordOutcome` on the close path the counter never moves
    // and the whole backoff is dead code while every unit test still passes.
    const first = await startPair({
      port: h.port,
      origin: OFFICIAL_ORIGIN,
      browser: 'chromium',
      claimedExtensionId: OFFICIAL_ID,
    })
    expect(h.dialogs.requests).toHaveLength(1)
    first.wire.ws.close()
    await first.wire.closed

    const peer = peerFor(1)
    await expect(
      startPair({
        port: h.port,
        origin: peer.origin,
        browser: 'chromium',
        claimedExtensionId: peer.id,
      })
    ).rejects.toMatchObject({
      // A lockout, not a pending-slot refusal: the failure counter moved.
      frame: { type: 'pairError', code: 'rateLimited' },
    })
    expect(h.dialogs.requests).toHaveLength(1)
  })

  it('does not count a typed prompt refusal that published no code', async () => {
    await h.server.stop()
    let refuseNext = true
    h = await makeHarness({
      queueMbp1Dialog: (args, dialogs) => {
        if (refuseNext) {
          refuseNext = false
          return { ok: false, reason: 'capacity' }
        }
        return dialogs.queue(args)
      },
    })

    await expect(
      startPair({
        port: h.port,
        origin: OFFICIAL_ORIGIN,
        browser: 'chromium',
        claimedExtensionId: OFFICIAL_ID,
      })
    ).rejects.toMatchObject({
      frame: { type: 'pairError', code: 'pairingFailed' },
    })

    const peer = peerFor(11)
    const next = await startPair({
      port: h.port,
      origin: peer.origin,
      browser: 'chromium',
      claimedExtensionId: peer.id,
    })
    expect(h.dialogs.requests).toHaveLength(1)
    next.wire.ws.close()
  })

  it.each([
    ['failed', () => Promise.resolve<'failed'>('failed')],
    [
      'rejected',
      () =>
        Promise.reject<'failed'>(new Error('secret publisher failure detail')),
    ],
  ] as const)(
    'does not count a %s prompt publisher or leak an unhandled rejection',
    async (_label, publication) => {
      await h.server.stop()
      let replaceNextPublication = true
      h = await makeHarness({
        queueMbp1Dialog: (args, dialogs) => {
          const result = dialogs.queue(args)
          if (!result.ok || !replaceNextPublication) return result
          replaceNextPublication = false
          return {
            ok: true,
            handle: {
              ...result.handle,
              published: publication(),
            },
          }
        },
      })

      await expect(
        startPair({
          port: h.port,
          origin: OFFICIAL_ORIGIN,
          browser: 'chromium',
          claimedExtensionId: OFFICIAL_ID,
        })
      ).rejects.toMatchObject({
        frame: { type: 'pairError', code: 'pairingFailed' },
      })

      const peer = peerFor(12)
      const next = await startPair({
        port: h.port,
        origin: peer.origin,
        browser: 'chromium',
        claimedExtensionId: peer.id,
      })
      expect(h.dialogs.requests).toHaveLength(2)
      next.wire.ws.close()
    }
  )

  it('answers busy — not rateLimited — for a same-origin duplicate with no failures', async () => {
    // The two codes are distinct §11 rows and mean different things to the
    // client; conflating them would tell a caller to back off for 30 s when it
    // merely double-submitted.
    const first = await startPair({
      port: h.port,
      origin: OFFICIAL_ORIGIN,
      browser: 'chromium',
      claimedExtensionId: OFFICIAL_ID,
    })

    await expect(
      startPair({
        port: h.port,
        origin: OFFICIAL_ORIGIN,
        browser: 'chromium',
        claimedExtensionId: OFFICIAL_ID,
      })
    ).rejects.toMatchObject({
      frame: { type: 'pairError', code: 'busy' },
    })

    first.wire.ws.close()
  })

  it('does not count a confirmed pairing as a failure', async () => {
    const paired = await pairFully(h)

    // No lockout: an unrelated origin can still start a pairing.
    const other = peerFor(2)
    const next = await startPair({
      port: h.port,
      origin: other.origin,
      browser: 'chromium',
      claimedExtensionId: other.id,
    })
    expect(h.dialogs.requests).toHaveLength(2)

    next.wire.ws.close()
    paired.wire.ws.close()
  })

  it('releases a pending slot exactly once, never another session’s', async () => {
    // `PairFloodControl` keys pending slots by origin alone, so a second
    // release for an origin that has since re-admitted would free the NEW
    // session's slot and quietly raise the effective cap above 3.
    const paired = await pairFully(h)

    // The same origin takes a fresh slot after its predecessor released one.
    const readmitted = await startPair({
      port: h.port,
      origin: OFFICIAL_ORIGIN,
      browser: 'chromium',
      claimedExtensionId: OFFICIAL_ID,
    })
    // Closing the confirmed session must not touch the slot that re-admission
    // just took.
    paired.wire.ws.close()
    await paired.wire.closed

    const b = peerFor(3)
    const c = peerFor(4)
    const pendingB = await startPair({
      port: h.port,
      origin: b.origin,
      browser: 'chromium',
      claimedExtensionId: b.id,
    })
    const pendingC = await startPair({
      port: h.port,
      origin: c.origin,
      browser: 'chromium',
      claimedExtensionId: c.id,
    })

    // Three pending dialogs (re-admitted, B, C) is the §7.3 cap.
    const d = peerFor(5)
    await expect(
      startPair({
        port: h.port,
        origin: d.origin,
        browser: 'chromium',
        claimedExtensionId: d.id,
      })
    ).rejects.toMatchObject({ frame: { code: 'busy' } })

    readmitted.wire.ws.close()
    pendingB.wire.ws.close()
    pendingC.wire.ws.close()
  })
})

// ---------------------------------------------------------------------------
// §4 — pre-authentication deadlines
// ---------------------------------------------------------------------------

describe('§4 pre-authentication deadlines', () => {
  let h: Harness

  beforeEach(async () => {
    // Only the timer functions: faking Date or setImmediate would break the
    // real socket and HTTP machinery this suite still needs.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    h = await makeHarness()
  })

  afterEach(async () => {
    vi.useRealTimers()
    await h.server.stop()
  })

  it('closes a /v1 socket that upgrades and then says nothing', async () => {
    // `dispose` does not close the socket, so an `onDeadline` that only
    // disposes leaves the peer connected forever, holding a slot.
    const wire = await WireClient.open(
      `ws://127.0.0.1:${h.port}/v1`,
      OFFICIAL_ORIGIN
    )
    await wire.takeJson()

    vi.advanceTimersByTime(15_000)

    await expect(wire.closed).resolves.toMatchObject({
      code: expect.any(Number),
    })
  })

  it('closes a silent /pair socket and still records its §7.3 outcome', async () => {
    const wire = await WireClient.open(
      `ws://127.0.0.1:${h.port}/pair?nonce=${await fetchNonce(h.port)}`,
      OFFICIAL_ORIGIN
    )

    vi.advanceTimersByTime(150_000)

    await expect(wire.closed).resolves.toMatchObject({
      code: expect.any(Number),
    })
    // No dialog was queued and no attempt consumed, so §7.3 does NOT count it:
    // a fresh origin can still pair.
    expect(h.dialogs.requests).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// §8 — reconnect
// ---------------------------------------------------------------------------

describe('§8 reconnect over the wire', () => {
  let h: Harness

  beforeEach(async () => {
    h = await makeHarness()
  })

  afterEach(async () => {
    await h.server.stop()
  })

  it('authenticates with a stored credential and runs MDXP', async () => {
    const paired = await pairFully(h)
    paired.wire.ws.close()
    await paired.wire.closed

    const back = await reconnect({
      port: h.port,
      origin: OFFICIAL_ORIGIN,
      instanceId: INSTANCE_ID,
      credential: paired.credential,
    })
    const conn = mdxpOverChannel(back.wire, back.channel)
    const result = await conn.sendRequest(
      'motrix/initialize',
      initializeParams(OFFICIAL_ID)
    )

    expect(result.server.name).toBe('motrix')
    expect(h.server.getSession(`chromium:${OFFICIAL_ID}`)).toBeDefined()
    expect(h.authenticated.map(({ credentialId }) => credentialId)).toEqual([
      paired.credential.credentialId,
      paired.credential.credentialId,
    ])

    conn.dispose()
    back.wire.ws.close()
  })

  it('durably rejects an old credential and closes its live session after UI-style revocation', async () => {
    const paired = await pairFully(h)
    const conn = mdxpOverChannel(paired.wire, paired.channel)
    await conn.sendRequest('motrix/initialize', initializeParams(OFFICIAL_ID))

    let resolveRevokedNotice!: (notice: { reason: string }) => void
    const revokedNotice = new Promise<{ reason: string }>((resolve) => {
      resolveRevokedNotice = resolve
    })
    const requestDuringGrace = new Promise<unknown>((resolve, reject) => {
      conn.onNotification(Notifications.PairRevoked, (notice) => {
        resolveRevokedNotice(notice)
        void conn.sendRequest('task/list', {}).then(resolve, reject)
      })
    })
    const revoke = h.server.revokeExtensionAccess(
      {
        kind: 'extension',
        browser: 'chromium',
        extensionId: OFFICIAL_ID,
      },
      'user-revoked'
    )

    await expect(revokedNotice).resolves.toEqual({ reason: 'user-revoked' })
    await expect(requestDuringGrace).rejects.toMatchObject({
      code: ErrorCodes.PermissionDenied,
    })
    await expect(revoke).resolves.toBe(1)
    await expect(paired.wire.closed).resolves.toMatchObject({ code: 1000 })
    expect(h.server.getSession(`chromium:${OFFICIAL_ID}`)).toBeUndefined()
    await expect(
      reconnect({
        port: h.port,
        origin: OFFICIAL_ORIGIN,
        instanceId: INSTANCE_ID,
        credential: paired.credential,
      })
    ).rejects.toMatchObject({
      frame: { type: 'pairError', code: 'authFailed' },
    })

    conn.dispose()
  })

  it('cuts authorization synchronously and retains the identity gate when durable deletion fails', async () => {
    const paired = await pairFully(h)
    const conn = mdxpOverChannel(paired.wire, paired.channel)
    await conn.sendRequest('motrix/initialize', initializeParams(OFFICIAL_ID))
    const revokedNotice = vi.fn()
    conn.onNotification(Notifications.PairRevoked, revokedNotice)

    const identity = {
      kind: 'extension' as const,
      browser: 'chromium' as const,
      extensionId: OFFICIAL_ID,
    }
    const durableFailure = new Error('secret durable path')
    vi.spyOn(h.credentials, 'revokeExtensionIdentity').mockRejectedValueOnce(
      durableFailure
    )

    const lease = h.server.beginExtensionRevocation(identity)

    // No await exists between the operator action and this cutoff. The live
    // transport is already unauthorized while durable storage is untouched.
    await expect(conn.sendRequest('task/list', {})).rejects.toMatchObject({
      code: ErrorCodes.PermissionDenied,
    })
    await expect(
      h.server.deleteExtensionAuthorization(lease, 'user-revoked')
    ).rejects.toBe(durableFailure)
    expect(revokedNotice).not.toHaveBeenCalled()
    expect(
      h.credentials.findForAuth(paired.credential.credentialId)
    ).not.toBeNull()
    await expect(paired.wire.closed).resolves.toMatchObject({
      code: expect.any(Number),
    })

    // Failure keeps the same verified identity closed. The retry reuses the
    // nominal lease and only the successful durable delete permits completion.
    await expect(
      WireClient.open(`ws://127.0.0.1:${h.port}/v1`, OFFICIAL_ORIGIN)
    ).rejects.toThrow('unexpected-response 401')
    await expect(
      h.server.deleteExtensionAuthorization(lease, 'user-revoked')
    ).resolves.toBe(1)
    h.server.completeExtensionRevocation(lease)

    await expect(
      reconnect({
        port: h.port,
        origin: OFFICIAL_ORIGIN,
        instanceId: INSTANCE_ID,
        credential: paired.credential,
      })
    ).rejects.toMatchObject({
      frame: { type: 'pairError', code: 'authFailed' },
    })

    conn.dispose()
  })

  it('cancels same-origin pre-auth sessions and refuses replacement handshakes throughout revoke', async () => {
    // Both sockets are admitted before revoke but deliberately remain
    // pre-authenticated: `/pair` is silent, while `/v1` has only received the
    // server challenge. Neither is present in the live-session map.
    const pendingPair = await WireClient.open(
      `ws://127.0.0.1:${h.port}/pair?nonce=${await fetchNonce(h.port)}`,
      OFFICIAL_ORIGIN
    )
    const pendingReconnect = await WireClient.open(
      `ws://127.0.0.1:${h.port}/v1`,
      OFFICIAL_ORIGIN
    )
    await pendingReconnect.takeJson()

    const durableEntered = deferred()
    const allowDurableRevoke = deferred()
    const revokeDurably = h.credentials.revokeExtensionIdentity.bind(
      h.credentials
    )
    vi.spyOn(h.credentials, 'revokeExtensionIdentity').mockImplementation(
      async (browser, extensionId) => {
        durableEntered.resolve()
        await allowDurableRevoke.promise
        return revokeDurably(browser, extensionId)
      }
    )

    const revoke = h.server.revokeExtensionAccess(
      {
        kind: 'extension',
        browser: 'chromium',
        extensionId: OFFICIAL_ID,
      },
      'user-revoked'
    )
    await durableEntered.promise

    try {
      // Cancellation happens synchronously before the durable await, closing
      // both pre-auth state machines so neither can resume and adopt later.
      await expect(pendingPair.closed).resolves.toMatchObject({
        code: expect.any(Number),
      })
      await expect(pendingReconnect.closed).resolves.toMatchObject({
        code: expect.any(Number),
      })
      expect(h.authenticated).toHaveLength(0)

      // Hold durable revocation open to make the race deterministic. New pair
      // and reconnect upgrades for this Origin are refused for the whole
      // critical section. Pair refusal precedes nonce consumption.
      const retryNonce = await fetchNonce(h.port)
      await expect(
        WireClient.open(
          `ws://127.0.0.1:${h.port}/pair?nonce=${retryNonce}`,
          OFFICIAL_ORIGIN
        )
      ).rejects.toThrow('unexpected-response 401')
      await expect(
        WireClient.open(`ws://127.0.0.1:${h.port}/v1`, OFFICIAL_ORIGIN)
      ).rejects.toThrow('unexpected-response 401')

      allowDurableRevoke.resolve()
      await expect(revoke).resolves.toBe(0)

      // The refused attempt did not burn its one-shot nonce; once the revoke
      // section is complete the user can retry normally with the same value.
      const after = await WireClient.open(
        `ws://127.0.0.1:${h.port}/pair?nonce=${retryNonce}`,
        OFFICIAL_ORIGIN
      )
      after.ws.close()
      await after.closed
    } finally {
      // Keep teardown bounded if an assertion above fails before the durable
      // operation is released.
      allowDurableRevoke.resolve()
      await revoke.catch(() => {})
    }
  })

  it('cannot resurrect a credential whose durable offer returns after revoke completes', async () => {
    const offerPersisted = deferred()
    const allowOfferReturn = deferred()
    const offerProvisional = h.credentials.offerProvisional.bind(h.credentials)
    const delayedCredential: { value?: IssuedCredential } = {}
    vi.spyOn(h.credentials, 'offerProvisional').mockImplementation(
      async (principal, identity) => {
        const offer = await offerProvisional(principal, identity)
        delayedCredential.value = {
          credentialId: offer.credentialId,
          mutualKey: new Uint8Array(
            Buffer.from(offer.mutualKeyB64, 'base64url')
          ),
          origin: principal.verifiedOrigin,
          browser: principal.browser,
        }
        offerPersisted.resolve()
        // Keep PairSession suspended after the real store has durably written
        // the provisional. Revocation is therefore queued after that write,
        // deletes it, and disposes the state machine before this call returns.
        await allowOfferReturn.promise
        return offer
      }
    )

    const hs = await startPair({
      port: h.port,
      origin: OFFICIAL_ORIGIN,
      browser: 'chromium',
      claimedExtensionId: OFFICIAL_ID,
    })
    await runPake(hs, h.dialogs.latestCode())
    await offerPersisted.promise

    try {
      await expect(
        h.server.revokeExtensionAccess(
          {
            kind: 'extension',
            browser: 'chromium',
            extensionId: OFFICIAL_ID,
          },
          'user-revoked'
        )
      ).resolves.toBe(1)
      await expect(hs.wire.closed).resolves.toMatchObject({
        code: expect.any(Number),
      })

      // Let the pre-revoke async continuation run only after the revoking gate
      // has cleared. `dispose('access-revoked')` keeps it closed, so it cannot
      // emit the offer or adopt a live session after this point.
      allowOfferReturn.resolve()
      await Promise.resolve()
      await Promise.resolve()
      expect(h.authenticated).toHaveLength(0)
      expect(h.server.getSession(`chromium:${OFFICIAL_ID}`)).toBeUndefined()

      const credential = delayedCredential.value
      if (credential === undefined) {
        throw new Error('durable offer did not expose its credential')
      }
      await expect(
        reconnect({
          port: h.port,
          origin: OFFICIAL_ORIGIN,
          instanceId: INSTANCE_ID,
          credential,
        })
      ).rejects.toMatchObject({
        frame: { type: 'pairError', code: 'authFailed' },
      })
    } finally {
      allowOfferReturn.resolve()
    }
  })

  it('reports authFailed identically for an unknown id and a bad MAC', async () => {
    const paired = await pairFully(h)
    paired.wire.ws.close()

    for (const attempt of [
      { credentialIdOverride: '00000000-0000-4000-8000-000000000000' },
      { corruptMac: true },
    ]) {
      await expect(
        reconnect({
          port: h.port,
          origin: OFFICIAL_ORIGIN,
          instanceId: INSTANCE_ID,
          credential: paired.credential,
          ...attempt,
        })
      ).rejects.toMatchObject({
        frame: { type: 'pairError', code: 'authFailed' },
      })
    }
  })

  it('rejects a stolen credential even when the attacker recomputes its MAC for the live Origin', async () => {
    const paired = await pairFully(h)
    paired.wire.ws.close()
    const stolenCredential = {
      ...paired.credential,
      // Model an active attacker that has credentialId + mutualKey and builds
      // RT from its own live Origin instead of preserving the victim's stored
      // principal. Without a server-side principal comparison this MAC passes.
      origin: SIDELOADED_ORIGIN,
    }

    await expect(
      reconnect({
        port: h.port,
        origin: SIDELOADED_ORIGIN,
        instanceId: INSTANCE_ID,
        credential: stolenCredential,
      })
    ).rejects.toMatchObject({
      frame: { type: 'pairError', code: 'authFailed' },
    })
  })

  it('survives a second reconnect, so the provisional was really promoted', async () => {
    const paired = await pairFully(h)
    paired.wire.ws.close()
    await paired.wire.closed

    const first = await reconnect({
      port: h.port,
      origin: OFFICIAL_ORIGIN,
      instanceId: INSTANCE_ID,
      credential: paired.credential,
    })
    first.wire.ws.close()
    await first.wire.closed

    const second = await reconnect({
      port: h.port,
      origin: OFFICIAL_ORIGIN,
      instanceId: INSTANCE_ID,
      credential: paired.credential,
    })
    expect(second.channel.sealer).toBeDefined()
    second.wire.ws.close()
  })

  it('rate-limits reconnect attempts per verified origin and globally', async () => {
    // §8's closing requirement. `PreAuthTable`'s cap of 32 does NOT cover this:
    // that bounds CONCURRENT pre-auth sockets, so a peer that connects, fails,
    // and disconnects holds no slot and can retry as fast as it likes. The
    // default per-origin allowance is 10 per rolling minute.
    const opened: WireClient[] = []
    for (let i = 0; i < 10; i++) {
      opened.push(
        await WireClient.open(`ws://127.0.0.1:${h.port}/v1`, OFFICIAL_ORIGIN)
      )
    }

    // The 11th from the same origin is refused at the UPGRADE — no socket, no
    // pre-authentication slot, no session object.
    await expect(
      WireClient.open(`ws://127.0.0.1:${h.port}/v1`, OFFICIAL_ORIGIN)
    ).rejects.toThrow()

    // Metered per origin, so a different extension is unaffected.
    const other = await WireClient.open(
      `ws://127.0.0.1:${h.port}/v1`,
      SIDELOADED_ORIGIN
    )
    opened.push(other)

    for (const wire of opened) {
      wire.ws.close()
    }
  })
})

// ---------------------------------------------------------------------------
// Appendix A — transcript misbinding and adversarial key generation
// ---------------------------------------------------------------------------

describe('Appendix A acceptance criteria', () => {
  let h: Harness

  beforeEach(async () => {
    h = await makeHarness()
  })

  afterEach(async () => {
    await h.server.stop()
  })

  it('breaks key confirmation when the client binds a different origin', async () => {
    // Appendix A: "any swap of origin, browser, IDs, versions, nonce, or
    // binding key between the parties MUST break key confirmation". This is the
    // coarse form: it proves the server binds SOME origin into `A_id`. The two
    // cases below pin *which* one.
    const hs = await startPair({
      port: h.port,
      origin: OFFICIAL_ORIGIN,
      browser: 'chromium',
      claimedExtensionId: OFFICIAL_ID,
      transcriptOrigin: SIDELOADED_ORIGIN,
    })

    // The RIGHT code, so the only disagreement is the transcript itself.
    await expect(runPake(hs, h.dialogs.latestCode())).rejects.toMatchObject({
      frame: { type: 'pairError', code: 'codeMismatch' },
    })
  })

  // The named regression: a refactor that builds `A_id` from frame-claimed
  // values instead of `deps.verifiedOrigin`. A client binding some *arbitrary*
  // wrong origin cannot catch that — both the correct and the broken server
  // disagree with it, so confirmation fails either way and the test stays
  // green. Catching it requires the client to bind exactly what the broken
  // server would bind, so that such a server AGREES and confirms a key.
  //
  // Firefox is the setting: there `claimedExtensionId` is the Gecko id and the
  // verified origin is `moz-extension://<UUID>`, two genuinely different
  // strings, so a substitution is observable. (On Chromium the server has
  // already enforced that the origin host equals the claimed id, which is why
  // several substitutions are indistinguishable there.)
  const GECKO_ID = 'motrix@example.org'

  it.each([
    ['the claimed extension id verbatim', GECKO_ID],
    ['an origin rebuilt from the claimed id', `moz-extension://${GECKO_ID}`],
    ['an empty origin, i.e. the field dropped', ''],
  ])(
    'does not bind %s in place of the verified Origin',
    async (_label, substituted) => {
      const hs = await startPair({
        port: h.port,
        origin: FIREFOX_ORIGIN,
        browser: 'firefox',
        claimedExtensionId: GECKO_ID,
        transcriptOrigin: substituted,
      })

      await expect(runPake(hs, h.dialogs.latestCode())).rejects.toMatchObject({
        frame: { type: 'pairError', code: 'codeMismatch' },
      })
    }
  )

  // The `B_id` half: the server must bind its own identity into the transcript.
  // Same reasoning as the `A_id` cases above — an arbitrary wrong instanceId
  // only proves something is bound, so the empty case is included to catch the
  // server dropping the field, where a client that also bound nothing would
  // otherwise agree and confirm.
  it.each([
    ['a different instance', 'some-other-instance'],
    ['an empty instanceId, i.e. the field dropped', ''],
  ])('does not confirm against %s', async (_label, substituted) => {
    const hs = await startPair({
      port: h.port,
      origin: OFFICIAL_ORIGIN,
      browser: 'chromium',
      claimedExtensionId: OFFICIAL_ID,
    })

    await expect(
      runPake(hs, h.dialogs.latestCode(), {
        instanceIdOverride: substituted,
      })
    ).rejects.toMatchObject({
      frame: { type: 'pairError', code: 'codeMismatch' },
    })
  })

  it('fails a grinder with adversarial key generation (Appendix A)', async () => {
    // "Terminating MITM (own PAKE with each side) cannot produce two confirmed
    // keys without the code; a grinder test with adversarial key generation
    // MUST fail."
    //
    // The adversary never reads the dialog. It runs its own PAKE against the
    // server, free to choose both its scalar and the `pA` it puts on the wire.
    //
    // Each choice gets a PRISTINE server on purpose. Sharing one would let
    // §7.3's global lockout refuse the later choices at `pairHello`, before
    // their `pA` ever reached the PAKE — the test would still pass and would
    // have proven nothing about adversarial key generation.
    const lowOrder = (hex: string) => new Uint8Array(Buffer.from(hex, 'hex'))
    const choices: Array<{ label: string; pAOverride?: Uint8Array }> = [
      { label: 'own PAKE under a guessed code' },
      // The canonical edwards25519 low-order points. A server that fails to
      // reject these collapses the shared secret into a value the adversary
      // knows without knowing the code.
      {
        label: 'group identity as pA',
        pAOverride: lowOrder(
          '0100000000000000000000000000000000000000000000000000000000000000'
        ),
      },
      {
        label: 'order-2 pA',
        pAOverride: lowOrder(
          'ecffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f'
        ),
      },
      {
        label: 'order-8 pA',
        pAOverride: lowOrder(
          'c7176a703d4dd84fba3c0b760d10670f2a2053fa2c39ccc64ec7fd7792ac037a'
        ),
      },
    ]

    for (const choice of choices) {
      const fresh = await makeHarness()
      try {
        const outcome = await grind(fresh, choice.pAOverride)
        // Any refusal is acceptable. What must never happen is a confirmed key.
        expect(outcome, `grinder confirmed a key via ${choice.label}`).toBe(
          'REFUSED'
        )
      } finally {
        await fresh.server.stop()
      }
    }
  })

  it('still refuses a grinder that keeps opening fresh sessions', async () => {
    // The grinding motion itself: a new session per guess, so the per-session
    // 3-attempt limit never applies. §7.3's global lockout is what stops it,
    // and it must stop it without ever confirming.
    const outcomes: string[] = []
    for (let i = 0; i < 5; i++) {
      outcomes.push(await grind(h))
    }
    expect(outcomes).toEqual(Array(5).fill('REFUSED'))
  })
})

/**
 * One adversarial pairing attempt that never reads the dialog code. Resolves
 * `'CONFIRMED'` only if the server actually completed key confirmation —
 * anything else, at any stage, is a refusal.
 */
async function grind(
  h: Harness,
  pAOverride?: Uint8Array
): Promise<'CONFIRMED' | 'REFUSED'> {
  try {
    const hs = await startPair({
      port: h.port,
      origin: OFFICIAL_ORIGIN,
      browser: 'chromium',
      claimedExtensionId: OFFICIAL_ID,
    })
    try {
      // A code the adversary picked, never the one on screen.
      const guessed =
        h.dialogs.latestCode() === 'AAAA-AAAA' ? 'BBBB-BBBB' : 'AAAA-AAAA'
      await runPake(hs, guessed, { pAOverride })
      return 'CONFIRMED'
    } finally {
      hs.wire.ws.close()
    }
  } catch (err) {
    // A `pairError` at any stage — including a `rateLimited` refusal before the
    // handshake even starts — is the server declining to proceed.
    if (err instanceof PairAborted) {
      return 'REFUSED'
    }
    throw err
  }
}

// ---------------------------------------------------------------------------
// §4 — startOnFirstFree
// ---------------------------------------------------------------------------

describe('startOnFirstFree', () => {
  it('exposes the §4 candidate range', () => {
    expect(BRIDGE_CANDIDATE_PORTS).toEqual([16802, 16803, 16804, 16805, 16806])
  })

  it('takes the first free candidate and skips an occupied one', async () => {
    const [taken, free] = await allocatePorts(2)
    const blocker = await occupy(taken)
    const h = await makeUnstartedHarness()
    try {
      const bound = await h.startOnFirstFree('127.0.0.1', [taken, free])
      expect(bound).toEqual({ port: free, degraded: false })
    } finally {
      await h.stop()
      await closeServer(blocker)
    }
  })

  it('falls back to an ephemeral port and reports degraded', async () => {
    const ports = await allocatePorts(2)
    const blockers = await Promise.all(ports.map(occupy))
    const h = await makeUnstartedHarness()
    try {
      const bound = await h.startOnFirstFree('127.0.0.1', ports)
      expect(bound.degraded).toBe(true)
      expect(bound.port).toBeGreaterThan(0)
      expect(ports).not.toContain(bound.port)
    } finally {
      await h.stop()
      await Promise.all(blockers.map(closeServer))
    }
  })

  it('rethrows a bind error that is not EADDRINUSE instead of falling back', async () => {
    const h = await makeUnstartedHarness()
    try {
      // An address this host does not own: every candidate would fail the same
      // way, and silently landing on an ephemeral port would hide it.
      await expect(
        h.startOnFirstFree('192.0.2.1', [16802])
      ).rejects.toMatchObject({
        code: expect.stringMatching(/EADDRNOTAVAIL|EACCES/),
      })
    } finally {
      await h.stop()
    }
  })

  it('still refuses a non-loopback bind without a token', async () => {
    const h = new WebSocketBridgeServer({
      pairing: makeStatefulFakePairing(),
      registry: makeFakeRegistry(),
      motrixVersion: '2.0',
      runtime: 'server',
      ffmpegAvailable: false,
      localToken: '',
    })
    try {
      await expect(h.startOnFirstFree('0.0.0.0', [16802])).rejects.toThrow(
        /non-loopback|token/i
      )
    } finally {
      await h.stop()
    }
  })
})

async function makeUnstartedHarness(): Promise<WebSocketBridgeServer> {
  return new WebSocketBridgeServer({
    pairing: makeStatefulFakePairing(),
    registry: makeFakeRegistry(),
    motrixVersion: '2.0',
    runtime: 'electron',
    ffmpegAvailable: false,
    localToken: LOCAL_TOKEN,
  })
}

/** Reserve N ephemeral ports and release them, so the scan has real targets. */
async function allocatePorts(count: number): Promise<number[]> {
  const servers = await Promise.all(
    Array.from({ length: count }, () => occupy(0))
  )
  const ports = servers.map((s) => {
    const addr = s.address()
    if (!addr || typeof addr === 'string') throw new Error('no port')
    return addr.port
  })
  await Promise.all(servers.map(closeServer))
  return ports
}

function occupy(port: number): Promise<ReturnType<typeof createHttpServer>> {
  const server = createHttpServer()
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, '127.0.0.1', () => resolve(server))
  })
}

function closeServer(
  server: ReturnType<typeof createHttpServer>
): Promise<void> {
  return new Promise((resolve, reject) =>
    server.close((err) => (err ? reject(err) : resolve()))
  )
}
