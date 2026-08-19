import { Buffer } from 'node:buffer'
import { randomBytes } from 'node:crypto'
import { ed25519 } from '@noble/curves/ed25519.js'
import { utf8ToBytes } from '@noble/hashes/utils.js'
import type { Browser } from '@shared/protocol/bridge'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { CredentialPrincipal, IdentityTriState } from '../credential-store'
import { hexToBytes, loadMbp1Vectors } from './__tests__/vectors'
import {
  concatBytes,
  fromBase64Url,
  hmacSha256,
  toBase64Url,
} from './canonical'
import { DIR_C2S, DIR_S2C, EnvelopeOpener, EnvelopeSealer } from './envelope'
import type { PairErrorFrame } from './frames'
import type { PairSessionDeps } from './pair-session'
import { PairSession } from './pair-session'
import { normalizePairingCode } from './pairing-code'
import { deriveW } from './scrypt-w'
import {
  buildTT,
  computePublicA,
  confirmationMacs,
  drawScalar,
  EDWARDS25519_GROUP,
  keySchedule,
  pairTrafficKeys,
  sharedFromA,
} from './spake2-core'
import {
  deriveTicketKey,
  TicketReplayCache,
  ticketMacInput,
} from './ticket-verify'
import { buildAad, buildAId, buildBId, ticketDigest } from './transcript'

const vectors = loadMbp1Vectors()
const bindingSeed = hexToBytes(vectors.spake2[0].inputs.bindingSeed as string)

const PROOF_LABEL = utf8ToBytes('MBP1/ticket-proof/v1')

const INSTANCE_ID = '0d9c2b7a-4e6f-4a1b-8c3d-2e5f7a9b1c4d'
const SERVER_GENERATION = '3c2b1a09-8f7e-4d6c-b5a4-93827160f0e1'
const LOCAL_TOKEN = 'vector-local-token-0123456789abcdef'
const EXTENSION_ID = 'ibpkjhgpbidfmbmomagmldcdlpbmchgi'
const ORIGIN = `chrome-extension://${EXTENSION_ID}`
const INSTALLATION_ID = '5f0b6f9e-8a3d-4c5e-9b2a-7d1e4f6a8c0b'
const PAIR_NONCE = 'vec-nonce-8f3a1c5e7b2d4a90'
const T0 = 1_755_600_000_000

// ---------------------------------------------------------------------------
// Test harness
// ---------------------------------------------------------------------------

interface DialogArgs {
  browser: Browser
  claimedExtensionId: string
  identity: IdentityTriState
  code: string
  pairingNonce: string
}

interface Deferred<T> {
  promise: Promise<T>
  resolve: (value: T) => void
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((r) => {
    resolve = r
  })
  return { promise, resolve }
}

interface HarnessOptions {
  browser?: Browser
  verifiedOrigin?: string
  official?: boolean
  admit?: () => { ok: true } | { ok: false; code: 'busy' | 'rateLimited' }
  /** When set, `offerProvisional` resolves only once the test resolves this. */
  gateOffer?: Deferred<void>
  /** When set, `commitFromPair` resolves only once the test resolves this. */
  gateCommit?: Deferred<void>
  nonceValid?: boolean
  now?: () => number
  random?: (n: number) => Uint8Array
  offerProvisional?: () => Promise<{
    credentialId: string
    mutualKeyB64: string
  }>
}

function makeHarness(opts: HarnessOptions = {}) {
  const sent: Record<string, unknown>[] = []
  const binary: Uint8Array[] = []
  const closed: string[] = []
  const dialogs: DialogArgs[] = []
  const order: string[] = []
  const dismissals: Deferred<void>[] = []
  const dialogClosed: number[] = []
  const released: string[] = []
  let authenticated: { sealer: EnvelopeSealer; opener: EnvelopeOpener } | null =
    null

  const replay = new TicketReplayCache()
  const replayAdd = vi.spyOn(replay, 'add').mockImplementation(function (
    this: TicketReplayCache,
    macB64: string,
    expMs: number
  ) {
    order.push('replay.add')
    return TicketReplayCache.prototype.add.call(this, macB64, expMs)
  })

  const offerProvisional = vi.fn(
    async (
      _principal: CredentialPrincipal,
      _identity: IdentityTriState
    ): Promise<{ credentialId: string; mutualKeyB64: string }> => {
      order.push('offerProvisional:start')
      // Always yields before reporting completion, for the same reason
      // `commitFromPair` does: otherwise §6.7's ordering assertions would hold
      // even for a caller that never awaited the durable write.
      await (opts.gateOffer ? opts.gateOffer.promise : Promise.resolve())
      if (opts.offerProvisional) {
        return await opts.offerProvisional()
      }
      order.push('offerProvisional:resolved')
      return {
        credentialId: 'cred-1111-2222-3333',
        mutualKeyB64: toBase64Url(new Uint8Array(32).fill(7)),
      }
    }
  )
  const commitFromPair = vi.fn(async (_credentialId: string): Promise<void> => {
    order.push('commitFromPair:start')
    // Always yield before reporting completion: a fake that logs its result
    // synchronously would report the same order whether or not the caller
    // awaited it, and the §6.7 ordering assertions would be vacuous.
    await (opts.gateCommit ? opts.gateCommit.promise : Promise.resolve())
    order.push('commitFromPair:resolved')
  })

  const deps: PairSessionDeps = {
    nonceValid: opts.nonceValid ?? true,
    pairNonce: PAIR_NONCE,
    verifiedOrigin: opts.verifiedOrigin ?? ORIGIN,
    instanceId: INSTANCE_ID,
    serverGeneration: SERVER_GENERATION,
    localToken: LOCAL_TOKEN,
    isOfficialId: vi.fn(() => opts.official ?? true),
    credentials: { offerProvisional, commitFromPair },
    replay,
    admit: vi.fn(() => {
      order.push('admit')
      return opts.admit ? opts.admit() : { ok: true as const }
    }),
    release: vi.fn((origin: string) => {
      order.push('release')
      released.push(origin)
    }),
    queueDialog: vi.fn((args: DialogArgs) => {
      order.push('queueDialog')
      dialogs.push(args)
      const d = deferred<void>()
      dismissals.push(d)
      const index = dismissals.length - 1
      return {
        dismissed: d.promise,
        close: () => {
          dialogClosed.push(index)
        },
      }
    }),
    sendText: (json: object) => {
      order.push('sendText')
      sent.push(json as Record<string, unknown>)
    },
    sendBinary: (frame: Uint8Array) => {
      order.push('sendBinary')
      binary.push(frame)
    },
    close: (reason: string) => {
      closed.push(reason)
    },
    onAuthenticated: (channel) => {
      order.push('onAuthenticated')
      authenticated = channel
    },
    now: opts.now ?? (() => T0),
    random: opts.random ?? ((n: number) => new Uint8Array(randomBytes(n))),
  }

  const session = new PairSession(deps)

  return {
    session,
    deps,
    sent,
    binary,
    closed,
    dialogs,
    order,
    dismissals,
    dialogClosed,
    released,
    replayAdd,
    offerProvisional,
    commitFromPair,
    get authenticated() {
      return authenticated
    },
    text(frame: object): Promise<void> {
      const raw = JSON.stringify(frame)
      return session.handleText(raw, Buffer.byteLength(raw))
    },
    raw(raw: string, byteLength?: number): Promise<void> {
      return session.handleText(raw, byteLength ?? Buffer.byteLength(raw))
    },
    lastSent(): Record<string, unknown> {
      const frame = sent.at(-1)
      if (!frame) throw new Error('no frame sent')
      return frame
    },
    error(): PairErrorFrame {
      return this.lastSent() as unknown as PairErrorFrame
    },
  }
}

type Harness = ReturnType<typeof makeHarness>

// ---------------------------------------------------------------------------
// Scripted client double — the extension (A) side, built from the same
// crypto modules, so a passing handshake proves the two roles interoperate
// rather than proving the server agrees with itself.
// ---------------------------------------------------------------------------

interface TicketMaterial {
  wire: Record<string, unknown>
  bindingKeyB64: string
  digest: Uint8Array
  seed: Uint8Array
}

function mintTicket(
  over: Partial<{
    v: number
    purpose: string
    protocolVersion: number
    serverGeneration: string
    browser: string
    callerId: string
    exp: number
    bindingPub: Uint8Array
    mac: Uint8Array
  }> = {},
  nowMs = T0
): TicketMaterial {
  const bindingPub = over.bindingPub ?? ed25519.getPublicKey(bindingSeed)
  const fields = {
    v: over.v ?? 1,
    purpose: over.purpose ?? 'mbp1-attestation',
    protocolVersion: over.protocolVersion ?? 1,
    serverGeneration: over.serverGeneration ?? SERVER_GENERATION,
    browser: over.browser ?? 'chromium',
    callerId: over.callerId ?? EXTENSION_ID,
    exp: over.exp ?? Math.floor(nowMs / 1000) + 30,
    bindingPub,
  }
  const mac =
    over.mac ?? hmacSha256(deriveTicketKey(LOCAL_TOKEN), ticketMacInput(fields))
  const wire = {
    ...fields,
    bindingPub: toBase64Url(bindingPub),
    mac: toBase64Url(mac),
  }
  return {
    wire,
    bindingKeyB64: toBase64Url(bindingPub),
    digest: ticketDigest({ ...fields, mac }),
    seed: bindingSeed,
  }
}

interface ClientOptions {
  code: string
  browser?: Browser
  verifiedOrigin?: string
  claimedExtensionId?: string
  ticket?: TicketMaterial | null
}

/** The extension side of §6.2–§6.7, assembled from the shipped mbp1 modules. */
class ClientDouble {
  private readonly w: bigint
  private x = 0n
  private pA: Uint8Array = new Uint8Array()
  private tt: Uint8Array = new Uint8Array()
  private keys: ReturnType<typeof keySchedule> | null = null
  readonly browser: Browser
  readonly verifiedOrigin: string
  readonly claimedExtensionId: string
  readonly ticket: TicketMaterial | null

  constructor(opts: ClientOptions) {
    const normalized = normalizePairingCode(opts.code)
    if (!normalized) throw new Error('client got an unusable code')
    this.browser = opts.browser ?? 'chromium'
    this.verifiedOrigin = opts.verifiedOrigin ?? ORIGIN
    this.claimedExtensionId = opts.claimedExtensionId ?? EXTENSION_ID
    this.ticket = opts.ticket ?? null
    this.w = deriveW(normalized, PAIR_NONCE, EDWARDS25519_GROUP.order)
  }

  pakeA(): object {
    this.x = drawScalar(
      EDWARDS25519_GROUP.order,
      (n) => new Uint8Array(randomBytes(n))
    )
    this.pA = computePublicA(EDWARDS25519_GROUP, this.w, this.x)
    return { type: 'pakeA', pA: toBase64Url(this.pA) }
  }

  confirmA(pakeB: Record<string, unknown>): object {
    const pB = fromBase64Url(pakeB.pB as string)
    const K = sharedFromA(EDWARDS25519_GROUP, this.w, this.x, pB)
    const aId = buildAId({
      browser: this.browser,
      verifiedOrigin: this.verifiedOrigin,
      claimedExtensionId: this.claimedExtensionId,
      clientInstallationId: INSTALLATION_ID,
    })
    this.tt = buildTT(aId, buildBId(INSTANCE_ID), this.pA, pB, K, this.w)
    const aad = buildAad(
      1,
      PAIR_NONCE,
      this.ticket ? fromBase64Url(this.ticket.bindingKeyB64) : null,
      this.ticket ? this.ticket.digest : null
    )
    this.keys = keySchedule(this.tt, aad)
    const { cA } = confirmationMacs(this.keys.KcA, this.keys.KcB, this.tt)

    const frame: Record<string, unknown> = {
      type: 'confirmA',
      cA: toBase64Url(cA),
    }
    if (this.ticket) {
      frame.ticketProof = toBase64Url(
        ed25519.sign(concatBytes(PROOF_LABEL, this.tt), this.ticket.seed)
      )
    }
    return frame
  }

  verifyConfirmB(confirmB: Record<string, unknown>): boolean {
    if (!this.keys) throw new Error('no key schedule yet')
    const { cB } = confirmationMacs(this.keys.KcA, this.keys.KcB, this.tt)
    return toBase64Url(cB) === confirmB.cB
  }

  /** Client-side envelope endpoints: it seals c2s and opens s2c (§6.6, §10). */
  channel(): { sealer: EnvelopeSealer; opener: EnvelopeOpener } {
    if (!this.keys) throw new Error('no key schedule yet')
    const { kC2S, kS2C } = pairTrafficKeys(this.keys.Ke)
    return {
      sealer: new EnvelopeSealer(kC2S, DIR_C2S),
      opener: new EnvelopeOpener(kS2C, DIR_S2C),
    }
  }

  hello(): object {
    const frame: Record<string, unknown> = {
      type: 'pairHello',
      protocolVersion: 1,
      browser: this.browser,
      claimedExtensionId: this.claimedExtensionId,
      clientInstallationId: INSTALLATION_ID,
    }
    if (this.ticket) {
      frame.nmTicket = this.ticket.wire
      frame.ticketBindingKey = this.ticket.bindingKeyB64
    }
    return frame
  }
}

function helloFrame(over: Record<string, unknown> = {}): object {
  return {
    type: 'pairHello',
    protocolVersion: 1,
    browser: 'chromium',
    claimedExtensionId: EXTENSION_ID,
    clientInstallationId: INSTALLATION_ID,
    ...over,
  }
}

/** Drives pairHello → pairAccept and returns the code the dialog was given. */
async function openSession(
  h: Harness,
  hello: object = helloFrame()
): Promise<string> {
  await h.text(hello)
  const args = h.dialogs.at(-1)
  if (!args) throw new Error('no dialog queued')
  return args.code
}

/** Drives one full successful run from pakeA through confirmB. */
async function runHandshake(h: Harness, client: ClientDouble): Promise<void> {
  await h.text(client.pakeA())
  const pakeB = h.lastSent()
  expect(pakeB.type).toBe('pakeB')
  await h.text(client.confirmA(pakeB))
}

// ---------------------------------------------------------------------------

describe('PairSession', () => {
  describe('scenario 1: happy path without a ticket', () => {
    let h: Harness
    let client: ClientDouble

    beforeEach(async () => {
      h = makeHarness()
      const code = await openSession(h)
      client = new ClientDouble({ code })
    })

    it('sends pairAccept carrying the instanceId as soon as the dialog is queued', () => {
      expect(h.sent).toEqual([
        { type: 'pairAccept', protocolVersion: 1, instanceId: INSTANCE_ID },
      ])
      expect(h.dialogs).toHaveLength(1)
    })

    it('shows the dialog the §7.1 grouped display form of the code', () => {
      expect(h.dialogs[0].code).toMatch(
        /^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/
      )
      expect(h.dialogs[0].pairingNonce).toBe(PAIR_NONCE)
      expect(h.dialogs[0].identity).toBe('official')
    })

    it('completes key confirmation and activates the AEAD channel', async () => {
      await runHandshake(h, client)
      const confirmB = h.lastSent()
      expect(confirmB.type).toBe('confirmB')
      expect(client.verifyConfirmB(confirmB)).toBe(true)
      expect(h.closed).toEqual([])
    })

    it('issues, acks, and commits the credential inside the envelope', async () => {
      await runHandshake(h, client)
      const channel = client.channel()

      expect(h.binary).toHaveLength(1)
      const offer = JSON.parse(
        Buffer.from(channel.opener.open(h.binary[0])).toString('utf-8')
      )
      expect(offer).toEqual({
        type: 'credentialOffer',
        credentialId: 'cred-1111-2222-3333',
        mutualKey: toBase64Url(new Uint8Array(32).fill(7)),
      })

      await h.session.handleBinary(
        channel.sealer.seal(
          utf8ToBytes(
            JSON.stringify({
              type: 'credentialAck',
              credentialId: offer.credentialId,
            })
          )
        )
      )

      expect(h.commitFromPair).toHaveBeenCalledWith('cred-1111-2222-3333')
      expect(h.binary).toHaveLength(2)
      const committed = JSON.parse(
        Buffer.from(channel.opener.open(h.binary[1])).toString('utf-8')
      )
      expect(committed).toEqual({ type: 'credentialCommitted' })
    })

    it('hands the live envelope endpoints to the wiring after committing', async () => {
      await runHandshake(h, client)
      const channel = client.channel()
      const offer = JSON.parse(
        Buffer.from(channel.opener.open(h.binary[0])).toString('utf-8')
      )
      await h.session.handleBinary(
        channel.sealer.seal(
          utf8ToBytes(
            JSON.stringify({
              type: 'credentialAck',
              credentialId: offer.credentialId,
            })
          )
        )
      )

      expect(h.authenticated).not.toBeNull()
      expect(h.order.indexOf('onAuthenticated')).toBeGreaterThan(
        h.order.lastIndexOf('sendBinary')
      )
    })

    it('offers the credential to the caller as the store principal and identity', async () => {
      await runHandshake(h, client)
      expect(h.offerProvisional).toHaveBeenCalledWith(
        {
          browser: 'chromium',
          verifiedOrigin: ORIGIN,
          clientInstallationId: INSTALLATION_ID,
        },
        'official'
      )
    })
  })

  describe('scenario 1b: §6.7 issuance ordering', () => {
    it('emits credentialOffer only after offerProvisional has resolved', async () => {
      const gateOffer = deferred<void>()
      const h = makeHarness({ gateOffer })
      const code = await openSession(h)
      const client = new ClientDouble({ code })

      await h.text(client.pakeA())
      const pending = h.text(client.confirmA(h.lastSent()))
      await Promise.resolve()
      await Promise.resolve()

      // confirmB is out (the channel is active), but nothing durable has
      // resolved yet, so no offer may exist on the wire.
      expect(h.lastSent().type).toBe('confirmB')
      expect(h.order).toContain('offerProvisional:start')
      expect(h.order).not.toContain('offerProvisional:resolved')
      expect(h.binary).toHaveLength(0)

      gateOffer.resolve()
      await pending

      expect(h.binary).toHaveLength(1)
      expect(h.order.indexOf('offerProvisional:resolved')).toBeLessThan(
        h.order.lastIndexOf('sendBinary')
      )
    })

    it('sends credentialCommitted only after the durable commit resolved', async () => {
      const gateCommit = deferred<void>()
      const h = makeHarness({ gateCommit })
      const code = await openSession(h)
      const client = new ClientDouble({ code })
      await runHandshake(h, client)
      const channel = client.channel()
      channel.opener.open(h.binary[0])

      const pending = h.session.handleBinary(
        channel.sealer.seal(
          utf8ToBytes(
            JSON.stringify({
              type: 'credentialAck',
              credentialId: 'cred-1111-2222-3333',
            })
          )
        )
      )
      await Promise.resolve()
      await Promise.resolve()

      // The commit is in flight; only the offer may be on the wire so far.
      expect(h.order).toContain('commitFromPair:start')
      expect(h.order).not.toContain('commitFromPair:resolved')
      expect(h.binary).toHaveLength(1)
      expect(h.authenticated).toBeNull()

      gateCommit.resolve()
      await pending

      expect(h.binary).toHaveLength(2)
      expect(h.order.indexOf('commitFromPair:resolved')).toBeLessThan(
        h.order.lastIndexOf('sendBinary')
      )
      expect(h.authenticated).not.toBeNull()
    })
  })

  describe('scenario 2: happy path with an NM attestation ticket', () => {
    it('resolves official through the allowlist and accepts the ticketProof', async () => {
      const h = makeHarness({ official: true })
      const ticket = mintTicket()
      const client0 = new ClientDouble({ code: '00000000', ticket })
      const code = await openSession(h, client0.hello())
      const client = new ClientDouble({ code, ticket })

      expect(h.dialogs[0].identity).toBe('official')
      expect(h.deps.isOfficialId).toHaveBeenCalledWith('chromium', EXTENSION_ID)

      await runHandshake(h, client)
      expect(h.lastSent().type).toBe('confirmB')
      expect(client.verifyConfirmB(h.lastSent())).toBe(true)
    })

    it('resolves attested-non-official when the proven id is not allowlisted', async () => {
      const h = makeHarness({ official: false })
      const ticket = mintTicket()
      const client0 = new ClientDouble({ code: '00000000', ticket })
      await openSession(h, client0.hello())
      expect(h.dialogs[0].identity).toBe('attested-non-official')
    })

    it('downgrades an unknown-generation ticket to unverified', async () => {
      const h = makeHarness({ official: true })
      const ticket = mintTicket({ serverGeneration: 'some-older-generation' })
      const client0 = new ClientDouble({ code: '00000000', ticket })
      await openSession(h, client0.hello())
      expect(h.dialogs[0].identity).toBe('unverified')
    })

    it('rejects a confirmA whose ticketProof does not verify as a failed attempt', async () => {
      const h = makeHarness()
      const ticket = mintTicket()
      const client0 = new ClientDouble({ code: '00000000', ticket })
      const code = await openSession(h, client0.hello())
      const client = new ClientDouble({ code, ticket })

      await h.text(client.pakeA())
      const confirm = client.confirmA(h.lastSent()) as Record<string, unknown>
      // A syntactically valid 64-byte signature that is not the right one.
      confirm.ticketProof = toBase64Url(
        ed25519.sign(utf8ToBytes('some other message'), bindingSeed)
      )
      await h.text(confirm)

      expect(h.error()).toEqual({
        type: 'pairError',
        code: 'codeMismatch',
        attemptsRemaining: 2,
      })
    })

    it('treats a missing ticketProof as a protocol violation, not a wrong code', async () => {
      const h = makeHarness()
      const ticket = mintTicket()
      const client0 = new ClientDouble({ code: '00000000', ticket })
      const code = await openSession(h, client0.hello())
      const client = new ClientDouble({ code, ticket })

      await h.text(client.pakeA())
      const confirm = client.confirmA(h.lastSent()) as Record<string, unknown>
      delete confirm.ticketProof
      await h.text(confirm)

      expect(h.error().code).toBe('protocolViolation')
      expect(h.closed).toHaveLength(1)
    })

    it('treats a ticketProof sent without a ticket as a protocol violation', async () => {
      const h = makeHarness()
      const code = await openSession(h)
      const client = new ClientDouble({ code })

      await h.text(client.pakeA())
      const confirm = client.confirmA(h.lastSent()) as Record<string, unknown>
      confirm.ticketProof = toBase64Url(
        ed25519.sign(utf8ToBytes('unexpected'), bindingSeed)
      )
      await h.text(confirm)

      expect(h.error().code).toBe('protocolViolation')
    })
  })

  describe('scenario 2b: ticket aborts (§9.2)', () => {
    it('aborts with protocolViolation and never reveals the abort reason', async () => {
      const h = makeHarness()
      const ticket = mintTicket({ mac: new Uint8Array(32).fill(9) })
      await h.text(
        helloFrame({
          nmTicket: ticket.wire,
          ticketBindingKey: ticket.bindingKeyB64,
        })
      )

      expect(h.error()).toEqual({
        type: 'pairError',
        code: 'protocolViolation',
      })
      expect(h.dialogs).toHaveLength(0)
      expect(h.closed).toHaveLength(1)
    })

    it('lets a structural abort take precedence over an official identity', async () => {
      const h = makeHarness({ official: true })
      // Same allowlisted caller and verified origin that would otherwise
      // resolve `official`, but the ticket's binding key does not match the
      // one presented in pairHello (§9.2 bindingKeyMismatch).
      const ticket = mintTicket()
      const otherKey = ed25519.getPublicKey(new Uint8Array(32).fill(3))
      await h.text(
        helloFrame({
          nmTicket: ticket.wire,
          ticketBindingKey: toBase64Url(otherKey),
        })
      )

      expect(h.error().code).toBe('protocolViolation')
      expect(h.dialogs).toHaveLength(0)
    })

    it('rejects a ticket presented without its binding key at the schema', async () => {
      const h = makeHarness()
      const ticket = mintTicket()
      await h.text(helloFrame({ nmTicket: ticket.wire }))
      expect(h.error().code).toBe('protocolViolation')
    })

    it('rejects a binding key presented without a ticket at the schema', async () => {
      const h = makeHarness()
      const ticket = mintTicket()
      await h.text(helloFrame({ ticketBindingKey: ticket.bindingKeyB64 }))
      expect(h.error().code).toBe('protocolViolation')
    })
  })

  describe('scenario 3: wrong code and attempt exhaustion (§7.2)', () => {
    it('reports codeMismatch with the remaining attempts and keeps the socket open', async () => {
      const h = makeHarness()
      await openSession(h)
      const wrong = new ClientDouble({ code: 'ZZZZZZZZ' })

      await h.text(wrong.pakeA())
      await h.text(wrong.confirmA(h.lastSent()))

      expect(h.error()).toEqual({
        type: 'pairError',
        code: 'codeMismatch',
        attemptsRemaining: 2,
      })
      expect(h.closed).toEqual([])
      expect(h.session.attemptCount).toBe(1)
    })

    it('lets a fresh run start on the same socket after a failure', async () => {
      const h = makeHarness()
      const code = await openSession(h)
      const wrong = new ClientDouble({ code: 'ZZZZZZZZ' })
      await h.text(wrong.pakeA())
      await h.text(wrong.confirmA(h.lastSent()))

      const right = new ClientDouble({ code })
      await h.text(right.pakeA())
      expect(h.lastSent().type).toBe('pakeB')
      await h.text(right.confirmA(h.lastSent()))

      expect(h.lastSent().type).toBe('confirmB')
      expect(right.verifyConfirmB(h.lastSent())).toBe(true)
      expect(h.session.attemptCount).toBe(2)
    })

    it('rate-limits, closes, and invalidates the code on the third failure', async () => {
      const h = makeHarness()
      const code = await openSession(h)
      const wrong = new ClientDouble({ code: 'ZZZZZZZZ' })

      for (const expected of [2, 1]) {
        await h.text(wrong.pakeA())
        await h.text(wrong.confirmA(h.lastSent()))
        expect(h.error()).toEqual({
          type: 'pairError',
          code: 'codeMismatch',
          attemptsRemaining: expected,
        })
      }

      await h.text(wrong.pakeA())
      await h.text(wrong.confirmA(h.lastSent()))

      expect(h.error()).toEqual({ type: 'pairError', code: 'rateLimited' })
      expect(h.closed).toHaveLength(1)
      expect(h.session.attemptCount).toBe(3)
      expect(h.dialogClosed).toEqual([0])

      // The code is dead: even the right one cannot start another run.
      const right = new ClientDouble({ code })
      const before = h.sent.length
      await h.text(right.pakeA())
      expect(h.sent).toHaveLength(before)
    })

    it('treats an identity K exactly like a wrong code, revealing nothing extra', async () => {
      const h = makeHarness()
      const code = await openSession(h)
      const normalized = normalizePairingCode(code)
      if (!normalized) throw new Error('unusable code')
      const w = deriveW(normalized, PAIR_NONCE, EDWARDS25519_GROUP.order)
      // pA = w·M makes pA − w·M the identity, so K is the identity (§6.3).
      const pA = EDWARDS25519_GROUP.encodePoint(
        EDWARDS25519_GROUP.M.multiply(w)
      )

      await h.text({ type: 'pakeA', pA: toBase64Url(pA) })

      expect(h.error()).toEqual({
        type: 'pairError',
        code: 'codeMismatch',
        attemptsRemaining: 2,
      })
      expect(h.session.attemptCount).toBe(1)
    })
  })

  describe('scenario 4: frame discipline (§6.1)', () => {
    it('aborts on an unknown frame type', async () => {
      const h = makeHarness()
      await h.text({ type: 'somethingElse' })
      expect(h.error().code).toBe('protocolViolation')
      expect(h.closed).toHaveLength(1)
    })

    it('aborts on a duplicate pakeA mid-run', async () => {
      const h = makeHarness()
      const code = await openSession(h)
      const client = new ClientDouble({ code })
      await h.text(client.pakeA())
      await h.text(client.pakeA())

      expect(h.error().code).toBe('protocolViolation')
      expect(h.closed).toHaveLength(1)
    })

    it('aborts on a duplicate pairHello', async () => {
      const h = makeHarness()
      await openSession(h)
      await h.text(helloFrame())
      expect(h.error().code).toBe('protocolViolation')
    })

    it('aborts on an out-of-order confirmA before pakeA', async () => {
      const h = makeHarness()
      await openSession(h)
      await h.text({ type: 'confirmA', cA: toBase64Url(new Uint8Array(32)) })
      expect(h.error().code).toBe('protocolViolation')
    })

    it('aborts on a pre-auth text frame larger than 16 KiB using the byte length', async () => {
      const h = makeHarness()
      const raw = JSON.stringify(helloFrame())
      await h.raw(raw, 16 * 1024 + 1)
      expect(h.error().code).toBe('protocolViolation')
      expect(h.dialogs).toHaveLength(0)
    })

    it('aborts on schema-invalid JSON and on non-JSON text', async () => {
      const h = makeHarness()
      await h.raw('{not json')
      expect(h.error().code).toBe('protocolViolation')

      const h2 = makeHarness()
      await h2.raw('[]')
      expect(h2.error().code).toBe('protocolViolation')
    })

    it('aborts on a malformed base64url point', async () => {
      const h = makeHarness()
      await openSession(h)
      await h.text({ type: 'pakeA', pA: '!!!!not-base64url!!!!' })
      expect(h.error().code).toBe('protocolViolation')
      expect(h.closed).toHaveLength(1)
    })

    it('aborts on a well-formed but non-canonical curve point, consuming the attempt', async () => {
      const h = makeHarness()
      await openSession(h)
      // y = p: a canonical-length encoding that is not a canonical point (§6.3).
      const nonCanonical = Buffer.from(
        'edffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f',
        'hex'
      )
      await h.text({
        type: 'pakeA',
        pA: toBase64Url(new Uint8Array(nonCanonical)),
      })

      expect(h.error().code).toBe('protocolViolation')
      expect(h.session.attemptCount).toBe(1)
    })

    it('treats a text frame after channel activation as a violation (§10)', async () => {
      const h = makeHarness()
      const code = await openSession(h)
      const client = new ClientDouble({ code })
      await runHandshake(h, client)

      await h.text({ type: 'pakeA', pA: toBase64Url(new Uint8Array(32)) })
      expect(h.closed).toHaveLength(1)
    })

    it('closes without a plaintext pairError when an envelope frame fails to open', async () => {
      const h = makeHarness()
      const code = await openSession(h)
      const client = new ClientDouble({ code })
      await runHandshake(h, client)
      const before = h.sent.length

      await h.session.handleBinary(new Uint8Array(64))

      expect(h.sent).toHaveLength(before)
      expect(h.closed).toHaveLength(1)
    })
  })

  describe('scenario 5: attempt accounting survives disconnection (§7.2)', () => {
    it('keeps a consumed attempt after the socket closes mid-run', async () => {
      const h = makeHarness()
      const code = await openSession(h)
      const client = new ClientDouble({ code })

      await h.text(client.pakeA())
      expect(h.session.attemptCount).toBe(1)

      h.session.dispose('socket-closed')
      expect(h.session.attemptCount).toBe(1)
      expect(h.dialogClosed).toEqual([0])
    })

    it('does not consume an attempt for a session that never reached pakeA', async () => {
      const h = makeHarness()
      await openSession(h)
      h.session.dispose('socket-closed')
      expect(h.session.attemptCount).toBe(0)
    })
  })

  describe('scenario 6: pairAccept carries no approval semantics', () => {
    it('sends pairAccept with the dialog still pending and no user action taken', async () => {
      const h = makeHarness()
      await h.text(helloFrame())

      expect(h.sent).toEqual([
        { type: 'pairAccept', protocolVersion: 1, instanceId: INSTANCE_ID },
      ])
      expect(h.dialogClosed).toEqual([])
      expect(h.order.indexOf('queueDialog')).toBeLessThan(
        h.order.indexOf('sendText')
      )
    })
  })

  describe('scenario 7: 120 s code lifetime (§7.2)', () => {
    it('expires the code 120 s after the dialog was queued', async () => {
      let now = T0
      const h = makeHarness({ now: () => now })
      const code = await openSession(h)
      const client = new ClientDouble({ code })

      await h.text(client.pakeA())
      now = T0 + 120_001
      await h.text(client.confirmA(h.lastSent()))

      expect(h.error()).toEqual({ type: 'pairError', code: 'expired' })
      expect(h.closed).toHaveLength(1)
      expect(h.dialogClosed).toEqual([0])
    })

    it('still accepts a run that starts inside the window', async () => {
      let now = T0
      const h = makeHarness({ now: () => now })
      const code = await openSession(h)
      const client = new ClientDouble({ code })

      now = T0 + 119_000
      await runHandshake(h, client)
      expect(h.lastSent().type).toBe('confirmB')
    })

    it('rejects a pakeA that arrives after expiry', async () => {
      let now = T0
      const h = makeHarness({ now: () => now })
      const code = await openSession(h)
      const client = new ClientDouble({ code })

      now = T0 + 200_000
      await h.text(client.pakeA())

      expect(h.error()).toEqual({ type: 'pairError', code: 'expired' })
      expect(h.session.attemptCount).toBe(0)
    })
  })

  describe('scenario 8: dialog dismissal', () => {
    it('aborts and closes when the user dismisses the dialog', async () => {
      const h = makeHarness()
      await openSession(h)

      h.dismissals[0].resolve()
      await Promise.resolve()
      await Promise.resolve()

      expect(h.error()).toEqual({ type: 'pairError', code: 'aborted' })
      expect(h.closed).toHaveLength(1)
    })

    it('ignores a dismissal that arrives after the pairing already succeeded', async () => {
      const h = makeHarness()
      const code = await openSession(h)
      const client = new ClientDouble({ code })
      await runHandshake(h, client)

      const before = h.sent.length
      h.dismissals[0].resolve()
      await Promise.resolve()
      await Promise.resolve()

      expect(h.sent).toHaveLength(before)
      expect(h.closed).toEqual([])
    })
  })

  describe('§7.3 admission ordering', () => {
    it('runs admission before any session mutation, ticket work, or dialog', async () => {
      const h = makeHarness({ admit: () => ({ ok: false, code: 'busy' }) })
      const ticket = mintTicket()

      await h.text(
        helloFrame({
          nmTicket: ticket.wire,
          ticketBindingKey: ticket.bindingKeyB64,
        })
      )

      expect(h.error()).toEqual({ type: 'pairError', code: 'busy' })
      expect(h.closed).toHaveLength(1)
      expect(h.dialogs).toHaveLength(0)
      expect(h.replayAdd).not.toHaveBeenCalled()
      expect(h.order[0]).toBe('admit')
    })

    it('frees the pending slot at key confirmation, and never twice', async () => {
      const h = makeHarness()
      const code = await openSession(h)
      const client = new ClientDouble({ code })
      expect(h.released).toEqual([])

      await runHandshake(h, client)

      // Released at confirmation, not at socket close: a paired connection
      // lives for hours, and three of them would otherwise block every dialog.
      expect(h.released).toEqual([ORIGIN])

      h.session.dispose('socket-closed')
      expect(h.released).toEqual([ORIGIN])
    })

    it('frees the pending slot when the session ends without pairing', async () => {
      for (const end of [
        async (h: Harness) => {
          h.dismissals[0].resolve()
          await Promise.resolve()
          await Promise.resolve()
        },
        async (h: Harness) => {
          await h.text({ type: 'somethingElse' })
        },
        async (h: Harness) => {
          h.session.dispose('socket-closed')
        },
        async (h: Harness) => {
          h.session.dispose('timeout')
        },
      ]) {
        const h = makeHarness()
        await openSession(h)
        await end(h)
        expect(h.released).toEqual([ORIGIN])
      }
    })

    it('never frees a slot it did not take', async () => {
      // The slot this admission was refused against belongs to another live
      // session; releasing it here would hand that session's slot away.
      for (const code of ['busy', 'rateLimited'] as const) {
        const h = makeHarness({ admit: () => ({ ok: false, code }) })
        await h.text(helloFrame())
        h.session.dispose('socket-closed')
        expect(h.released).toEqual([])
      }

      // A session that never got as far as pairHello holds no slot either.
      const never = makeHarness()
      never.session.dispose('socket-closed')
      expect(never.released).toEqual([])
    })

    it('surfaces a rateLimited admission verdict verbatim', async () => {
      const h = makeHarness({
        admit: () => ({ ok: false, code: 'rateLimited' }),
      })
      await h.text(helloFrame())
      expect(h.error()).toEqual({ type: 'pairError', code: 'rateLimited' })
    })

    it('admits before touching the ticket replay cache on the accepted path', async () => {
      const h = makeHarness()
      const ticket = mintTicket()
      await h.text(
        helloFrame({
          nmTicket: ticket.wire,
          ticketBindingKey: ticket.bindingKeyB64,
        })
      )
      expect(h.order.indexOf('admit')).toBeLessThan(
        h.order.indexOf('replay.add')
      )
      expect(h.order.indexOf('replay.add')).toBeLessThan(
        h.order.indexOf('queueDialog')
      )
    })
  })

  describe('§5 identity and §11 version handling', () => {
    it('rejects a protocolVersion other than 1 with unsupportedVersion', async () => {
      const h = makeHarness()
      await h.text(helloFrame({ protocolVersion: 2 }))
      expect(h.error()).toEqual({
        type: 'pairError',
        code: 'unsupportedVersion',
      })
      expect(h.closed).toHaveLength(1)
    })

    it('rejects a chromium hello whose claimed id does not match the origin', async () => {
      const h = makeHarness()
      await h.text(helloFrame({ claimedExtensionId: 'someotherextensionid' }))
      expect(h.error().code).toBe('protocolViolation')
      expect(h.dialogs).toHaveLength(0)
    })

    it('resolves a ticketless firefox caller as unverified', async () => {
      const h = makeHarness({
        official: true,
        verifiedOrigin: 'moz-extension://8c1a0d6e-1f2b-4c3d-9e0a-5b6c7d8e9f01',
      })
      await h.text(helloFrame({ browser: 'firefox' }))
      expect(h.dialogs[0].identity).toBe('unverified')
    })

    it('resolves a ticketless chromium caller from the allowlist alone', async () => {
      const official = makeHarness({ official: true })
      await official.text(helloFrame())
      expect(official.dialogs[0].identity).toBe('official')

      const other = makeHarness({ official: false })
      await other.text(helloFrame())
      expect(other.dialogs[0].identity).toBe('attested-non-official')
    })

    it('closes a session whose nonce the demux already rejected', async () => {
      const h = makeHarness({ nonceValid: false })
      await h.text(helloFrame())
      expect(h.error()).toEqual({ type: 'pairError', code: 'expired' })
      expect(h.closed).toHaveLength(1)
      expect(h.dialogs).toHaveLength(0)
      expect(h.deps.admit).not.toHaveBeenCalled()
    })
  })

  describe('local faults are never reported as the peer’s violation', () => {
    it('reports a short CSPRNG draw as pairingFailed, not protocolViolation', async () => {
      // `drawScalar` throws `ProtocolViolationError` for a short draw, but the
      // fault is ours, not the peer's (§11). Five bytes still satisfy the
      // pairing-code draw, so the session reaches pakeA before failing.
      const h = makeHarness({
        random: (n: number) =>
          n === 5 ? new Uint8Array(randomBytes(5)) : new Uint8Array(31),
      })
      const code = await openSession(h)
      const client = new ClientDouble({ code })

      await h.text(client.pakeA())

      expect(h.error()).toEqual({ type: 'pairError', code: 'pairingFailed' })
      expect(h.closed).toHaveLength(1)
    })

    it('reports a non-ASCII verified origin as pairingFailed', async () => {
      // `enc()` refuses a non-ASCII string (§2), which would otherwise throw
      // out of the frame handler while building A_id.
      const h = makeHarness({ verifiedOrigin: 'chrome-extension://ídentity' })
      await h.text(helloFrame({ browser: 'firefox' }))
      expect(h.error()).toEqual({ type: 'pairError', code: 'pairingFailed' })
      expect(h.dialogs).toHaveLength(0)
    })

    it('closes without a plaintext error when the durable offer write fails', async () => {
      const h = makeHarness({
        offerProvisional: () => Promise.reject(new Error('disk is full')),
      })
      const code = await openSession(h)
      const client = new ClientDouble({ code })
      await runHandshake(h, client)

      expect(h.binary).toHaveLength(0)
      expect(h.closed).toHaveLength(1)
      expect(h.lastSent().type).toBe('confirmB')
    })
  })

  describe('credential exchange discipline (§6.7)', () => {
    it('closes on a credentialAck naming a credential that was never offered', async () => {
      const h = makeHarness()
      const code = await openSession(h)
      const client = new ClientDouble({ code })
      await runHandshake(h, client)
      const channel = client.channel()
      channel.opener.open(h.binary[0])

      await h.session.handleBinary(
        channel.sealer.seal(
          utf8ToBytes(
            JSON.stringify({ type: 'credentialAck', credentialId: 'not-mine' })
          )
        )
      )

      expect(h.commitFromPair).not.toHaveBeenCalled()
      expect(h.closed).toHaveLength(1)
    })

    it('closes on a binary frame that arrives before the channel exists', async () => {
      const h = makeHarness()
      await openSession(h)
      await h.session.handleBinary(new Uint8Array(64))
      expect(h.closed).toHaveLength(1)
    })
  })

  describe('post-close discipline', () => {
    it('ignores further frames once the session has been closed', async () => {
      const h = makeHarness()
      await h.text({ type: 'somethingElse' })
      const before = h.sent.length
      await h.text(helloFrame())
      expect(h.sent).toHaveLength(before)
      expect(h.closed).toHaveLength(1)
    })

    it('ignores further frames after dispose', async () => {
      const h = makeHarness()
      await openSession(h)
      h.session.dispose('timeout')
      const before = h.sent.length
      await h.text({ type: 'pakeA', pA: toBase64Url(new Uint8Array(32)) })
      expect(h.sent).toHaveLength(before)
    })
  })
})
