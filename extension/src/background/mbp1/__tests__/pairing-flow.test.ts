import { ed25519 } from '@noble/curves/ed25519.js'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { MBP1_VECTORS } from '@/background/mbp1/__fixtures__/vectors'
import { LOCAL_BACKEND_AUTHORITY } from '@/background/mbp1/backend-authority'
import {
  b64uDecode,
  b64uEncode,
  concatBytes,
  utf8,
} from '@/background/mbp1/canonical'
import {
  type AuthorityCredentialStore,
  CredentialStore,
  type Principal,
} from '@/background/mbp1/credential-store'
import type { DiscoveryResult } from '@/background/mbp1/discovery-service'
import { EnvelopeCodec } from '@/background/mbp1/envelope'
import { FirstPairBackoff } from '@/background/mbp1/first-pair-backoff'
import type { FrameChannel, PairErrorCode } from '@/background/mbp1/frames'
import {
  MAX_RUNS_PER_SESSION,
  PairingFlow,
  type PairingFlowError,
  SESSION_DEADLINE_MS,
} from '@/background/mbp1/pairing-flow'
import { PinStore } from '@/background/mbp1/pin-store'
import { ED25519_GROUP } from '@/background/mbp1/spake2-core'

declare const browser: {
  storage: {
    local: {
      get: (k: string | string[]) => Promise<Record<string, unknown>>
      set: (items: Record<string, unknown>) => Promise<void>
      remove: (k: string | string[]) => Promise<void>
    }
  }
}

const CREDENTIALS_KEY = 'motrix.mbp1.credentials'
const PINS_KEY = 'motrix.mbp1.pins'
const BACKOFF_KEY = 'motrix.mbp1.firstPairBackoff'

const fromHex = (s: string) => Uint8Array.from(Buffer.from(s, 'hex'))

// ---------------------------------------------------------------------------
// The normative vector this suite drives the real client against.
//
// `spake2[0]` is a full first-pair run with an nmTicket present, and the
// `nmTicket` group's fields ARE that ticket (same `bindingPub`, `callerId` ==
// `claimedExtensionId`, and `nmTicket.expected.ticketDigest` ==
// `spake2[0].intermediate.ticketDigest`). `inputs.bindingSeed` is the Ed25519
// secret whose public key is that `bindingPub` — checked here rather than
// assumed, since the whole ticket-binding argument rests on it.
// ---------------------------------------------------------------------------
const V = MBP1_VECTORS.spake2[0]
const VIN = V.inputs
const VMID = V.intermediate
const VOUT = V.expected
if (!VIN || !VMID) throw new Error('vector 0 missing fields')

const CODE = VIN.codeNormalized as string
const PAIR_NONCE = VIN.pairNonce as string
const INSTANCE_ID = VIN.instanceId as string
const CLAIMED_EXTENSION_ID = VIN.claimedExtensionId as string
const PORT = 16803

const PRINCIPAL: Principal = {
  browser: VIN.browser as string,
  verifiedOrigin: VIN.verifiedOrigin as string,
  clientInstallationId: VIN.clientInstallationId as string,
}

const BINDING_PRIV = fromHex(VIN.bindingSeed as string)
const BINDING_PUB = ed25519.getPublicKey(BINDING_PRIV)
const BINDING_KEYPAIR = { priv: BINDING_PRIV, pub: BINDING_PUB }

const NM_TICKET = {
  v: MBP1_VECTORS.nmTicket.inputs.v as number,
  purpose: 'mbp1-attestation',
  protocolVersion: 1,
  serverGeneration: MBP1_VECTORS.nmTicket.inputs.serverGeneration as string,
  browser: MBP1_VECTORS.nmTicket.inputs.browser as string,
  callerId: MBP1_VECTORS.nmTicket.inputs.callerId as string,
  exp: MBP1_VECTORS.nmTicket.inputs.exp as number,
  bindingPub: b64uEncode(
    fromHex(MBP1_VECTORS.nmTicket.inputs.bindingPub as string)
  ),
  mac: b64uEncode(fromHex(MBP1_VECTORS.nmTicket.expected.mac as string)),
}

const VECTOR_PB = b64uEncode(fromHex(VOUT.pB as string))
const VECTOR_CA = b64uEncode(fromHex(VOUT.cA as string))
const VECTOR_CB = b64uEncode(fromHex(VOUT.cB as string))
const VECTOR_TICKET_PROOF = b64uEncode(fromHex(VOUT.ticketProof as string))
const VECTOR_TRAFFIC_C2S = fromHex(VOUT.trafficC2S as string)
const VECTOR_TRAFFIC_S2C = fromHex(VOUT.trafficS2C as string)

const DISCOVERY: DiscoveryResult = {
  transport: 'nm',
  wsPort: PORT,
  instanceId: INSTANCE_ID,
  nonce: PAIR_NONCE,
}

// ---------------------------------------------------------------------------
// In-memory storage, with a durability event log.
//
// The log is what makes §6.7's write-ahead ordering testable: it records the
// moment a credential's sub-state actually LANDED in storage, so an assertion
// can require that the durable `commit-uncertain` flip precedes the
// transmission of `credentialAck` rather than merely both having happened.
// ---------------------------------------------------------------------------
let backing: Record<string, unknown> = {}
let events: string[] = []
let credentialSnapshots: StoredCredentialShape[][] = []

interface StoredCredentialShape {
  credentialId: string
  state: string
  sub?: string
  authenticatedInstanceId?: string | null
}

beforeEach(() => {
  backing = {}
  events = []
  credentialSnapshots = []
  browser.storage.local.get = vi.fn(async (k: string | string[]) => {
    const snapshot: Record<string, unknown> = {}
    for (const key of typeof k === 'string' ? [k] : k) {
      if (key in backing) snapshot[key] = backing[key]
    }
    return snapshot
  })
  browser.storage.local.set = vi.fn(async (items: Record<string, unknown>) => {
    backing = { ...backing, ...items }
    const set = items[CREDENTIALS_KEY] as
      | { credentials: StoredCredentialShape[] }
      | undefined
    if (set !== undefined) {
      credentialSnapshots.push(
        set.credentials.map((credential) => ({ ...credential }))
      )
      for (const credential of set.credentials) {
        events.push(
          `durable:${credential.state}${
            credential.sub === undefined ? '' : `/${credential.sub}`
          }`
        )
      }
    }
    if (items[PINS_KEY] !== undefined) events.push('durable:pin')
  })
  browser.storage.local.remove = vi.fn(async (k: string | string[]) => {
    for (const key of Array.isArray(k) ? k : [k]) delete backing[key]
  })
})

function storedCredentials(): StoredCredentialShape[] {
  const set = backing[CREDENTIALS_KEY] as
    | { credentials: StoredCredentialShape[] }
    | undefined
  return set?.credentials ?? []
}

function storedPins(): Record<string, unknown> {
  const set = backing[PINS_KEY] as { pins: Record<string, unknown> } | undefined
  return set?.pins ?? {}
}

// ---------------------------------------------------------------------------
// A scripted peer playing the server side of `/pair`.
//
// It computes nothing: every crypto value it emits is read straight out of the
// normative vector file, and the envelope it opens the client's `credentialAck`
// with is keyed from the vector's own traffic keys. That is deliberate — a peer
// that derived its keys with the same production functions the client uses
// would agree with a wrong implementation just as happily as with a right one.
// ---------------------------------------------------------------------------
interface BridgeOptions {
  openError?: Error
  instanceId?: string
  protocolVersion?: number
  pB?: string
  cB?: string
  credentialId?: string
  mutualKey?: string
  /** Answer `pakeA` with this `pairError` instead of `pakeB`. */
  pakeAError?: { code: PairErrorCode; attemptsRemaining?: number }
  /** Answer `confirmA` with this `pairError` instead of `confirmB`. */
  confirmAError?: { code: PairErrorCode; attemptsRemaining?: number }
  /** Send nothing at all after this frame, so the client's next receive fails. */
  silentAfter?: 'pairAccept' | 'pakeB' | 'confirmB' | 'credentialAck'
  /** Fires just before `confirmB` is queued. */
  beforeConfirmB?: () => void
  /**
   * Fires the moment the sealed `credentialOffer` has been **handed to the
   * client**, i.e. inside its `receiveBinary` call.
   *
   * This exists because `beforeConfirmB`-style hooks fire while the client is
   * still inside `sendText(confirmA)`, so a flag flipped there is caught by the
   * currency check right after that send — nowhere near the credential phase.
   * Only a hook on the client's own read lands in the window between "the offer
   * is in hand" and "the first durable write", which is the window §6.7's
   * "abort cleanly, no partial credential" rule is about.
   */
  afterOfferDelivered?: () => void
}

class ScriptedChannel implements FrameChannel {
  readonly openedUrls: string[] = []
  readonly sentText: Record<string, unknown>[] = []
  readonly textTimeouts: number[] = []
  readonly binaryTimeouts: number[] = []
  closeCount = 0

  private binaryReads = 0
  private readonly textInbox: string[] = []
  private readonly binaryInbox: Uint8Array[] = []
  private readonly options: BridgeOptions
  private serverEnvelope: EnvelopeCodec | null = null

  constructor(options: BridgeOptions = {}) {
    this.options = options
  }

  /** How many protocol runs the client actually started (§6.5's ceiling). */
  get pakeARunCount(): number {
    return this.sentText.filter((frame) => frame.type === 'pakeA').length
  }

  get sentPakeAShares(): unknown[] {
    return this.sentText
      .filter((frame) => frame.type === 'pakeA')
      .map((frame) => frame.pA)
  }

  async open(url: string): Promise<void> {
    this.openedUrls.push(url)
    if (this.options.openError !== undefined) throw this.options.openError
  }

  async sendText(frame: object): Promise<void> {
    const parsed = frame as Record<string, unknown>
    this.sentText.push(parsed)
    events.push(`wire:${String(parsed.type)}`)
    await this.react(parsed)
  }

  async receiveText(timeoutMs: number): Promise<string> {
    this.textTimeouts.push(timeoutMs)
    const next = this.textInbox.shift()
    if (next === undefined) {
      // A real adapter rejects when the socket closes with nothing pending;
      // the flows depend on being able to tell that from "still waiting".
      throw new Error('scripted peer: socket closed with no text frame pending')
    }
    return next
  }

  async sendBinary(frame: Uint8Array): Promise<void> {
    const envelope = this.serverEnvelope
    if (envelope === null) throw new Error('binary frame before channel active')
    const plaintext = await envelope.open(frame)
    const parsed = JSON.parse(new TextDecoder().decode(plaintext)) as Record<
      string,
      unknown
    >
    events.push(`wire:${String(parsed.type)}`)
    if (parsed.type !== 'credentialAck') {
      throw new Error(`scripted peer: unexpected sealed frame ${parsed.type}`)
    }
    if (parsed.credentialId !== this.credentialId()) {
      throw new Error('scripted peer: credentialAck echoed the wrong id')
    }
    if (this.options.silentAfter === 'credentialAck') return
    await this.seal({ type: 'credentialCommitted' })
  }

  async receiveBinary(timeoutMs: number): Promise<Uint8Array> {
    this.binaryTimeouts.push(timeoutMs)
    const next = this.binaryInbox.shift()
    if (next === undefined) {
      throw new Error(
        'scripted peer: socket closed with no binary frame pending'
      )
    }
    this.binaryReads += 1
    if (this.binaryReads === 1) this.options.afterOfferDelivered?.()
    return next
  }

  close(): void {
    this.closeCount += 1
  }

  private credentialId(): string {
    return this.options.credentialId ?? 'cred-vector-1'
  }

  private pushText(frame: object): void {
    this.textInbox.push(JSON.stringify(frame))
  }

  private async seal(frame: object): Promise<void> {
    const envelope = this.serverEnvelope
    if (envelope === null) throw new Error('seal before channel active')
    this.binaryInbox.push(await envelope.seal(utf8(JSON.stringify(frame))))
  }

  private async react(frame: Record<string, unknown>): Promise<void> {
    if (frame.type === 'pairHello') {
      this.pushText({
        type: 'pairAccept',
        protocolVersion: this.options.protocolVersion ?? 1,
        instanceId: this.options.instanceId ?? INSTANCE_ID,
      })
      return
    }
    if (frame.type === 'pakeA') {
      if (this.options.silentAfter === 'pairAccept') return
      if (this.options.pakeAError !== undefined) {
        this.pushText({ type: 'pairError', ...this.options.pakeAError })
        return
      }
      this.pushText({ type: 'pakeB', pB: this.options.pB ?? VECTOR_PB })
      return
    }
    if (frame.type === 'confirmA') {
      if (this.options.silentAfter === 'pakeB') return
      if (this.options.confirmAError !== undefined) {
        this.pushText({ type: 'pairError', ...this.options.confirmAError })
        return
      }
      this.options.beforeConfirmB?.()
      this.pushText({ type: 'confirmB', cB: this.options.cB ?? VECTOR_CB })
      if (this.options.silentAfter === 'confirmB') return
      // §6.6: the channel is live in both directions from here, so the server
      // seals its offer immediately after `confirmB` with no client frame in
      // between — which is why the offer has to be queued here.
      this.serverEnvelope = await EnvelopeCodec.create(
        VECTOR_TRAFFIC_C2S,
        VECTOR_TRAFFIC_S2C,
        'server'
      )
      this.options.beforeOffer?.()
      await this.seal({
        type: 'credentialOffer',
        credentialId: this.credentialId(),
        mutualKey:
          this.options.mutualKey ?? b64uEncode(new Uint8Array(32).fill(9)),
      })
      return
    }
  }
}

interface FlowHarness {
  channel: ScriptedChannel
  creds: CredentialStore
  lifecycle: AuthorityCredentialStore
  pins: PinStore
  backoff: FirstPairBackoff
  flow: PairingFlow
  setCurrent: (value: boolean) => void
  advance: (ms: number) => void
}

function makeHarness(
  options: BridgeOptions = {},
  overrides: {
    current?: boolean
    x?: Uint8Array
    now?: number
  } = {}
): FlowHarness {
  const channel = new ScriptedChannel(options)
  const creds = new CredentialStore()
  const lifecycle = creds.forAuthorityForTest(LOCAL_BACKEND_AUTHORITY)
  const pins = new PinStore()
  const backoff = new FirstPairBackoff()
  let current = overrides.current ?? true
  let clock = overrides.now ?? 1_700_000_000_000
  // A deterministic 32-byte draw. The vector's `x` first (so the happy path
  // reproduces the vector exactly), then a distinct value per subsequent run,
  // which is what lets a test assert §6.3's "fresh `x` per protocol run".
  let draws = 0
  const random = (n: number): Uint8Array => {
    draws += 1
    if (draws === 1) return overrides.x ?? fromHex(VIN?.x ?? '')
    const bytes = new Uint8Array(n)
    bytes[n - 1] = draws
    return bytes
  }
  const flow = new PairingFlow({
    channel,
    creds: lifecycle,
    pins,
    backoff,
    isCurrent: () => current,
    now: () => clock,
    random,
  })
  return {
    channel,
    creds,
    lifecycle,
    pins,
    backoff,
    flow,
    setCurrent: (value) => {
      current = value
    },
    advance: (ms) => {
      clock += ms
    },
  }
}

function runArgs(
  overrides: Partial<Parameters<PairingFlow['run']>[0]> = {}
): Parameters<PairingFlow['run']>[0] {
  return {
    code: CODE,
    discovery: DISCOVERY,
    principal: PRINCIPAL,
    claimedExtensionId: CLAIMED_EXTENSION_ID,
    bindingKeypair: BINDING_KEYPAIR,
    nmTicket: NM_TICKET,
    ...overrides,
  }
}

async function expectFlowError(
  promise: Promise<unknown>,
  reason: string
): Promise<PairingFlowError> {
  try {
    await promise
  } catch (error) {
    expect((error as PairingFlowError).name).toBe('PairingFlowError')
    expect((error as PairingFlowError).reason).toBe(reason)
    return error as PairingFlowError
  }
  throw new Error(`expected the flow to reject with ${reason}`)
}

// ---------------------------------------------------------------------------

describe('the vector fixture this suite rests on', () => {
  it('derives the vector bindingPub from the vector bindingSeed', () => {
    expect(b64uEncode(BINDING_PUB)).toBe(NM_TICKET.bindingPub)
  })
})

describe('PairingFlow happy path (§6.1-§6.7, against the §13 vectors)', () => {
  it('completes first pair and persists a provisional then committed credential', async () => {
    const h = makeHarness()
    const { credentialId, envelope, instanceId } = await h.flow.run(runArgs())

    expect(credentialId).toBe('cred-vector-1')
    expect(instanceId).toBe(INSTANCE_ID)
    expect(envelope).toBeInstanceOf(EnvelopeCodec)

    const order = await h.creds.recoverOrder(PRINCIPAL)
    expect(order.find((c) => c.credentialId === credentialId)).toMatchObject({
      state: 'committed',
      authenticatedInstanceId: INSTANCE_ID,
    })
  })

  it('opens /pair with only ?nonce=, and never a token or identity parameter', async () => {
    const h = makeHarness()
    await h.flow.run(runArgs())
    expect(h.channel.openedUrls).toEqual([
      `ws://127.0.0.1:${PORT}/pair?nonce=${PAIR_NONCE}`,
    ])
    expect(h.channel.openedUrls[0]).not.toMatch(/token=/)
    expect(h.channel.openedUrls[0]).not.toMatch(/extension/i)
  })

  it('uses an explicit remote WSS route without creating local port pins', async () => {
    const h = makeHarness()
    await h.flow.run(
      runArgs({
        remotePairUrl: `wss://motrix.example/bridge/pair?nonce=${PAIR_NONCE}`,
      })
    )

    expect(h.channel.openedUrls).toEqual([
      `wss://motrix.example/bridge/pair?nonce=${PAIR_NONCE}`,
    ])
    expect(backing[PINS_KEY]).toBeUndefined()
  })

  it('sends exactly the frames Line A accepts, byte-for-byte against the vector', async () => {
    const h = makeHarness()
    await h.flow.run(runArgs())

    const [hello, pakeA, confirmA] = h.channel.sentText
    expect(hello).toEqual({
      type: 'pairHello',
      protocolVersion: 1,
      browser: 'chromium',
      claimedExtensionId: CLAIMED_EXTENSION_ID,
      clientInstallationId: PRINCIPAL.clientInstallationId,
      nmTicket: NM_TICKET,
      ticketBindingKey: b64uEncode(BINDING_PUB),
    })
    // The whole interop risk in one assertion: the derived values on the wire
    // are the normative vector's, so Line A's validator and its SPAKE2 would
    // both accept them.
    expect(pakeA).toEqual({ type: 'pakeA', pA: b64uEncode(fromHex(VOUT.pA)) })
    expect(confirmA).toEqual({
      type: 'confirmA',
      cA: VECTOR_CA,
      ticketProof: VECTOR_TICKET_PROOF,
    })
  })

  it('passes the host ticket through unchanged', async () => {
    const h = makeHarness()
    const ticket = { ...NM_TICKET }
    await h.flow.run(runArgs({ nmTicket: ticket }))
    // Never rewritten, normalized, reordered, or dropped: a downgraded ticket
    // lands in `unverified`, which is worse than presenting none, so gaming it
    // would corrupt the user's only signal about what the server verified.
    expect(h.channel.sentText[0]?.nmTicket).toEqual(ticket)
  })

  it('signs ticketProof with the same key it put in ticketBindingKey', async () => {
    const h = makeHarness()
    await h.flow.run(runArgs())
    const hello = h.channel.sentText[0]
    const confirmA = h.channel.sentText[2]
    const sentBindingKey = b64uDecode(hello?.ticketBindingKey as string)

    // Line A requires `nmTicket.bindingPub === ticketBindingKey` and aborts
    // under §9.2 otherwise, so all three uses of the keypair must be the same
    // key: the `bindingPub` the host was sent, `ticketBindingKey`, and the key
    // `ticketProof` verifies under.
    expect(sentBindingKey).toEqual(BINDING_PUB)
    expect(b64uDecode(NM_TICKET.bindingPub)).toEqual(BINDING_PUB)
    const proof = b64uDecode(confirmA?.ticketProof as string)
    const message = concatBytes(
      utf8('MBP1/ticket-proof/v1'),
      fromHex(VOUT.TT as string)
    )
    expect(
      ed25519.verify(proof, message, sentBindingKey, { zip215: false })
    ).toBe(true)
  })

  it('omits both ticket fields and the proof on a ticketless attempt', async () => {
    // Vector 1 is vector 0 with the ticket absent: same w/x/pB and the same
    // `Ke`, only the AAD moves — so the peer must answer with vector 1's `cB`,
    // and the client must produce vector 1's `cA`. Driving the ticketless path
    // off its own vector is what proves the empty `enc()` slots in §6.4's AAD
    // are built the way both sides expect.
    const v1 = MBP1_VECTORS.spake2[1]
    const h = makeHarness({ cB: b64uEncode(fromHex(v1.expected.cB as string)) })
    await h.flow.run(
      runArgs({
        nmTicket: undefined,
        bindingKeypair: undefined,
        discovery: { transport: 'probe', wsPort: PORT, nonce: PAIR_NONCE },
      })
    )
    const hello = h.channel.sentText[0] ?? {}
    expect('nmTicket' in hello).toBe(false)
    expect('ticketBindingKey' in hello).toBe(false)
    expect(h.channel.sentText[2]).toEqual({
      type: 'confirmA',
      cA: b64uEncode(fromHex(v1.expected.cA as string)),
    })
  })

  it('leaves the socket open on success and clears the backoff counter', async () => {
    const h = makeHarness()
    await h.backoff.recordFailure(1_699_000_000_000)
    await h.flow.run(runArgs())
    // The caller owns the socket from here: MDXP `motrix/initialize` runs
    // inside the envelope the flow just returned.
    expect(h.channel.closeCount).toBe(0)
    expect(backing[BACKOFF_KEY]).toBeUndefined()
  })

  it('commits the pin only after mutual authentication, with the confirmed instanceId', async () => {
    const h = makeHarness()
    const { credentialId } = await h.flow.run(runArgs())
    expect(await h.pins.get(credentialId)).toEqual({
      port: PORT,
      instanceId: INSTANCE_ID,
    })
    // The pin lands last, after the credential is committed — §12: never from
    // `/discovery`, only after a mutually-authenticated session on that port.
    expect(events.lastIndexOf('durable:pin')).toBeGreaterThan(
      events.lastIndexOf('durable:committed')
    )
  })
})

describe('PairingFlow transport classification', () => {
  it('reports an open failure as channelUnavailable without reflecting browser detail', async () => {
    const h = makeHarness({
      openError: new Error(
        'certificate for private.example failed with secret proxy detail'
      ),
    })

    const error = await expectFlowError(
      h.flow.run(runArgs()),
      'channelUnavailable'
    )

    expect(error.message).toBe('the pairing channel could not be opened')
    expect(error.message).not.toContain('private.example')
    expect(h.channel.closeCount).toBe(1)
  })
})

describe('§6.7 two-phase commit ordering', () => {
  it('lands the durable commit-uncertain write BEFORE transmitting credentialAck', async () => {
    const h = makeHarness()
    await h.flow.run(runArgs())

    const unacked = events.indexOf('durable:provisional/unacked')
    const uncertain = events.indexOf('durable:provisional/commit-uncertain')
    const ack = events.indexOf('wire:credentialAck')
    const committed = events.indexOf('durable:committed')

    expect(unacked).toBeGreaterThanOrEqual(0)
    expect(
      credentialSnapshots[0]?.find(
        (credential) => credential.credentialId === 'cred-vector-1'
      )?.authenticatedInstanceId
    ).toBe(INSTANCE_ID)
    expect(uncertain).toBeGreaterThan(unacked)
    // The mandatory write-ahead: `commit-uncertain` must mean "the ack MAY have
    // been sent", so a crash in this gap lands in the retain-forever state
    // rather than the age-out state.
    expect(ack).toBeGreaterThan(uncertain)
    expect(committed).toBeGreaterThan(ack)
  })

  it('never marks a credential committed before credentialCommitted arrives', async () => {
    // The server sends nothing after the ack, so the client must be left with a
    // retained `commit-uncertain` credential — not a committed one. That is the
    // state §6.7 requires here: the ack may have reached the server, which may
    // then have committed, so the entry must survive rather than age out.
    const h = makeHarness({ silentAfter: 'credentialAck' })
    await expect(h.flow.run(runArgs())).rejects.toThrow()
    expect(storedCredentials()).toEqual([
      expect.objectContaining({
        state: 'provisional',
        sub: 'commit-uncertain',
      }),
    ])
  })

  it('deletes the pins of every credential the post-auth prune removed (§12)', async () => {
    const h = makeHarness()
    // An interrupted earlier rotation: a committed predecessor with its own pin.
    await h.creds.writeProvisionalUnacked(PRINCIPAL, {
      credentialId: 'old-cred',
      mutualKey: b64uEncode(new Uint8Array(32).fill(4)),
    })
    await h.creds.commitAndActivate('old-cred', PRINCIPAL)
    await h.pins.commit('old-cred', { port: 16802, instanceId: 'other' })
    expect(await h.pins.get('old-cred')).not.toBeNull()

    const { credentialId } = await h.flow.run(runArgs())

    expect(storedCredentials().map((c) => c.credentialId)).toEqual([
      credentialId,
    ])
    // Omitting `finalizeAndPrune`'s callback orphans one pin per interrupted
    // rotation, forever.
    expect(await h.pins.get('old-cred')).toBeNull()
    expect(Object.keys(storedPins())).toEqual([credentialId])
  })

  it('clears each stale pin while its credential still exists', async () => {
    // The ordering, asserted directly rather than through an interruption.
    // `PinStore` is addressed by credentialId and cannot enumerate, so a
    // credential deleted before its pin is cleared strands that pin forever —
    // nothing can name it again. Observing that the credential is still present
    // at the moment its pin is cleared is exactly that ordering, and it fails
    // if the two are swapped.
    //
    // Both halves now run in one `finalizeAndPrune` transaction, so the ids
    // the callback clears are provably the ids deleted; a plan-then-apply split
    // across two transactions would let a concurrent write move the set in
    // between.
    const h: FlowHarness = makeHarness()
    await h.creds.writeProvisionalUnacked(PRINCIPAL, {
      credentialId: 'old-cred',
      mutualKey: b64uEncode(new Uint8Array(32).fill(4)),
    })
    await h.creds.commitAndActivate('old-cred', PRINCIPAL)
    await h.pins.commit('old-cred', { port: 16802, instanceId: 'other' })

    const presentWhenCleared: string[] = []
    const realClear = h.pins.clear.bind(h.pins)
    h.pins.clear = async (id: string): Promise<void> => {
      presentWhenCleared.push(
        ...storedCredentials()
          .map((c) => c.credentialId)
          .filter((c) => c === id)
      )
      await realClear(id)
    }

    await h.flow.run(runArgs())

    // The pin was cleared while `old-cred` was still stored...
    expect(presentWhenCleared).toEqual(['old-cred'])
    // ...and by the end both are gone, together.
    expect(await h.pins.get('old-cred')).toBeNull()
    expect(storedCredentials().map((c) => c.credentialId)).not.toContain(
      'old-cred'
    )
  })
})

describe('an unclassified error is still wrapped as a typed failure', () => {
  it('wraps a finalizeAndPrune rejection as internalError without pruning the predecessor', async () => {
    const h = makeHarness()
    // An existing credential and pin from an earlier pairing — proof that a
    // failure deep inside issueCredential does not touch unrelated state.
    await h.creds.writeProvisionalUnacked(PRINCIPAL, {
      credentialId: 'old-cred',
      mutualKey: b64uEncode(new Uint8Array(32).fill(4)),
    })
    await h.creds.commitAndActivate('old-cred', PRINCIPAL)
    await h.pins.commit('old-cred', { port: 16802, instanceId: 'other' })

    vi.spyOn(h.lifecycle, 'finalizeAndPrune').mockRejectedValue(
      new Error('finalizeAndPrune: unknown credential')
    )

    const error = await expectFlowError(h.flow.run(runArgs()), 'internalError')
    expect(error.message).toBe('finalizeAndPrune: unknown credential')

    // The pre-existing credential and its pin are untouched.
    expect(await h.pins.get('old-cred')).toEqual({
      port: 16802,
      instanceId: 'other',
    })
    expect(storedCredentials().map((c) => c.credentialId)).toContain('old-cred')
    // This run's durable write-ahead landed, but the atomic finalize did not:
    // the candidate remains commit-uncertain and the predecessor remains live.
    expect(storedCredentials()).toContainEqual(
      expect.objectContaining({
        credentialId: 'cred-vector-1',
        state: 'provisional',
        sub: 'commit-uncertain',
      })
    )
  })
})

describe('§6.5 client-side attempt ceiling', () => {
  it('stops after 3 failed runs regardless of server attemptsRemaining', async () => {
    const h = makeHarness({
      confirmAError: { code: 'codeMismatch', attemptsRemaining: 99 },
    })
    const error = await expectFlowError(
      h.flow.run(runArgs({ code: 'WRONGCOD' })),
      'runsExhausted'
    )
    // A fake listener answering `codeMismatch, attemptsRemaining: 99` forever
    // harvests one password test per induced run; only the local ceiling stops
    // it, and it must hold at 3 no matter what the peer claims.
    expect(h.channel.pakeARunCount).toBe(MAX_RUNS_PER_SESSION)
    expect(error.attemptsRemaining).toBe(99)
    expect(storedCredentials()).toEqual([])
  })

  it('retries with a fresh x on every run (§6.3)', async () => {
    const h = makeHarness({
      confirmAError: { code: 'codeMismatch', attemptsRemaining: 99 },
    })
    await expectFlowError(
      h.flow.run(runArgs({ code: 'WRONGCOD' })),
      'runsExhausted'
    )
    const shares = h.channel.sentPakeAShares
    expect(shares).toHaveLength(MAX_RUNS_PER_SESSION)
    expect(new Set(shares).size).toBe(MAX_RUNS_PER_SESSION)
  })

  it('retries through a codeMismatch answered at pakeA as well', async () => {
    const h = makeHarness({
      pakeAError: { code: 'codeMismatch', attemptsRemaining: 2 },
    })
    await expectFlowError(h.flow.run(runArgs()), 'runsExhausted')
    expect(h.channel.pakeARunCount).toBe(MAX_RUNS_PER_SESSION)
  })

  it('re-asks a code provider once per run, reporting the untrusted count', async () => {
    const h = makeHarness({
      confirmAError: { code: 'codeMismatch', attemptsRemaining: 99 },
    })
    const requests: unknown[] = []
    const provider = async (request: unknown): Promise<string> => {
      requests.push(request)
      return 'WRONGCOD'
    }
    await expectFlowError(
      h.flow.run(runArgs({ code: provider })),
      'runsExhausted'
    )
    expect(requests).toHaveLength(MAX_RUNS_PER_SESSION)
    expect(requests[0]).toEqual({
      instanceId: INSTANCE_ID,
      timeoutMs: expect.any(Number),
      run: 1,
      attemptsRemaining: null,
    })
    // Forwarded for display only — it never influenced the ceiling above.
    expect(requests[2]).toEqual(
      expect.objectContaining({ run: 3, attemptsRemaining: 99 })
    )
  })

  it('does not retry a pairError other than codeMismatch', async () => {
    // §11 `rateLimited` is the peer asking for patience, not a refusal —
    // it gets its own reason so the UI can say "try again later".
    const h = makeHarness({ confirmAError: { code: 'rateLimited' } })
    const error = await expectFlowError(h.flow.run(runArgs()), 'peerBusy')
    expect(error.pairErrorCode).toBe('rateLimited')
    expect(h.channel.pakeARunCount).toBe(1)
  })

  it('maps a busy pairError to peerBusy as well', async () => {
    const h = makeHarness({ confirmAError: { code: 'busy' } })
    const error = await expectFlowError(h.flow.run(runArgs()), 'peerBusy')
    expect(error.pairErrorCode).toBe('busy')
    expect(h.channel.pakeARunCount).toBe(1)
  })

  it.each(['denied', 'aborted'] as const)(
    'preserves the distinct %s wire outcome for lifecycle policy',
    async (code) => {
      const h = makeHarness({ confirmAError: { code } })
      const error = await expectFlowError(h.flow.run(runArgs()), 'peerRejected')
      expect(error.pairErrorCode).toBe(code)
      expect(h.channel.pakeARunCount).toBe(1)
    }
  )
})

describe('§7.3 global backoff accounting', () => {
  it('refuses to open /pair at all while the lockout is active', async () => {
    const h = makeHarness()
    await h.backoff.recordFailure(1_700_000_000_000)
    const error = await expectFlowError(h.flow.run(runArgs()), 'backoffLocked')
    expect(error.retryAtMs).toBe(1_700_000_030_000)
    // Opening the socket would put a dialog on the user's screen, which is
    // exactly what the lockout exists to prevent.
    expect(h.channel.openedUrls).toEqual([])
    expect(h.channel.sentText).toEqual([])
  })

  it('clears prior failures at confirmB even when credential persistence fails later', async () => {
    const h = makeHarness()
    await h.backoff.recordFailure(1_699_000_000_000)
    const originalSet = browser.storage.local.set
    browser.storage.local.set = vi.fn(
      async (items: Record<string, unknown>) => {
        if (CREDENTIALS_KEY in items) {
          throw new Error('simulated credential storage failure')
        }
        await originalSet(items)
      }
    )

    await expectFlowError(h.flow.run(runArgs()), 'internalError')

    // `confirmB` was valid, so this was not another bad-code attempt. The
    // operational failure in §6.7 must not retain the previous lockout count.
    expect(backing[BACKOFF_KEY]).toBeUndefined()
  })

  it('records a failure for a run this flow itself abandoned mid-flight', async () => {
    // The socket dies after `pakeA` — §7.3 names this case so a guesser cannot
    // dodge the counter by hanging up before exhausting a code.
    const h = makeHarness({ silentAfter: 'pairAccept' })
    await h.flow.run(runArgs()).catch(() => undefined)
    expect(backing[BACKOFF_KEY]).toEqual({
      version: 1,
      consecutiveFailures: 1,
      lastFailureAt: 1_700_000_000_000,
    })
  })

  it('records a failure when all three runs fail key confirmation', async () => {
    const h = makeHarness({
      confirmAError: { code: 'codeMismatch', attemptsRemaining: 99 },
    })
    await h.flow.run(runArgs({ code: 'WRONGCOD' })).catch(() => undefined)
    expect(
      (backing[BACKOFF_KEY] as { consecutiveFailures: number })
        .consecutiveFailures
    ).toBe(1)
  })

  it('records nothing for a session that never reached pakeA', async () => {
    // `busy` before any run: the server counts this (its dialog was queued),
    // the client does not. §7.3 states the asymmetry explicitly.
    const h = makeHarness()
    await h.flow
      .run(runArgs({ discovery: { ...DISCOVERY, nonce: undefined } }))
      .catch(() => undefined)
    expect(backing[BACKOFF_KEY]).toBeUndefined()
  })

  it('records nothing when the failure came after mutual confirmation', async () => {
    // §7.3 counts sessions that ended "without mutual confirmation"; this one
    // reached it and then lost the credential phase.
    const h = makeHarness({ silentAfter: 'confirmB' })
    await h.flow.run(runArgs()).catch(() => undefined)
    expect(backing[BACKOFF_KEY]).toBeUndefined()
  })

  it('closes the socket on every failure path', async () => {
    const h = makeHarness({ confirmAError: { code: 'aborted' } })
    await h.flow.run(runArgs()).catch(() => undefined)
    expect(h.channel.closeCount).toBeGreaterThan(0)
  })
})

describe('pairAccept carries no approval semantics', () => {
  it('persists nothing and reports no success when the dialog is never answered', async () => {
    // The dialog was queued (`pairAccept` arrived) and then nothing more came:
    // the user is still reading it, or dismissed it. Either way this is not a
    // pairing, so nothing durable may exist.
    const h = makeHarness({ silentAfter: 'pairAccept' })
    await expect(h.flow.run(runArgs())).rejects.toThrow()
    expect(backing[CREDENTIALS_KEY]).toBeUndefined()
    expect(backing[PINS_KEY]).toBeUndefined()
  })

  it('rejects a pairAccept whose protocolVersion is not 1, as unsupportedVersion', async () => {
    const h = makeHarness({ protocolVersion: 2 })
    await expectFlowError(h.flow.run(runArgs()), 'unsupportedVersion')
    expect(h.channel.pakeARunCount).toBe(0)
  })
})

describe('peer authenticity (§6.5)', () => {
  it('rejects a confirmB that does not verify, without persisting anything', async () => {
    const h = makeHarness({ cB: b64uEncode(new Uint8Array(32).fill(7)) })
    await expectFlowError(h.flow.run(runArgs()), 'peerNotAuthentic')
    // Not a retry: the peer accepted `cA`, so the code was right — a peer that
    // then cannot produce `cB` is not the Motrix holding that code.
    expect(h.channel.pakeARunCount).toBe(1)
    expect(backing[CREDENTIALS_KEY]).toBeUndefined()
    expect(backing[PINS_KEY]).toBeUndefined()
  })

  it('rejects a pB that is not a canonical curve point (§6.3)', async () => {
    const h = makeHarness({ pB: b64uEncode(new Uint8Array(32).fill(0xff)) })
    await expectFlowError(h.flow.run(runArgs()), 'protocolViolation')
  })

  it('aborts when the peer replays pB = w·N, driving K to the identity', async () => {
    // §6.3: abort. §7.2: a failed attempt — so the backoff counter must move,
    // and the outcome must be indistinguishable from a bad `cA`, or it is an
    // oracle for "your `pA` equalled `w·M`", i.e. for `w` itself.
    const w = BigInt(`0x${VMID?.w}`)
    const wN = ED25519_GROUP.mulPoint(ED25519_GROUP.N, w)
    const h = makeHarness({ pB: b64uEncode(wN) })
    await expectFlowError(h.flow.run(runArgs()), 'identityK')
    expect(
      (backing[BACKOFF_KEY] as { consecutiveFailures: number })
        .consecutiveFailures
    ).toBe(1)
  })
})

describe('§9.1 binding keypair invariants', () => {
  it('refuses a ticket with no binding keypair rather than stripping it', async () => {
    const h = makeHarness()
    await expectFlowError(
      h.flow.run(runArgs({ bindingKeypair: undefined })),
      'ticketWithoutBindingKeypair'
    )
    expect(h.channel.openedUrls).toEqual([])
  })

  it('refuses a ticket bound to a different key than this attempt holds', async () => {
    // A real failure mode this guards against: one keypair generated for the
    // bootstrap and a different one reaching the flow. Line A aborts under
    // §9.2 on the mismatch, so every ticketed pairing would silently die.
    const other = ed25519.utils.randomSecretKey()
    const h = makeHarness()
    await expectFlowError(
      h.flow.run(
        runArgs({
          bindingKeypair: { priv: other, pub: ed25519.getPublicKey(other) },
        })
      ),
      'ticketBindingKeyMismatch'
    )
    expect(h.channel.openedUrls).toEqual([])
  })

  it('refuses a ticket it cannot parse into §6.4 digest fields', async () => {
    const h = makeHarness()
    await expectFlowError(
      h.flow.run(runArgs({ nmTicket: { v: 1, purpose: 'mbp1-attestation' } })),
      'malformedTicket'
    )
    expect(h.channel.openedUrls).toEqual([])
  })
})

describe('local validation before any network traffic', () => {
  it('rejects a code that fails §7.1 normalization without consuming an attempt', async () => {
    const h = makeHarness()
    await expectFlowError(h.flow.run(runArgs({ code: 'SHORT' })), 'invalidCode')
    expect(h.channel.pakeARunCount).toBe(0)
    expect(backing[BACKOFF_KEY]).toBeUndefined()
  })

  it('normalizes a display-formatted code rather than rejecting it', async () => {
    const h = makeHarness()
    // `MTX7-K2Q9` is how Motrix displays the vector's code.
    const { credentialId } = await h.flow.run(runArgs({ code: 'mtx7-k2q9' }))
    expect(credentialId).toBe('cred-vector-1')
  })

  it('refuses to open /pair without a §4.2 nonce', async () => {
    const h = makeHarness()
    await expectFlowError(
      h.flow.run(runArgs({ discovery: { ...DISCOVERY, nonce: undefined } })),
      'missingNonce'
    )
    expect(h.channel.openedUrls).toEqual([])
  })

  it('refuses a browser value the wire does not define', async () => {
    const h = makeHarness()
    await expectFlowError(
      h.flow.run(
        runArgs({ principal: { ...PRINCIPAL, browser: 'unknown-browser' } })
      ),
      'unsupportedBrowser'
    )
    expect(h.channel.openedUrls).toEqual([])
  })
})

describe('deps.isCurrent() is threaded through the awaits', () => {
  it('never opens the socket when the attempt is already stale', async () => {
    const h = makeHarness({}, { current: false })
    await expectFlowError(h.flow.run(runArgs()), 'staleAttempt')
    expect(h.channel.openedUrls).toEqual([])
  })

  it('leaves no credential at all when superseded with the offer already in hand', async () => {
    // The window §6.7's "abort cleanly, no partial credential" rule is about:
    // the offer has been read and nothing durable exists yet. Removing every
    // currency check in that window — `receiveSealed`'s two and the one
    // immediately before `writeProvisionalUnacked` — makes this fail, because a
    // superseded attempt then writes a provisional credential for a principal a
    // newer attempt is already pairing.
    const h: FlowHarness = makeHarness({
      afterOfferDelivered: () => h.setCurrent(false),
    })
    await expectFlowError(h.flow.run(runArgs()), 'staleAttempt')
    expect(backing[CREDENTIALS_KEY]).toBeUndefined()
    expect(backing[PINS_KEY]).toBeUndefined()
  })

  it('does not persist a credential when superseded at confirmB', async () => {
    const h: FlowHarness = makeHarness({
      beforeConfirmB: () => h.setCurrent(false),
    })
    await expectFlowError(h.flow.run(runArgs()), 'staleAttempt')
    expect(backing[CREDENTIALS_KEY]).toBeUndefined()
  })

  it('records no §7.3 failure for a stale abort that had already confirmed', async () => {
    const h: FlowHarness = makeHarness({
      afterOfferDelivered: () => h.setCurrent(false),
    })
    await expectFlowError(h.flow.run(runArgs()), 'staleAttempt')
    expect(backing[BACKOFF_KEY]).toBeUndefined()
  })
})

describe('deadlines (§6.5, §7.2)', () => {
  it('budgets the code-bearing phase against the 120 s code lifetime, not 150 s', async () => {
    const h = makeHarness()
    await h.flow.run(runArgs())
    // The first receive after `pairAccept` waits for `pakeB`. Its budget is the
    // §7.2 code lifetime, which is the inner bound; `/pair`'s 150 s pre-auth
    // table deadline is a longer backstop and budgeting against it would blow
    // the real deadline.
    expect(h.channel.textTimeouts[1]).toBe(120_000)
    expect(h.channel.textTimeouts[0]).toBe(SESSION_DEADLINE_MS)
  })

  it('gives up once the session deadline has passed', async () => {
    const h = makeHarness({
      confirmAError: { code: 'codeMismatch', attemptsRemaining: 1 },
    })
    const provider = async (): Promise<string> => {
      // The user takes longer than the code lives.
      h.advance(130_000)
      return CODE
    }
    await expectFlowError(
      h.flow.run(runArgs({ code: provider })),
      'deadlineExceeded'
    )
  })

  // L12: a provider that overruns its own `timeoutMs` — which the flow
  // cannot cancel or otherwise enforce — must not let `pakeA` reach the
  // wire for a code the server has already destroyed. The shipped
  // `pairing-code-source.ts` always honours its deadline; this proves the
  // flow doesn't *rely* on that being true.
  it('never sends pakeA when a non-conforming provider overruns its own timeoutMs', async () => {
    const h = makeHarness()
    const provider = async (): Promise<string> => {
      // Ignores the timeoutMs it was handed entirely — the case a
      // conforming provider (the real one) never produces.
      h.advance(130_000)
      return CODE
    }

    await expectFlowError(
      h.flow.run(runArgs({ code: provider })),
      'deadlineExceeded'
    )

    expect(h.channel.pakeARunCount).toBe(0)
  })
})

/**
 * Runs `body` with every `console` level silenced, then asserts none was called.
 *
 * §11 forbids this module logging at any level, and spying is the only way to
 * assert that from outside: reading the source proves nothing about what a
 * dependency might log on its behalf.
 *
 * The limit, so a pass is not read for more than it carries: this observes the
 * six `console` methods and nothing else. A logger module or a direct
 * `process.stdout.write` would pass. Source inspection is what covers those.
 */
async function expectNoConsoleOutput(body: () => Promise<void>): Promise<void> {
  const spies = (
    ['log', 'info', 'warn', 'error', 'debug', 'trace'] as const
  ).map((level) => vi.spyOn(console, level).mockImplementation(() => undefined))
  try {
    await body()
    for (const spy of spies) expect(spy).not.toHaveBeenCalled()
  } finally {
    for (const spy of spies) spy.mockRestore()
  }
}

describe('§11 logging', () => {
  it('logs nothing at any level during a full successful pairing', async () => {
    await expectNoConsoleOutput(async () => {
      const h = makeHarness()
      await h.flow.run(runArgs())
    })
  })

  it('logs nothing on the failure paths either', async () => {
    await expectNoConsoleOutput(async () => {
      const mismatch = makeHarness({
        confirmAError: { code: 'codeMismatch', attemptsRemaining: 99 },
      })
      await mismatch.flow
        .run(runArgs({ code: 'WRONGCOD' }))
        .catch(() => undefined)
      const bad = makeHarness({ cB: b64uEncode(new Uint8Array(32).fill(7)) })
      await bad.flow.run(runArgs()).catch(() => undefined)
    })
  })

  it('never puts a secret in a thrown message', async () => {
    const h = makeHarness({ cB: b64uEncode(new Uint8Array(32).fill(7)) })
    const error = await expectFlowError(
      h.flow.run(runArgs()),
      'peerNotAuthentic'
    )
    const secrets = [
      CODE,
      VMID?.w ?? '',
      VIN?.x ?? '',
      VOUT.K ?? '',
      VOUT.Ke ?? '',
      VOUT.Ka ?? '',
      VOUT.KcA ?? '',
      VOUT.KcB ?? '',
      VOUT.cA ?? '',
      VOUT.cB ?? '',
      VOUT.trafficC2S ?? '',
      VOUT.trafficS2C ?? '',
      VIN?.bindingSeed ?? '',
      VECTOR_CA,
      VECTOR_CB,
    ]
    const haystack = `${error.message}${error.stack ?? ''}`
    for (const secret of secrets) {
      expect(haystack).not.toContain(secret)
    }
  })
})
