import { beforeEach, describe, expect, it, vi } from 'vitest'
import { MBP1_VECTORS } from '@/background/mbp1/__fixtures__/vectors'
import { LOCAL_BACKEND_AUTHORITY } from '@/background/mbp1/backend-authority'
import { b64uEncode } from '@/background/mbp1/canonical'
import {
  type AuthorityCredentialStore,
  CredentialStore,
  type Principal,
  principalKey,
  type StoredCredential,
} from '@/background/mbp1/credential-store'
import type { DiscoveryResult } from '@/background/mbp1/discovery-service'
import { EnvelopeCodec } from '@/background/mbp1/envelope'
import type { FrameChannel } from '@/background/mbp1/frames'
import { PinStore } from '@/background/mbp1/pin-store'
import {
  RECONNECT_DEADLINE_MS,
  ReconnectFlow,
  type ReconnectFlowError,
} from '@/background/mbp1/reconnect-flow'

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

const fromHex = (s: string) => Uint8Array.from(Buffer.from(s, 'hex'))

// ---------------------------------------------------------------------------
// The normative §8 vector this suite drives the real client against. The
// scripted peer below computes nothing: every crypto value it emits is read
// straight out of the vector, so a wrong implementation cannot accidentally
// agree with it (same rationale as reconnect-mac.test.ts and
// pairing-flow.test.ts's own scripted peers).
// ---------------------------------------------------------------------------
const { inputs: VIN, expected: VOUT } = MBP1_VECTORS.reconnect

const PORT = 16803
const INSTANCE_ID = VIN.instanceId ?? ''
const CREDENTIAL_ID = VIN.credentialId ?? ''

const PRINCIPAL: Principal = {
  browser: VIN.browser ?? '',
  verifiedOrigin: VIN.verifiedOrigin ?? '',
  clientInstallationId: 'test-installation-id',
}

const CREDENTIAL: StoredCredential = {
  credentialId: CREDENTIAL_ID,
  mutualKey: b64uEncode(fromHex(VIN.mutualKey ?? '')),
  principalKey: principalKey(PRINCIPAL),
  state: 'committed',
  createdAt: 1_700_000_000_000,
}

const DISCOVERY: DiscoveryResult = { transport: 'nm', wsPort: PORT }

const VECTOR_C_B64 = b64uEncode(fromHex(VIN.C ?? ''))
const VECTOR_S_B64 = b64uEncode(fromHex(VIN.S ?? ''))
const VECTOR_MAC_CLIENT_B64 = b64uEncode(fromHex(VOUT.macClient ?? ''))
const VECTOR_MAC_SERVER_B64 = b64uEncode(fromHex(VOUT.macServer ?? ''))

// ---------------------------------------------------------------------------
// In-memory storage backing `browser.storage.local`, shared by CredentialStore
// and PinStore exactly the way the real extension shares it across instances.
// ---------------------------------------------------------------------------
let backing: Record<string, unknown> = {}

interface PersistedCredentialShape extends StoredCredential {
  authorityKey?: string
}

interface StoredCredentialSetShape {
  version?: number
  credentials: PersistedCredentialShape[]
  activeCredentialId?: string | null
  activeCredentialIds?: Record<string, string>
}

beforeEach(() => {
  backing = {}
  browser.storage.local.get = vi.fn(async (k: string | string[]) => {
    const snapshot: Record<string, unknown> = {}
    for (const key of typeof k === 'string' ? [k] : k) {
      if (key in backing) snapshot[key] = backing[key]
    }
    return snapshot
  })
  browser.storage.local.set = vi.fn(async (items: Record<string, unknown>) => {
    backing = { ...backing, ...items }
  })
  browser.storage.local.remove = vi.fn(async (k: string | string[]) => {
    for (const key of Array.isArray(k) ? k : [k]) delete backing[key]
  })
})

function seedCredentials(
  credentials: StoredCredential[],
  activeCredentialId: string | null
): void {
  backing[CREDENTIALS_KEY] = { version: 1, credentials, activeCredentialId }
}

function seedCredential(): void {
  seedCredentials([CREDENTIAL], CREDENTIAL_ID)
}

function storedCredentials(): StoredCredential[] {
  const rows =
    (backing[CREDENTIALS_KEY] as StoredCredentialSetShape | undefined)
      ?.credentials ?? []
  return rows.map((credential) => {
    const base: StoredCredential = {
      credentialId: credential.credentialId,
      mutualKey: credential.mutualKey,
      principalKey: credential.principalKey,
      state: credential.state,
      createdAt: credential.createdAt,
    }
    return credential.sub === undefined
      ? base
      : { ...base, sub: credential.sub }
  })
}

// ---------------------------------------------------------------------------
// A scripted peer playing the server side of `/v1`. Frames are raw text
// pushed to an inbox and popped one at a time by `receiveText`, matching what
// `parseTextFrame` expects on the wire (JSON, `type`-discriminated).
// ---------------------------------------------------------------------------
interface ScriptOptions {
  /** Reject the upgrade itself — §8's throttle/capacity case, no frame ever sent. */
  failOpen?: boolean
  /** Raw text frames the peer sends, in order. */
  frames?: string[]
  /** Fires at the start of every `receiveText`, before the frame is popped. */
  onReceiveText?: (callIndex: number) => void
}

class ScriptedChannel implements FrameChannel {
  readonly openedUrls: string[] = []
  readonly sentText: Record<string, unknown>[] = []
  readonly textTimeouts: number[] = []
  closeCount = 0

  private readonly inbox: string[]
  private receiveCount = 0

  constructor(private readonly options: ScriptOptions = {}) {
    this.inbox = [...(options.frames ?? [])]
  }

  async open(url: string): Promise<void> {
    this.openedUrls.push(url)
    if (this.options.failOpen) {
      throw new Error('scripted peer: upgrade rejected (§8 throttle/capacity)')
    }
  }

  async sendText(frame: object): Promise<void> {
    this.sentText.push(frame as Record<string, unknown>)
  }

  async receiveText(timeoutMs: number): Promise<string> {
    this.textTimeouts.push(timeoutMs)
    this.options.onReceiveText?.(this.receiveCount)
    this.receiveCount += 1
    const next = this.inbox.shift()
    if (next === undefined) {
      throw new Error('scripted peer: socket closed with no text frame pending')
    }
    return next
  }

  async sendBinary(): Promise<void> {
    throw new Error('reconnect-flow never sends a binary frame pre-envelope')
  }

  async receiveBinary(): Promise<Uint8Array> {
    throw new Error('reconnect-flow never receives a binary frame pre-envelope')
  }

  close(): void {
    this.closeCount += 1
  }
}

function challengeFrame(
  overrides: { S?: string; protocolVersion?: number } = {}
): string {
  return JSON.stringify({
    type: 'reconnectChallenge',
    protocolVersion: overrides.protocolVersion ?? 1,
    S: overrides.S ?? VECTOR_S_B64,
  })
}

function acceptFrame(mac: string): string {
  return JSON.stringify({ type: 'reconnectAccept', mac })
}

function pairErrorFrame(code: string): string {
  return JSON.stringify({ type: 'pairError', code })
}

interface Harness {
  channel: ScriptedChannel
  creds: CredentialStore
  lifecycle: AuthorityCredentialStore
  pins: PinStore
  flow: ReconnectFlow
  setCurrent: (value: boolean) => void
  advance: (ms: number) => void
}

function makeHarness(
  scriptOptions: ScriptOptions = {},
  overrides: {
    current?: boolean
    now?: number
    random?: (n: number) => Uint8Array
  } = {}
): Harness {
  const channel = new ScriptedChannel(scriptOptions)
  const creds = new CredentialStore()
  const lifecycle = creds.forAuthorityForTest(LOCAL_BACKEND_AUTHORITY)
  const pins = new PinStore()
  let current = overrides.current ?? true
  let clock = overrides.now ?? 1_700_000_000_000
  const random = overrides.random ?? (() => fromHex(VIN.C ?? ''))
  const flow = new ReconnectFlow({
    channel,
    creds: lifecycle,
    pins,
    isCurrent: () => current,
    now: () => clock,
    random,
  })
  return {
    channel,
    creds,
    lifecycle,
    pins,
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
  overrides: Partial<Parameters<ReconnectFlow['run']>[0]> = {}
): Parameters<ReconnectFlow['run']>[0] {
  return {
    credential: CREDENTIAL,
    discovery: DISCOVERY,
    principal: PRINCIPAL,
    instanceId: INSTANCE_ID,
    ...overrides,
  }
}

async function expectFlowError(
  promise: Promise<unknown>,
  reason: string
): Promise<ReconnectFlowError> {
  try {
    await promise
  } catch (error) {
    expect((error as ReconnectFlowError).name).toBe('ReconnectFlowError')
    expect((error as ReconnectFlowError).reason).toBe(reason)
    return error as ReconnectFlowError
  }
  throw new Error(`expected the flow to reject with ${reason}`)
}

/** Commits a pin for `CREDENTIAL_ID` and returns the value it should equal after. */
async function pinCredential(
  h: Harness
): Promise<{ port: number; instanceId: string }> {
  const pin = { port: PORT, instanceId: INSTANCE_ID }
  await h.pins.commit(CREDENTIAL_ID, pin)
  return pin
}

// ---------------------------------------------------------------------------

describe('ReconnectFlow happy path (§8, against the normative vector)', () => {
  it('derives a working envelope on a correct server mac and lands the §6.7/§12 transaction', async () => {
    seedCredential()
    const h = makeHarness({
      frames: [challengeFrame(), acceptFrame(VECTOR_MAC_SERVER_B64)],
    })

    const { envelope } = await h.flow.run(runArgs())

    expect(envelope).toBeInstanceOf(EnvelopeCodec)
    expect(h.channel.openedUrls).toEqual([`ws://127.0.0.1:${PORT}/v1`])

    // Sent exactly the vector's C and the vector's macClient — nothing else.
    expect(h.channel.sentText).toEqual([
      {
        type: 'reconnectResponse',
        credentialId: CREDENTIAL_ID,
        C: VECTOR_C_B64,
        mac: VECTOR_MAC_CLIENT_B64,
      },
    ])

    // Interop check: a server-side codec built from the vector's OWN traffic
    // keys must be able to open what the client's derived codec seals — this
    // is a stronger check than `instanceof` alone, since a codec built from
    // the wrong keys is still an `EnvelopeCodec`.
    const serverEnvelope = await EnvelopeCodec.create(
      fromHex(VOUT.trafficC2S ?? ''),
      fromHex(VOUT.trafficS2C ?? ''),
      'server'
    )
    const sealed = await envelope.seal(new TextEncoder().encode('probe'))
    const opened = await serverEnvelope.open(sealed)
    expect(new TextDecoder().decode(opened)).toBe('probe')

    // §6.7/§12: a successful reconnect is an authenticated ack.
    expect(storedCredentials()).toEqual([CREDENTIAL])
    const stored = backing[CREDENTIALS_KEY] as StoredCredentialSetShape
    expect(stored.version).toBe(2)
    expect(Object.values(stored.activeCredentialIds ?? {})).toEqual([
      CREDENTIAL_ID,
    ])
    expect(stored.credentials[0]?.authenticatedInstanceId).toBe(INSTANCE_ID)
    const pins = backing[PINS_KEY] as { pins: Record<string, unknown> }
    expect(pins.pins[CREDENTIAL_ID]).toEqual({
      port: PORT,
      instanceId: INSTANCE_ID,
    })

    // The caller owns the socket from here on — MDXP runs inside it.
    expect(h.channel.closeCount).toBe(0)
  })

  it('uses an explicit remote WSS route without creating local port pins', async () => {
    seedCredential()
    const h = makeHarness({
      frames: [challengeFrame(), acceptFrame(VECTOR_MAC_SERVER_B64)],
    })

    await h.flow.run(runArgs({ remoteV1Url: 'wss://motrix.example/bridge/v1' }))

    expect(h.channel.openedUrls).toEqual(['wss://motrix.example/bridge/v1'])
    expect(backing[PINS_KEY]).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// The mandatory §6.7/§12 post-auth `finalizeAndPrune` transaction is observable
// ONLY when the seeded state differs from what a successful run would
// produce anyway. The happy-path test above seeds an already-committed,
// already-active, unpinned-elsewhere credential, so its assertions hold
// identically whether it ran or not. These two tests close
// that gap by seeding state a successful run must visibly change.
// ---------------------------------------------------------------------------
describe('§6.7/§12 post-auth transaction actually runs (not just reads back the seed)', () => {
  it('promotes a commit-uncertain credential to committed and activates it', async () => {
    // §6.7 recovery: first pairing was interrupted after `credentialAck`, so
    // the client still holds this credential as `provisional/commit-uncertain`
    // with no `activeCredentialId`. A successful reconnect is the
    // authenticated ack that must promote it.
    const provisional: StoredCredential = {
      ...CREDENTIAL,
      state: 'provisional',
      sub: 'commit-uncertain',
    }
    seedCredentials([provisional], null)
    const h = makeHarness({
      frames: [challengeFrame(), acceptFrame(VECTOR_MAC_SERVER_B64)],
    })

    await h.flow.run(runArgs())

    expect(storedCredentials()).toEqual([CREDENTIAL])
    const stored = backing[CREDENTIALS_KEY] as StoredCredentialSetShape
    expect(stored.version).toBe(2)
    expect(Object.values(stored.activeCredentialIds ?? {})).toEqual([
      CREDENTIAL_ID,
    ])
    expect(stored.credentials[0]?.authenticatedInstanceId).toBe(INSTANCE_ID)
  })

  it('prunes every other stored credential for the principal and clears its pin', async () => {
    const stale: StoredCredential = {
      credentialId: 'stale-credential-id',
      mutualKey: b64uEncode(new Uint8Array(32).fill(7)),
      principalKey: principalKey(PRINCIPAL),
      state: 'committed',
      createdAt: 1_600_000_000_000,
    }
    seedCredentials([stale, CREDENTIAL], stale.credentialId)
    const h = makeHarness({
      frames: [challengeFrame(), acceptFrame(VECTOR_MAC_SERVER_B64)],
    })
    await h.pins.commit(stale.credentialId, {
      port: PORT,
      instanceId: 'stale-instance',
    })

    await h.flow.run(runArgs())

    expect(storedCredentials()).toEqual([CREDENTIAL])
    expect(await h.pins.get(stale.credentialId)).toBeNull()
    expect(await h.pins.get(CREDENTIAL_ID)).toEqual({
      port: PORT,
      instanceId: INSTANCE_ID,
    })
  })
})

describe('§8 "not my Motrix" (reconnectAccept.mac fails to verify)', () => {
  it('clears the pin but keeps the credential, and verifies before sending anything else', async () => {
    seedCredential()
    const h = makeHarness({
      frames: [
        challengeFrame(),
        acceptFrame(b64uEncode(new Uint8Array(32).fill(0xee))),
      ],
    })
    await pinCredential(h)

    await expectFlowError(h.flow.run(runArgs()), 'serverMacMismatch')

    expect(await h.pins.get(CREDENTIAL_ID)).toBeNull()
    expect(storedCredentials()).toEqual([CREDENTIAL])
    // Nothing was sent after the (failed) reconnectResponse.
    expect(h.channel.sentText).toHaveLength(1)
    expect(h.channel.closeCount).toBe(1)
  })
})

describe('pairError authFailed (§8, §12: uniform for unknown id or bad client MAC)', () => {
  it('keeps both the credential and the pin, and reports the code', async () => {
    seedCredential()
    const h = makeHarness({
      frames: [challengeFrame(), pairErrorFrame('authFailed')],
    })
    const pin = await pinCredential(h)

    const error = await expectFlowError(h.flow.run(runArgs()), 'authFailed')
    expect(error.pairErrorCode).toBe('authFailed')

    expect(await h.pins.get(CREDENTIAL_ID)).toEqual(pin)
    expect(storedCredentials()).toEqual([CREDENTIAL])
    expect(h.channel.closeCount).toBe(1)
  })

  // `receiveChallenge` has its own `pairError` branch, separate from
  // `receiveAccept`'s copy — every other test in this file sends
  // `pairError` only after a `reconnectChallenge`, so without this test
  // that first-frame branch is never exercised. Deleting it would silently
  // reclassify a first-frame `authFailed` as `protocolViolation` — a
  // disposition change (iterate to the next credential vs. just retry) —
  // with nothing failing.
  it('reports authFailed (not protocolViolation) when it arrives as the very first frame', async () => {
    seedCredential()
    const h = makeHarness({ frames: [pairErrorFrame('authFailed')] })
    const pin = await pinCredential(h)

    const error = await expectFlowError(h.flow.run(runArgs()), 'authFailed')
    expect(error.pairErrorCode).toBe('authFailed')

    expect(await h.pins.get(CREDENTIAL_ID)).toEqual(pin)
    expect(storedCredentials()).toEqual([CREDENTIAL])
  })
})

describe('pairError with any other code', () => {
  it('is a protocolViolation carrying the code, keeping both, not a silent acceptance', async () => {
    seedCredential()
    const h = makeHarness({
      frames: [challengeFrame(), pairErrorFrame('busy')],
    })
    const pin = await pinCredential(h)

    const error = await expectFlowError(
      h.flow.run(runArgs()),
      'protocolViolation'
    )
    expect(error.pairErrorCode).toBe('busy')

    expect(await h.pins.get(CREDENTIAL_ID)).toEqual(pin)
    expect(storedCredentials()).toEqual([CREDENTIAL])
  })
})

describe('the channel never comes up (§8 upgrade-level throttle/capacity)', () => {
  it('reports channelUnavailable when open() itself is rejected, keeping the credential and the pin', async () => {
    // §8's per-origin/global reconnect throttle, and the pre-authentication
    // table's own capacity limit, both reject the WebSocket upgrade with no
    // frame at all — this is not evidence against either stored value.
    seedCredential()
    const h = makeHarness({ failOpen: true })
    const pin = await pinCredential(h)

    await expectFlowError(h.flow.run(runArgs()), 'channelUnavailable')

    expect(h.channel.sentText).toEqual([])
    expect(storedCredentials()).toEqual([CREDENTIAL])
    expect(await h.pins.get(CREDENTIAL_ID)).toEqual(pin)
  })

  it('reports channelUnavailable when no frame ever arrives, keeping the credential and the pin', async () => {
    seedCredential()
    const h = makeHarness({ frames: [] })
    const pin = await pinCredential(h)

    await expectFlowError(h.flow.run(runArgs()), 'channelUnavailable')

    expect(storedCredentials()).toEqual([CREDENTIAL])
    expect(await h.pins.get(CREDENTIAL_ID)).toEqual(pin)
  })
})

describe('the channel closes after the peer had already started talking', () => {
  it('reports channelClosed, distinct from channelUnavailable, keeping the credential and the pin', async () => {
    seedCredential()
    const h = makeHarness({ frames: [challengeFrame()] })
    const pin = await pinCredential(h)

    await expectFlowError(h.flow.run(runArgs()), 'channelClosed')

    expect(storedCredentials()).toEqual([CREDENTIAL])
    expect(await h.pins.get(CREDENTIAL_ID)).toEqual(pin)
  })
})

describe('frame order and shape', () => {
  it('reports protocolViolation when reconnectAccept arrives before reconnectChallenge, keeping both', async () => {
    seedCredential()
    const h = makeHarness({
      frames: [acceptFrame(VECTOR_MAC_SERVER_B64)],
    })
    const pin = await pinCredential(h)

    await expectFlowError(h.flow.run(runArgs()), 'protocolViolation')

    // Never got far enough to compute or send a reconnectResponse.
    expect(h.channel.sentText).toEqual([])
    expect(storedCredentials()).toEqual([CREDENTIAL])
    expect(await h.pins.get(CREDENTIAL_ID)).toEqual(pin)
  })

  it('reports unsupportedVersion for a reconnectChallenge.protocolVersion this client does not implement, keeping both', async () => {
    seedCredential()
    const h = makeHarness({
      frames: [challengeFrame({ protocolVersion: 2 })],
    })
    const pin = await pinCredential(h)

    await expectFlowError(h.flow.run(runArgs()), 'unsupportedVersion')

    expect(storedCredentials()).toEqual([CREDENTIAL])
    expect(await h.pins.get(CREDENTIAL_ID)).toEqual(pin)
  })
})

// `reconnectTranscript` (§8) feeds exactly four strings to `enc()` —
// `credentialId`, `principal.browser`, `principal.verifiedOrigin`, and
// `instanceId` — and `enc` throws on non-ASCII input. All four must be
// guarded the same way, not just `instanceId`: guarding one of four is worse
// than guarding none, since it reads as though the question was considered
// and closed for the other three.
describe('every §8 RT field is ASCII-guarded before enc()', () => {
  const cases: Array<[string, Partial<Parameters<ReconnectFlow['run']>[0]>]> = [
    ['instanceId', { instanceId: 'café' }],
    [
      'credential.credentialId',
      { credential: { ...CREDENTIAL, credentialId: 'café' } },
    ],
    ['principal.browser', { principal: { ...PRINCIPAL, browser: 'café' } }],
    [
      'principal.verifiedOrigin',
      { principal: { ...PRINCIPAL, verifiedOrigin: 'café' } },
    ],
  ]

  for (const [label, overrides] of cases) {
    it(`rejects a non-ASCII ${label} before ever opening the channel, keeping both`, async () => {
      seedCredential()
      const h = makeHarness()
      const pin = await pinCredential(h)

      await expectFlowError(h.flow.run(runArgs(overrides)), 'protocolViolation')

      expect(h.channel.openedUrls).toEqual([])
      expect(h.channel.closeCount).toBe(0)
      expect(storedCredentials()).toEqual([CREDENTIAL])
      expect(await h.pins.get(CREDENTIAL_ID)).toEqual(pin)
    })
  }
})

describe('the 10 s §8 deadline', () => {
  it('gives up once the challenge-response has run past 10 s of the upgrade, keeping both', async () => {
    seedCredential()
    const h = makeHarness({
      frames: [challengeFrame(), acceptFrame(VECTOR_MAC_SERVER_B64)],
      onReceiveText: () => h.advance(RECONNECT_DEADLINE_MS + 1),
    })
    const pin = await pinCredential(h)

    await expectFlowError(h.flow.run(runArgs()), 'deadlineExceeded')

    // Never reached the second receive: the budget check for it threw first.
    expect(h.channel.textTimeouts).toHaveLength(1)
    expect(storedCredentials()).toEqual([CREDENTIAL])
    expect(await h.pins.get(CREDENTIAL_ID)).toEqual(pin)
  })
})

describe('deps.isCurrent() is threaded through the awaits', () => {
  it('reports superseded and performs no durable write when isCurrent() goes false mid-flow', async () => {
    seedCredential()
    const h: Harness = makeHarness({
      frames: [challengeFrame(), acceptFrame(VECTOR_MAC_SERVER_B64)],
      onReceiveText: (callIndex) => {
        if (callIndex === 0) h.setCurrent(false)
      },
    })
    await expectFlowError(h.flow.run(runArgs()), 'superseded')
    expect(storedCredentials()).toEqual([CREDENTIAL])
    expect(backing[PINS_KEY]).toBeUndefined()
  })
})

// Any error this flow did not itself classify must still surface as a
// `ReconnectFlowError`, not escape as a bare `Error` a caller's
// `switch (error.reason)` reads as `undefined`. `finalizeAndPrune` throwing
// because a concurrent attempt already removed this credential
// between the orchestrator's read and this write is a genuinely reachable
// case in MV3.
describe('an unclassified error is still wrapped as a typed failure', () => {
  it('wraps a finalizeAndPrune rejection as internalError, keeping the credential and the pin', async () => {
    seedCredential()
    const h = makeHarness({
      frames: [challengeFrame(), acceptFrame(VECTOR_MAC_SERVER_B64)],
    })
    const pin = await pinCredential(h)
    vi.spyOn(h.lifecycle, 'finalizeAndPrune').mockRejectedValue(
      new Error('finalizeAndPrune: unknown credential')
    )

    await expectFlowError(h.flow.run(runArgs()), 'internalError')

    expect(storedCredentials()).toEqual([CREDENTIAL])
    expect(await h.pins.get(CREDENTIAL_ID)).toEqual(pin)
  })

  // L10: a corrupted stored mutualKey must not leak even one character of
  // key material into the error message — `internalError` forwards
  // `wrapUnknownError`'s input verbatim, and that is only safe because
  // every dependency's own thrown messages are constrained to never
  // interpolate a value drawn from key material.
  it("never forwards b64uDecode's own message for a corrupted stored mutualKey", async () => {
    seedCredential()
    const h = makeHarness({
      frames: [challengeFrame(), acceptFrame(VECTOR_MAC_SERVER_B64)],
    })
    const corrupted = 'not-valid-base64url!'

    const error = await expectFlowError(
      h.flow.run(
        runArgs({ credential: { ...CREDENTIAL, mutualKey: corrupted } })
      ),
      'internalError'
    )

    // The character b64uDecode would have named ('!') must not appear in
    // the message, and neither must the corrupted value itself.
    expect(error.message).not.toContain('!')
    expect(error.message).not.toContain(corrupted)
  })
})
