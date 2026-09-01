import { Buffer } from 'node:buffer'
import { randomBytes } from 'node:crypto'
import type { Browser } from '@shared/protocol/bridge'
import { describe, expect, it, vi } from 'vitest'
import type { StoredCredential } from '../credential-store'
import { fromBase64Url, toBase64Url } from './canonical'
import { DIR_C2S, DIR_S2C, EnvelopeOpener, EnvelopeSealer } from './envelope'
import type {
  PairErrorFrame,
  ReconnectAcceptFrame,
  ReconnectChallengeFrame,
} from './frames'
import { MBP1_PROTOCOL_VERSION } from './frames'
import {
  buildRT,
  reconnectMacClient,
  reconnectMacServer,
  reconnectTrafficKeys,
} from './reconnect-mac'
import type {
  ReconnectCredentialAuthenticator,
  ReconnectSessionDeps,
} from './reconnect-session'
import { ReconnectSession } from './reconnect-session'

const INSTANCE_ID = '0d9c2b7a-4e6f-4a1b-8c3d-2e5f7a9b1c4d'
const EXTENSION_ID = 'ibpkjhgpbidfmbmomagmldcdlpbmchgi'
const ORIGIN = `chrome-extension://${EXTENSION_ID}`
const ATTACKER_ORIGIN = 'chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
const CREDENTIAL_ID = 'a5e3c9f0-1b2d-4e6f-8a9c-0d1e2f3a4b5c'
const T0 = 1_755_600_000_000

// ---------------------------------------------------------------------------
// Test harness
// ---------------------------------------------------------------------------

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

function makeCredential(
  overrides: Partial<StoredCredential> = {}
): StoredCredential {
  return {
    credentialId: CREDENTIAL_ID,
    mutualKeyB64: toBase64Url(new Uint8Array(32).fill(9)),
    principal: {
      browser: 'chromium',
      verifiedOrigin: ORIGIN,
      clientInstallationId: 'install-0000-1111-2222',
    },
    state: 'provisional',
    identity: 'official',
    createdAt: T0,
    committedAt: null,
    predecessorId: null,
    ...overrides,
  }
}

interface HarnessOptions {
  verifiedOrigin?: string
  browser?: Browser
  instanceId?: string
  now?: () => number
  random?: (n: number) => Uint8Array
  findForAuth?: (id: string) => StoredCredential | null
  /** When set, `promoteOnReconnect` resolves only once the test resolves this. */
  gatePromote?: Deferred<void>
  promoteOnReconnect?: (id: string) => Promise<void>
}

function makeHarness(opts: HarnessOptions = {}) {
  const sent: Record<string, unknown>[] = []
  const closed: string[] = []
  const order: string[] = []
  let authenticated: {
    channel: { sealer: EnvelopeSealer; opener: EnvelopeOpener }
    credential: StoredCredential
  } | null = null

  const findForAuth = vi.fn(opts.findForAuth ?? (() => null))
  const promoteOnReconnect = vi.fn(async (id: string): Promise<void> => {
    order.push('promoteOnReconnect:start')
    // Always yields before reporting completion — otherwise the §6.7
    // ordering assertion would hold even for a caller that never awaited
    // the durable promotion (the exact vacuous-test shape Task 16's own
    // mutation evidence warned about).
    await (opts.gatePromote ? opts.gatePromote.promise : Promise.resolve())
    if (opts.promoteOnReconnect) {
      await opts.promoteOnReconnect(id)
    }
    order.push('promoteOnReconnect:resolved')
  })

  const credentials: ReconnectCredentialAuthenticator = {
    findForAuth,
    promoteOnReconnect,
  }

  const deps: ReconnectSessionDeps = {
    verifiedOrigin: opts.verifiedOrigin ?? ORIGIN,
    browser: opts.browser ?? 'chromium',
    instanceId: opts.instanceId ?? INSTANCE_ID,
    credentials,
    sendText: (json: object) => {
      order.push('sendText')
      sent.push(json as Record<string, unknown>)
    },
    close: (reason: string) => {
      closed.push(reason)
    },
    onAuthenticated: (channel, credential) => {
      order.push('onAuthenticated')
      authenticated = { channel, credential }
    },
    now: opts.now ?? (() => T0),
    random: opts.random ?? ((n: number) => new Uint8Array(randomBytes(n))),
  }

  const session = new ReconnectSession(deps)

  return {
    session,
    deps,
    sent,
    closed,
    order,
    findForAuth,
    promoteOnReconnect,
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
      if (!frame) {
        throw new Error('no frame sent')
      }
      return frame
    },
    error(): PairErrorFrame {
      return this.lastSent() as unknown as PairErrorFrame
    },
  }
}

type Harness = ReturnType<typeof makeHarness>

/** Spies on the private constant-time MAC verify seam without weakening its type elsewhere. */
function spyOnVerify(session: ReconnectSession) {
  return vi.spyOn(
    session as unknown as {
      verifyClientMac: (...args: unknown[]) => boolean
    },
    'verifyClientMac'
  )
}

function challengeFrom(h: Harness): { S: Uint8Array } {
  const challenge = h.lastSent() as unknown as ReconnectChallengeFrame
  expect(challenge.type).toBe('reconnectChallenge')
  return { S: fromBase64Url(challenge.S) }
}

// ---------------------------------------------------------------------------
// Client double — the extension (A) side, built from the same reviewed
// `reconnect-mac.ts` module, so a passing exchange proves the two roles
// interoperate rather than proving the server agrees with itself.
// ---------------------------------------------------------------------------

interface ClientArgs {
  mutualKey: Uint8Array
  S: Uint8Array
  credentialId: string
  browser: string
  verifiedOrigin: string
  instanceId: string
  c?: Uint8Array
}

function buildResponse(args: ClientArgs): {
  frame: Record<string, unknown>
  C: Uint8Array
} {
  const c = args.c ?? new Uint8Array(randomBytes(32))
  const rt = buildRT({
    protocolVersion: MBP1_PROTOCOL_VERSION,
    credentialId: args.credentialId,
    browser: args.browser,
    verifiedOrigin: args.verifiedOrigin,
    instanceId: args.instanceId,
  })
  const mac = reconnectMacClient(args.mutualKey, args.S, c, rt)
  return {
    frame: {
      type: 'reconnectResponse',
      credentialId: args.credentialId,
      C: toBase64Url(c),
      mac: toBase64Url(mac),
    },
    C: c,
  }
}

function verifyAccept(
  args: ClientArgs & { C: Uint8Array; presented: ReconnectAcceptFrame }
): boolean {
  const rt = buildRT({
    protocolVersion: MBP1_PROTOCOL_VERSION,
    credentialId: args.credentialId,
    browser: args.browser,
    verifiedOrigin: args.verifiedOrigin,
    instanceId: args.instanceId,
  })
  const expected = reconnectMacServer(args.mutualKey, args.S, args.C, rt)
  return toBase64Url(expected) === args.presented.mac
}

// ---------------------------------------------------------------------------

describe('ReconnectSession (§8)', () => {
  describe('scenario 1: happy path — a provisional credential is promoted', () => {
    it('emits reconnectChallenge with a 32-byte S on start()', () => {
      const h = makeHarness()
      h.session.start()
      const challenge = h.lastSent() as unknown as ReconnectChallengeFrame
      expect(challenge).toEqual({
        type: 'reconnectChallenge',
        protocolVersion: 1,
        S: challenge.S,
      })
      expect(fromBase64Url(challenge.S)).toHaveLength(32)
    })

    it('awaits promoteOnReconnect before sending reconnectAccept, derives interoperable traffic keys, and hands over the promoted credential', async () => {
      const mutualKey = new Uint8Array(32).fill(9)
      const provisional = makeCredential({
        state: 'provisional',
        mutualKeyB64: toBase64Url(mutualKey),
      })
      const promoted = makeCredential({
        state: 'committed',
        mutualKeyB64: toBase64Url(mutualKey),
        committedAt: T0 + 1,
      })
      const gatePromote = deferred<void>()
      let findCalls = 0
      const h = makeHarness({
        gatePromote,
        findForAuth: (id) => {
          if (id !== CREDENTIAL_ID) {
            return null
          }
          findCalls += 1
          return findCalls === 1 ? provisional : promoted
        },
      })
      h.session.start()
      const { S } = challengeFrom(h)
      const { frame, C } = buildResponse({
        mutualKey,
        S,
        credentialId: CREDENTIAL_ID,
        browser: 'chromium',
        verifiedOrigin: ORIGIN,
        instanceId: INSTANCE_ID,
      })

      const pending = h.text(frame)

      // The promote is in flight; nothing beyond the initial challenge may
      // be on the wire yet, and the handover must not have happened.
      expect(h.order).toContain('promoteOnReconnect:start')
      expect(h.order).not.toContain('promoteOnReconnect:resolved')
      expect(h.sent.some((f) => f.type === 'reconnectAccept')).toBe(false)
      expect(h.authenticated).toBeNull()

      gatePromote.resolve()
      await pending

      expect(h.order.indexOf('promoteOnReconnect:resolved')).toBeLessThan(
        h.order.lastIndexOf('sendText')
      )
      const accept = h.lastSent() as unknown as ReconnectAcceptFrame
      expect(accept.type).toBe('reconnectAccept')
      expect(
        verifyAccept({
          mutualKey,
          S,
          C,
          credentialId: CREDENTIAL_ID,
          browser: 'chromium',
          verifiedOrigin: ORIGIN,
          instanceId: INSTANCE_ID,
          presented: accept,
        })
      ).toBe(true)
      expect(h.promoteOnReconnect).toHaveBeenCalledExactlyOnceWith(
        CREDENTIAL_ID
      )
      expect(h.authenticated).not.toBeNull()
      expect(h.authenticated?.credential).toBe(promoted)
      expect(h.authenticated?.credential.credentialId).toBe(CREDENTIAL_ID)
      expect(h.authenticated?.credential.state).toBe('committed')

      // Traffic keys derived per §8, proven by round-tripping through a
      // client-side opener/sealer built independently from the same vectors.
      const { kC2S, kS2C } = reconnectTrafficKeys(mutualKey, S, C)
      const clientOpener = new EnvelopeOpener(kS2C, DIR_S2C)
      const serverSealed = h.authenticated?.channel.sealer.seal(
        Buffer.from('server->client probe')
      )
      expect(serverSealed).toBeDefined()
      expect(
        Buffer.from(clientOpener.open(serverSealed as Uint8Array)).toString()
      ).toBe('server->client probe')

      const clientSealer = new EnvelopeSealer(kC2S, DIR_C2S)
      const clientSealed = clientSealer.seal(
        Buffer.from('client->server probe')
      )
      expect(
        Buffer.from(
          h.authenticated?.channel.opener.open(clientSealed) as Uint8Array
        ).toString()
      ).toBe('client->server probe')
    })
  })

  describe('scenario 2: unknown credentialId and a bad MAC are indistinguishable (§8, §11)', () => {
    it('rejects an unknown credentialId with a single authFailed after exactly one verify call', async () => {
      const mutualKey = new Uint8Array(32).fill(9)
      const h = makeHarness({ findForAuth: () => null })
      h.session.start()
      const { S } = challengeFrom(h)
      const { frame } = buildResponse({
        mutualKey,
        S,
        credentialId: 'this-credential-id-does-not-exist',
        browser: 'chromium',
        verifiedOrigin: ORIGIN,
        instanceId: INSTANCE_ID,
      })
      const verifySpy = spyOnVerify(h.session)

      await h.text(frame)

      expect(verifySpy).toHaveBeenCalledTimes(1)
      // The whole emitted sequence, not just the last frame: reconnectChallenge
      // then exactly one pairError, nothing else — same shape scenario 2's
      // other test must also produce.
      expect(h.sent).toHaveLength(2)
      expect(h.error()).toEqual({ type: 'pairError', code: 'authFailed' })
      expect(h.closed).toEqual(['authFailed'])
      expect(h.authenticated).toBeNull()
      expect(h.promoteOnReconnect).not.toHaveBeenCalled()
    })

    it('rejects a known credentialId with a wrong MAC through the exact same single-verify-call, single authFailed shape', async () => {
      const realKey = new Uint8Array(32).fill(9)
      const wrongKey = new Uint8Array(32).fill(3)
      const credential = makeCredential({
        state: 'committed',
        committedAt: T0 - 1,
        mutualKeyB64: toBase64Url(realKey),
      })
      const h = makeHarness({
        findForAuth: (id) => (id === CREDENTIAL_ID ? credential : null),
      })
      h.session.start()
      const { S } = challengeFrom(h)
      const { frame } = buildResponse({
        mutualKey: wrongKey,
        S,
        credentialId: CREDENTIAL_ID,
        browser: 'chromium',
        verifiedOrigin: ORIGIN,
        instanceId: INSTANCE_ID,
      })
      const verifySpy = spyOnVerify(h.session)

      await h.text(frame)

      expect(verifySpy).toHaveBeenCalledTimes(1)
      expect(h.sent).toHaveLength(2)
      expect(h.error()).toEqual({ type: 'pairError', code: 'authFailed' })
      expect(h.closed).toEqual(['authFailed'])
      expect(h.authenticated).toBeNull()
      expect(h.promoteOnReconnect).not.toHaveBeenCalled()
    })
  })

  describe('scenario 3: a provisional credential (no predecessor) is reconnect-valid and is promoted (§6.7)', () => {
    it('authenticates a first-reconnect provisional exactly as it would a rotation provisional', async () => {
      const mutualKey = new Uint8Array(32).fill(5)
      const provisional = makeCredential({
        state: 'provisional',
        mutualKeyB64: toBase64Url(mutualKey),
        predecessorId: null,
        identity: 'unverified',
      })
      const promoted = makeCredential({
        ...provisional,
        state: 'committed',
        committedAt: T0 + 5,
      })
      let calls = 0
      const h = makeHarness({
        findForAuth: (id) => {
          if (id !== CREDENTIAL_ID) {
            return null
          }
          calls += 1
          return calls === 1 ? provisional : promoted
        },
      })
      h.session.start()
      const { S } = challengeFrom(h)
      const { frame } = buildResponse({
        mutualKey,
        S,
        credentialId: CREDENTIAL_ID,
        browser: 'chromium',
        verifiedOrigin: ORIGIN,
        instanceId: INSTANCE_ID,
      })

      await h.text(frame)

      expect(h.promoteOnReconnect).toHaveBeenCalledExactlyOnceWith(
        CREDENTIAL_ID
      )
      expect(h.authenticated?.credential.state).toBe('committed')
      expect(h.lastSent().type).toBe('reconnectAccept')
    })
  })

  describe('an already-committed credential skips promotion entirely', () => {
    it('sends reconnectAccept without ever calling promoteOnReconnect', async () => {
      const mutualKey = new Uint8Array(32).fill(2)
      const committed = makeCredential({
        state: 'committed',
        committedAt: T0 - 1000,
        mutualKeyB64: toBase64Url(mutualKey),
      })
      const h = makeHarness({
        findForAuth: (id) => (id === CREDENTIAL_ID ? committed : null),
      })
      h.session.start()
      const { S } = challengeFrom(h)
      const { frame } = buildResponse({
        mutualKey,
        S,
        credentialId: CREDENTIAL_ID,
        browser: 'chromium',
        verifiedOrigin: ORIGIN,
        instanceId: INSTANCE_ID,
      })

      await h.text(frame)

      expect(h.promoteOnReconnect).not.toHaveBeenCalled()
      expect(h.lastSent().type).toBe('reconnectAccept')
      expect(h.authenticated?.credential).toBe(committed)
      expect(h.authenticated?.credential.credentialId).toBe(CREDENTIAL_ID)
    })
  })

  describe('scenario 4: 10 s challenge-response deadline (§8)', () => {
    it('treats a response arriving at/after the 10 s deadline as authFailed even though it is otherwise valid', async () => {
      const mutualKey = new Uint8Array(32).fill(9)
      const credential = makeCredential({
        state: 'committed',
        committedAt: T0 - 1,
        mutualKeyB64: toBase64Url(mutualKey),
      })
      let clock = T0
      const h = makeHarness({
        now: () => clock,
        findForAuth: (id) => (id === CREDENTIAL_ID ? credential : null),
      })
      h.session.start()
      const { S } = challengeFrom(h)
      const { frame } = buildResponse({
        mutualKey,
        S,
        credentialId: CREDENTIAL_ID,
        browser: 'chromium',
        verifiedOrigin: ORIGIN,
        instanceId: INSTANCE_ID,
      })

      clock = T0 + 10_000
      await h.text(frame)

      expect(h.error()).toEqual({ type: 'pairError', code: 'authFailed' })
      expect(h.closed).toEqual(['authFailed'])
      expect(h.promoteOnReconnect).not.toHaveBeenCalled()
      expect(h.authenticated).toBeNull()
    })

    it('fails authFailed when the durable promotion outlives the deadline, instead of accepting late', async () => {
      const mutualKey = new Uint8Array(32).fill(9)
      const provisional = makeCredential({
        state: 'provisional',
        mutualKeyB64: toBase64Url(mutualKey),
      })
      let clock = T0
      const h = makeHarness({
        now: () => clock,
        findForAuth: (id) => (id === CREDENTIAL_ID ? provisional : null),
        // The store transaction is durable but slow: it resolves only after
        // the §8 deadline has already passed.
        promoteOnReconnect: async () => {
          clock = T0 + 10_000
        },
      })
      h.session.start()
      const { S } = challengeFrom(h)
      const { frame } = buildResponse({
        mutualKey,
        S,
        credentialId: CREDENTIAL_ID,
        browser: 'chromium',
        verifiedOrigin: ORIGIN,
        instanceId: INSTANCE_ID,
      })

      clock = T0 + 9_999
      await h.text(frame)

      // §6.7 durable-first is untouched: the promotion itself still ran…
      expect(h.promoteOnReconnect).toHaveBeenCalledExactlyOnceWith(
        CREDENTIAL_ID
      )
      // …but the exchange missed §8's 10 s deadline, so no accept, no
      // channel, and the same uniform failure a late response gets.
      expect(h.sent.some((f) => f.type === 'reconnectAccept')).toBe(false)
      expect(h.error()).toEqual({ type: 'pairError', code: 'authFailed' })
      expect(h.closed).toEqual(['authFailed'])
      expect(h.authenticated).toBeNull()
    })

    it('accepts a response that arrives just under the 10 s deadline', async () => {
      const mutualKey = new Uint8Array(32).fill(9)
      const credential = makeCredential({
        state: 'committed',
        committedAt: T0 - 1,
        mutualKeyB64: toBase64Url(mutualKey),
      })
      let clock = T0
      const h = makeHarness({
        now: () => clock,
        findForAuth: (id) => (id === CREDENTIAL_ID ? credential : null),
      })
      h.session.start()
      const { S } = challengeFrom(h)
      const { frame } = buildResponse({
        mutualKey,
        S,
        credentialId: CREDENTIAL_ID,
        browser: 'chromium',
        verifiedOrigin: ORIGIN,
        instanceId: INSTANCE_ID,
      })

      clock = T0 + 9_999
      await h.text(frame)

      expect(h.lastSent().type).toBe('reconnectAccept')
      expect(h.authenticated).not.toBeNull()
    })

    it("documents the silent-client boundary: dispose('timeout') leaves the session terminal with no frame beyond the challenge, and a subsequently-arriving response is refused", async () => {
      // This module cannot itself close the transport when the client never
      // responds at all — there is no injected timer, only `deps.now()` — so
      // that case is Task 18's `PreAuthTable` real-timer responsibility
      // (mirrors `PairSession`'s own reactive-only 120 s code lifetime). What
      // this test pins is the boundary: once the wiring's deadline fires and
      // calls `dispose('timeout')`, this session is provably inert from then
      // on, emitting nothing further and accepting nothing further, even if a
      // response arrives on the wire after all.
      const mutualKey = new Uint8Array(32).fill(9)
      const credential = makeCredential({
        state: 'committed',
        committedAt: T0 - 1,
        mutualKeyB64: toBase64Url(mutualKey),
      })
      const h = makeHarness({
        findForAuth: (id) => (id === CREDENTIAL_ID ? credential : null),
      })
      h.session.start()
      const { S } = challengeFrom(h)
      const { frame } = buildResponse({
        mutualKey,
        S,
        credentialId: CREDENTIAL_ID,
        browser: 'chromium',
        verifiedOrigin: ORIGIN,
        instanceId: INSTANCE_ID,
      })

      h.session.dispose('timeout')

      expect(h.sent).toHaveLength(1) // only the initial reconnectChallenge
      expect(h.closed).toEqual([]) // dispose itself never closes (Task 18's job)

      await h.text(frame)

      expect(h.sent).toHaveLength(1)
      expect(h.closed).toEqual([])
      expect(h.authenticated).toBeNull()
    })
  })

  describe('scenario 5: misbinding — RT is built from the live connection, never the client claim (§8)', () => {
    it('rejects a stolen key even when the attacker recomputes a valid MAC for its own live Origin', async () => {
      const mutualKey = new Uint8Array(32).fill(9)
      const credential = makeCredential({
        state: 'committed',
        committedAt: T0 - 1,
        mutualKeyB64: toBase64Url(mutualKey),
        principal: {
          browser: 'chromium',
          verifiedOrigin: ORIGIN,
          clientInstallationId: 'install-0000-1111-2222',
        },
      })
      const h = makeHarness({
        verifiedOrigin: ATTACKER_ORIGIN,
        findForAuth: (id) => (id === CREDENTIAL_ID ? credential : null),
      })
      const verify = spyOnVerify(h.session)
      h.session.start()
      const { S } = challengeFrom(h)
      const { frame } = buildResponse({
        mutualKey,
        S,
        credentialId: CREDENTIAL_ID,
        browser: 'chromium',
        verifiedOrigin: ATTACKER_ORIGIN,
        instanceId: INSTANCE_ID,
      })

      await h.text(frame)

      // Proves the cryptographic check itself passed: rejection is caused by
      // binding the durable credential principal to the live connection.
      expect(verify).toHaveReturnedWith(true)
      expect(h.error()).toEqual({ type: 'pairError', code: 'authFailed' })
      expect(h.promoteOnReconnect).not.toHaveBeenCalled()
      expect(h.authenticated).toBeNull()
    })

    it('fails the MAC when the client computed it against a different verifiedOrigin than the live connection', async () => {
      const mutualKey = new Uint8Array(32).fill(9)
      const credential = makeCredential({
        state: 'committed',
        committedAt: T0 - 1,
        mutualKeyB64: toBase64Url(mutualKey),
      })
      const h = makeHarness({
        verifiedOrigin: ORIGIN,
        findForAuth: (id) => (id === CREDENTIAL_ID ? credential : null),
      })
      h.session.start()
      const { S } = challengeFrom(h)
      // The client's own transcript uses a different verifiedOrigin than the
      // live connection the server actually has — simulating a stored
      // principal that has drifted from the connection it is now on.
      const { frame } = buildResponse({
        mutualKey,
        S,
        credentialId: CREDENTIAL_ID,
        browser: 'chromium',
        verifiedOrigin: ATTACKER_ORIGIN,
        instanceId: INSTANCE_ID,
      })

      await h.text(frame)

      expect(h.error()).toEqual({ type: 'pairError', code: 'authFailed' })
      expect(h.promoteOnReconnect).not.toHaveBeenCalled()
      expect(h.authenticated).toBeNull()
    })

    it('fails the MAC when the client computed it against a different browser than the live connection', async () => {
      const mutualKey = new Uint8Array(32).fill(9)
      const credential = makeCredential({
        state: 'committed',
        committedAt: T0 - 1,
        mutualKeyB64: toBase64Url(mutualKey),
      })
      const h = makeHarness({
        browser: 'chromium',
        findForAuth: (id) => (id === CREDENTIAL_ID ? credential : null),
      })
      h.session.start()
      const { S } = challengeFrom(h)
      const { frame } = buildResponse({
        mutualKey,
        S,
        credentialId: CREDENTIAL_ID,
        browser: 'firefox',
        verifiedOrigin: ORIGIN,
        instanceId: INSTANCE_ID,
      })

      await h.text(frame)

      expect(h.error()).toEqual({ type: 'pairError', code: 'authFailed' })
    })
  })

  describe('scenario 6: frame discipline (§6.1, §8)', () => {
    it('rejects an oversized frame with protocolViolation', async () => {
      const h = makeHarness()
      h.session.start()
      await h.raw('{}', 16 * 1024 + 1)
      expect(h.error()).toEqual({
        type: 'pairError',
        code: 'protocolViolation',
      })
      expect(h.closed).toEqual(['protocolViolation'])
    })

    it('rejects an unknown frame type with protocolViolation', async () => {
      const h = makeHarness()
      h.session.start()
      await h.text({ type: 'somethingElse' })
      expect(h.error()).toEqual({
        type: 'pairError',
        code: 'protocolViolation',
      })
    })

    it('rejects malformed JSON with protocolViolation', async () => {
      const h = makeHarness()
      h.session.start()
      await h.raw('not valid json')
      expect(h.error()).toEqual({
        type: 'pairError',
        code: 'protocolViolation',
      })
    })

    it('rejects a schema-invalid reconnectResponse with protocolViolation', async () => {
      const h = makeHarness()
      h.session.start()
      await h.text({
        type: 'reconnectResponse',
        credentialId: CREDENTIAL_ID,
        C: 'short',
        mac: 'short',
      })
      expect(h.error()).toEqual({
        type: 'pairError',
        code: 'protocolViolation',
      })
    })

    it('rejects a second reconnectResponse arriving while the first is still mid-promote, and never resurrects the first', async () => {
      const mutualKey = new Uint8Array(32).fill(9)
      const provisional = makeCredential({
        state: 'provisional',
        mutualKeyB64: toBase64Url(mutualKey),
      })
      const gatePromote = deferred<void>()
      const h = makeHarness({
        gatePromote,
        findForAuth: (id) => (id === CREDENTIAL_ID ? provisional : null),
      })
      h.session.start()
      const { S } = challengeFrom(h)
      const { frame } = buildResponse({
        mutualKey,
        S,
        credentialId: CREDENTIAL_ID,
        browser: 'chromium',
        verifiedOrigin: ORIGIN,
        instanceId: INSTANCE_ID,
      })

      const first = h.text(frame)
      // Fired in the same synchronous tick, while the first response is
      // suspended inside `promoteOnReconnect`'s gate.
      const duplicate = h.text(frame)

      gatePromote.resolve()
      await Promise.all([first, duplicate])

      expect(h.closed).toEqual(['protocolViolation'])
      expect(h.sent.some((f) => f.type === 'reconnectAccept')).toBe(false)
      expect(h.authenticated).toBeNull()
    })
  })

  describe('post-terminal discipline', () => {
    it('ignores further text frames once authenticated', async () => {
      const mutualKey = new Uint8Array(32).fill(4)
      const credential = makeCredential({
        state: 'committed',
        committedAt: T0 - 1,
        mutualKeyB64: toBase64Url(mutualKey),
      })
      const h = makeHarness({
        findForAuth: (id) => (id === CREDENTIAL_ID ? credential : null),
      })
      h.session.start()
      const { S } = challengeFrom(h)
      const { frame } = buildResponse({
        mutualKey,
        S,
        credentialId: CREDENTIAL_ID,
        browser: 'chromium',
        verifiedOrigin: ORIGIN,
        instanceId: INSTANCE_ID,
      })
      await h.text(frame)
      const sentBefore = h.sent.length
      const closedBefore = h.closed.length

      await h.text(frame)

      expect(h.sent).toHaveLength(sentBefore)
      expect(h.closed).toHaveLength(closedBefore)
    })

    it('dispose is idempotent, discards the challenge secret, and does not itself close the transport', () => {
      const h = makeHarness()
      h.session.start()

      h.session.dispose('timeout')
      h.session.dispose('timeout')

      // Mirrors `PairSession.dispose`: by the time the wiring calls this,
      // it is either already closing the transport itself or the peer is
      // already gone, so this must not also call `deps.close`.
      expect(h.closed).toEqual([])
      // No frame beyond the initial challenge was ever emitted.
      expect(h.sent).toHaveLength(1)
    })

    it('ignores a text frame delivered after dispose', async () => {
      const mutualKey = new Uint8Array(32).fill(9)
      const credential = makeCredential({
        state: 'committed',
        committedAt: T0 - 1,
        mutualKeyB64: toBase64Url(mutualKey),
      })
      const h = makeHarness({
        findForAuth: (id) => (id === CREDENTIAL_ID ? credential : null),
      })
      h.session.start()
      const { S } = challengeFrom(h)
      const { frame } = buildResponse({
        mutualKey,
        S,
        credentialId: CREDENTIAL_ID,
        browser: 'chromium',
        verifiedOrigin: ORIGIN,
        instanceId: INSTANCE_ID,
      })

      h.session.dispose('socket-closed')
      await h.text(frame)

      expect(h.sent).toHaveLength(1) // only the initial reconnectChallenge
      expect(h.authenticated).toBeNull()
    })
  })

  describe('a failed durable promotion is a local fault, not a peer violation', () => {
    it('closes without any frame when promoteOnReconnect rejects', async () => {
      const mutualKey = new Uint8Array(32).fill(9)
      const provisional = makeCredential({
        state: 'provisional',
        mutualKeyB64: toBase64Url(mutualKey),
      })
      const h = makeHarness({
        findForAuth: (id) => (id === CREDENTIAL_ID ? provisional : null),
        promoteOnReconnect: async () => {
          throw new Error('stale rotation: CAS observed a changed current id')
        },
      })
      h.session.start()
      const { S } = challengeFrom(h)
      const { frame } = buildResponse({
        mutualKey,
        S,
        credentialId: CREDENTIAL_ID,
        browser: 'chromium',
        verifiedOrigin: ORIGIN,
        instanceId: INSTANCE_ID,
      })

      await h.text(frame)

      expect(h.sent).toHaveLength(1) // only the initial reconnectChallenge
      expect(h.closed).toEqual(['reconnectPromoteFailed'])
      expect(h.authenticated).toBeNull()
    })
  })

  describe('non-schema-validated inputs never escape handleText as an uncaught rejection', () => {
    it('treats a non-ASCII live verifiedOrigin (deps-supplied, not schema-checked like a frame field) as authFailed rather than throwing out of handleText', async () => {
      const mutualKey = new Uint8Array(32).fill(9)
      const nonAsciiOrigin = 'chrome-extension://éxt-not-ascii'
      const credential = makeCredential({
        state: 'committed',
        committedAt: T0 - 1,
        mutualKeyB64: toBase64Url(mutualKey),
      })
      // The harness's live-connection `verifiedOrigin` is the non-ASCII
      // value that will make the *server's* own `buildRT` throw. The client
      // double still computes a normal (ASCII) transcript for whatever it
      // believes — its exact MAC is irrelevant here, since the server never
      // gets far enough to compare it.
      const h = makeHarness({
        verifiedOrigin: nonAsciiOrigin,
        findForAuth: (id) => (id === CREDENTIAL_ID ? credential : null),
      })
      h.session.start()
      const { S } = challengeFrom(h)
      const { frame } = buildResponse({
        mutualKey,
        S,
        credentialId: CREDENTIAL_ID,
        browser: 'chromium',
        verifiedOrigin: ORIGIN,
        instanceId: INSTANCE_ID,
      })

      // Must resolve (not reject) and reach the uniform failure frame.
      await expect(h.text(frame)).resolves.toBeUndefined()

      expect(h.error()).toEqual({ type: 'pairError', code: 'authFailed' })
      expect(h.closed).toEqual(['authFailed'])
      expect(h.sent).toHaveLength(2)
      expect(h.authenticated).toBeNull()
    })

    it('treats a corrupted stored mutualKeyB64 (store-supplied, not schema-checked) as authFailed rather than throwing out of handleText', async () => {
      const credential = makeCredential({
        state: 'committed',
        committedAt: T0 - 1,
        mutualKeyB64: 'not*valid#base64url',
      })
      const h = makeHarness({
        findForAuth: (id) => (id === CREDENTIAL_ID ? credential : null),
      })
      h.session.start()
      const { S } = challengeFrom(h)
      const { frame } = buildResponse({
        mutualKey: new Uint8Array(32).fill(9),
        S,
        credentialId: CREDENTIAL_ID,
        browser: 'chromium',
        verifiedOrigin: ORIGIN,
        instanceId: INSTANCE_ID,
      })

      await expect(h.text(frame)).resolves.toBeUndefined()

      expect(h.error()).toEqual({ type: 'pairError', code: 'authFailed' })
      expect(h.closed).toEqual(['authFailed'])
      expect(h.sent).toHaveLength(2)
      expect(h.authenticated).toBeNull()
    })
  })
})
