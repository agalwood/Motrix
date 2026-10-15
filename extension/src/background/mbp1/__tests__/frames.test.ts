import { describe, expect, it } from 'vitest'
import { b64uEncode } from '@/background/mbp1/canonical'
import {
  assertProtocolVersion,
  buildConfirmA,
  buildCredentialAck,
  buildPairHello,
  buildPakeA,
  buildReconnectResponse,
  FrameError,
  MAX_PRE_AUTH_FRAME_BYTES,
  MBP1_PROTOCOL_VERSION,
  MBP1_SUBPROTOCOL,
  PAIR_ERROR_CODES,
  pairHelloFrameSchema,
  pairUrl,
  parseNmTicket,
  parseServerFrame,
  parseTextFrame,
  reconnectUrl,
} from '@/background/mbp1/frames'

const b32 = b64uEncode(new Uint8Array(32).fill(1))
const b64 = b64uEncode(new Uint8Array(64).fill(2))

function keys(frame: object): string[] {
  return Object.keys(frame).sort()
}

/**
 * The field lists below are transcribed from the interop contract, which was
 * extracted from Line A's shipped `frames.ts` — the peer's real validator, not
 * a restatement of the spec. Every one of Line A's schemas is `.strict()`, so
 * one extra or one missing property anywhere is a `protocolViolation` and the
 * pairing dies. These assertions exist so a future edit that adds a
 * "harmless" field fails here instead of silently in the field.
 */
describe('client -> server frame shapes (interop contract)', () => {
  it('accepts a Safari bundle claim and ticket browser without changing protocol v1', () => {
    const frame = buildPairHello({
      browser: 'safari',
      claimedExtensionId: 'app.motrix.safari.extension',
      clientInstallationId: 'safari-installation',
      ticketBindingKey: b32,
      nmTicket: {
        v: 1,
        purpose: 'mbp1-attestation',
        protocolVersion: 1,
        serverGeneration: 'generation',
        browser: 'safari',
        callerId: 'app.motrix.safari.extension',
        exp: 1_800_000_000,
        bindingPub: b32,
        mac: b32,
      },
    })
    expect(frame.protocolVersion).toBe(1)
    expect(parseNmTicket(frame.nmTicket).browser).toBe('safari')
  })
  it('pairHello carries exactly six fields when ticketless', () => {
    const frame = buildPairHello({
      browser: 'firefox',
      claimedExtensionId: 'motrix@example.org',
      clientInstallationId: 'cid-1',
    })
    expect(keys(frame)).toEqual([
      'browser',
      'claimedExtensionId',
      'clientInstallationId',
      'protocolVersion',
      'type',
    ])
    expect(frame.protocolVersion).toBe(MBP1_PROTOCOL_VERSION)
  })

  it('pairHello omits both ticket fields when ticketless, rather than nulling them', () => {
    const frame = buildPairHello({
      browser: 'chromium',
      claimedExtensionId: 'abc',
      clientInstallationId: 'cid-1',
    })
    // A ticketless attempt omits BOTH — not `null`, not an empty string. The
    // interop contract is explicit, and Line A's refinement rejects either.
    expect('nmTicket' in frame).toBe(false)
    expect('ticketBindingKey' in frame).toBe(false)
  })

  it('pairHello carries both ticket fields when ticketed', () => {
    const frame = buildPairHello({
      browser: 'chromium',
      claimedExtensionId: 'abc',
      clientInstallationId: 'cid-1',
      nmTicket: { anything: true },
      ticketBindingKey: b32,
    })
    expect(keys(frame)).toEqual([
      'browser',
      'claimedExtensionId',
      'clientInstallationId',
      'nmTicket',
      'protocolVersion',
      'ticketBindingKey',
      'type',
    ])
  })

  it('refuses to build a pairHello with a ticket but no binding key', () => {
    expect(() =>
      buildPairHello({
        browser: 'chromium',
        claimedExtensionId: 'abc',
        clientInstallationId: 'cid-1',
        nmTicket: { anything: true },
      })
    ).toThrow(FrameError)
  })

  it('refuses to build a pairHello with a binding key but no ticket', () => {
    expect(() =>
      buildPairHello({
        browser: 'chromium',
        claimedExtensionId: 'abc',
        clientInstallationId: 'cid-1',
        ticketBindingKey: b32,
      })
    ).toThrow(FrameError)
  })

  it('rejects a pairHello whose ticketBindingKey is not canonical base64url(32)', () => {
    // Padded, standard-alphabet, and wrong-length values must all fail: Line
    // A's decoder rejects padding, `+`/`/`, and non-canonical trailing bits.
    for (const bad of [
      `${b64uEncode(new Uint8Array(32))}=`,
      'AAAA+AAA/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
      b64uEncode(new Uint8Array(31)),
      b64uEncode(new Uint8Array(33)),
    ]) {
      expect(() =>
        buildPairHello({
          browser: 'chromium',
          claimedExtensionId: 'abc',
          clientInstallationId: 'cid-1',
          nmTicket: {},
          ticketBindingKey: bad,
        })
      ).toThrow(FrameError)
    }
  })

  it('rejects a non-ASCII claimedExtensionId before it reaches enc()', () => {
    expect(() =>
      buildPairHello({
        browser: 'chromium',
        claimedExtensionId: 'abé',
        clientInstallationId: 'cid-1',
      })
    ).toThrow(FrameError)
  })

  it('rejects an extra property on pairHello (strict)', () => {
    expect(
      pairHelloFrameSchema.safeParse({
        type: 'pairHello',
        protocolVersion: 1,
        browser: 'chromium',
        claimedExtensionId: 'abc',
        clientInstallationId: 'cid-1',
        extensionVersion: '1.2.3',
      }).success
    ).toBe(false)
  })

  it('pakeA carries exactly type and pA — no protocolVersion', () => {
    expect(keys(buildPakeA(b32))).toEqual(['pA', 'type'])
  })

  it('confirmA carries ticketProof only when one is supplied', () => {
    expect(keys(buildConfirmA(b32))).toEqual(['cA', 'type'])
    expect(keys(buildConfirmA(b32, b64))).toEqual(['cA', 'ticketProof', 'type'])
  })

  it('rejects a wrong-length ticketProof (64 bytes, schema-enforced)', () => {
    expect(() => buildConfirmA(b32, b32)).toThrow(FrameError)
  })

  it('credentialAck carries exactly type and credentialId', () => {
    expect(keys(buildCredentialAck('cred-1'))).toEqual(['credentialId', 'type'])
  })

  // The single easiest mistake on this line: `reconnectChallenge` (the frame
  // this answers) DOES carry a protocolVersion, and this one does NOT.
  it('reconnectResponse carries no protocolVersion', () => {
    const frame = buildReconnectResponse({
      credentialId: 'cred-1',
      C: b32,
      mac: b32,
    })
    expect(keys(frame)).toEqual(['C', 'credentialId', 'mac', 'type'])
    expect('protocolVersion' in frame).toBe(false)
  })
})

describe('parseServerFrame — envelope first, then body (§6.1)', () => {
  it('accepts every server frame the client can receive', () => {
    const frames = [
      { type: 'pairAccept', protocolVersion: 1, instanceId: 'inst' },
      { type: 'pakeB', pB: b32 },
      { type: 'confirmB', cB: b32 },
      { type: 'credentialOffer', credentialId: 'c1', mutualKey: b32 },
      { type: 'credentialCommitted' },
      { type: 'reconnectChallenge', protocolVersion: 1, S: b32 },
      { type: 'reconnectAccept', mac: b32 },
      { type: 'pairError', code: 'codeMismatch', attemptsRemaining: 2 },
    ]
    for (const frame of frames) {
      expect(parseServerFrame(frame)).toEqual(frame)
    }
  })

  it('classifies a payload that is not an object-with-string-type as malformed', () => {
    for (const value of [null, [], 'pairAccept', 7, { type: 1 }, {}]) {
      try {
        parseServerFrame(value)
        throw new Error('expected a throw')
      } catch (error) {
        expect(error).toBeInstanceOf(FrameError)
        expect((error as FrameError).kind).toBe('malformed')
      }
    }
  })

  it('classifies an unrecognized type as unknownType, distinctly from a bad body', () => {
    try {
      parseServerFrame({ type: 'pairHelloBack' })
      throw new Error('expected a throw')
    } catch (error) {
      expect((error as FrameError).kind).toBe('unknownType')
    }
    try {
      parseServerFrame({ type: 'pakeB', pB: 'not-base64url-32' })
      throw new Error('expected a throw')
    } catch (error) {
      expect((error as FrameError).kind).toBe('invalidBody')
    }
  })

  it('does not accept a client frame type from the server', () => {
    // The client must never treat its own outbound types as inbound: a peer
    // echoing `pairHello` back is not a frame this side has a state for.
    for (const type of [
      'pairHello',
      'pakeA',
      'confirmA',
      'credentialAck',
      'reconnectResponse',
    ]) {
      try {
        parseServerFrame({ type })
        throw new Error('expected a throw')
      } catch (error) {
        expect((error as FrameError).kind).toBe('unknownType')
      }
    }
  })

  it('rejects an extra property on an inbound frame (strict)', () => {
    expect(() =>
      parseServerFrame({
        type: 'pairAccept',
        protocolVersion: 1,
        instanceId: 'inst',
        appVersion: '2.0.0',
      })
    ).toThrow(FrameError)
  })

  it('accepts explicit operator denial and rejects codes outside the vocabulary', () => {
    expect(parseServerFrame({ type: 'pairError', code: 'denied' })).toEqual({
      type: 'pairError',
      code: 'denied',
    })
    expect(() =>
      parseServerFrame({ type: 'pairError', code: 'somethingElse' })
    ).toThrow(FrameError)
    expect(PAIR_ERROR_CODES).toHaveLength(10)
  })

  it('rejects a pairError carrying a free-form detail field', () => {
    // §11 defines no message field, deliberately: a `pairError` must not
    // reveal which internal step failed.
    expect(() =>
      parseServerFrame({
        type: 'pairError',
        code: 'codeMismatch',
        message: 'wrong code',
      })
    ).toThrow(FrameError)
  })

  it('rejects a negative or fractional attemptsRemaining', () => {
    for (const attemptsRemaining of [-1, 1.5]) {
      expect(() =>
        parseServerFrame({
          type: 'pairError',
          code: 'codeMismatch',
          attemptsRemaining,
        })
      ).toThrow(FrameError)
    }
  })

  it('keeps base64url fields as strings rather than decoding them', () => {
    const frame = parseServerFrame({
      type: 'credentialOffer',
      credentialId: 'c1',
      mutualKey: b32,
    })
    // `mutualKey` stays the wire string all the way into CredentialStore.
    expect(frame).toEqual({
      type: 'credentialOffer',
      credentialId: 'c1',
      mutualKey: b32,
    })
  })
})

describe('parseTextFrame', () => {
  it('rejects a frame over the 16 KiB pre-auth cap before parsing it', () => {
    const oversize = `{"type":"pakeB","pB":"${'A'.repeat(
      MAX_PRE_AUTH_FRAME_BYTES
    )}"}`
    try {
      parseTextFrame(oversize)
      throw new Error('expected a throw')
    } catch (error) {
      expect((error as FrameError).kind).toBe('malformed')
    }
  })

  it('rejects a frame whose UTF-8 wire size exceeds the cap even though its UTF-16 length does not', () => {
    // 6,000 CJK chars: ~6 K UTF-16 code units (well under the cap) but
    // ~18 KiB of UTF-8 wire bytes (over it). §6.1's cap is a byte cap.
    const oversizeUtf8 = `{"type":"pakeB","pB":"${'好'.repeat(6000)}"}`
    expect(oversizeUtf8.length).toBeLessThan(MAX_PRE_AUTH_FRAME_BYTES)
    try {
      parseTextFrame(oversizeUtf8)
      throw new Error('expected a throw')
    } catch (error) {
      expect((error as FrameError).kind).toBe('malformed')
      expect((error as FrameError).message).toMatch(/16 KiB/)
    }
  })

  it('classifies unparseable JSON as malformed', () => {
    try {
      parseTextFrame('{"type":')
      throw new Error('expected a throw')
    } catch (error) {
      expect((error as FrameError).kind).toBe('malformed')
    }
  })

  it('round-trips a valid frame', () => {
    expect(parseTextFrame(JSON.stringify({ type: 'pakeB', pB: b32 }))).toEqual({
      type: 'pakeB',
      pB: b32,
    })
  })
})

describe('assertProtocolVersion (§11)', () => {
  it('accepts 1 and rejects anything else as unsupportedVersion', () => {
    expect(() => assertProtocolVersion(1)).not.toThrow()
    for (const version of [0, 2, 99]) {
      try {
        assertProtocolVersion(version)
        throw new Error('expected a throw')
      } catch (error) {
        // Distinct from `protocolViolation`: §11 gives a version mismatch its
        // own code, and collapsing the two loses the one thing the user can act
        // on.
        expect((error as FrameError).kind).toBe('unsupportedVersion')
      }
    }
  })

  it('parses a non-1 protocolVersion successfully so the version check can run', () => {
    // The schema deliberately does not pin `z.literal(1)`: a version-2 peer
    // must reach the version check, not be reported as a malformed frame.
    const frame = parseServerFrame({
      type: 'pairAccept',
      protocolVersion: 2,
      instanceId: 'inst',
    })
    expect(frame).toEqual({
      type: 'pairAccept',
      protocolVersion: 2,
      instanceId: 'inst',
    })
  })
})

describe('parseNmTicket', () => {
  const ticket = {
    v: 1,
    purpose: 'mbp1-attestation',
    protocolVersion: 1,
    serverGeneration: 'gen-1',
    browser: 'chromium',
    callerId: 'abc',
    exp: 1_755_600_000,
    bindingPub: b32,
    mac: b64uEncode(new Uint8Array(32).fill(3)),
  }

  it('decodes bindingPub and mac to raw bytes and keeps the rest parsed', () => {
    const parsed = parseNmTicket(ticket)
    expect(parsed.bindingPub).toEqual(new Uint8Array(32).fill(1))
    expect(parsed.mac).toEqual(new Uint8Array(32).fill(3))
    expect(parsed.purpose).toBe('mbp1-attestation')
    expect(parsed.exp).toBe(1_755_600_000)
  })

  it('rejects an extra property (strict) and a missing field', () => {
    expect(() => parseNmTicket({ ...ticket, extra: 1 })).toThrow(FrameError)
    const { mac: _mac, ...withoutMac } = ticket
    expect(() => parseNmTicket(withoutMac)).toThrow(FrameError)
  })

  it('rejects a non-object ticket', () => {
    for (const value of [null, 'ticket', 7, []]) {
      expect(() => parseNmTicket(value)).toThrow(FrameError)
    }
  })
})

describe('URLs (§4)', () => {
  it('builds /pair with only ?nonce=', () => {
    const url = pairUrl(16803, 'abc-123')
    expect(url).toBe('ws://127.0.0.1:16803/pair?nonce=abc-123')
    // Identity moved into `pairHello`; there is no `?token=` mode on `/pair`.
    expect(url).not.toMatch(/token=/)
    expect(url).not.toMatch(/extensionId=/)
  })

  it('percent-encodes a nonce with URL-significant characters', () => {
    expect(pairUrl(16803, 'a&b=c d')).toBe(
      'ws://127.0.0.1:16803/pair?nonce=a%26b%3Dc%20d'
    )
  })

  it('builds /v1 with no query credentials at all', () => {
    expect(reconnectUrl(16805)).toBe('ws://127.0.0.1:16805/v1')
  })
})

describe('MBP1_SUBPROTOCOL (§4)', () => {
  // Line A rejects the WebSocket upgrade with 401, before the route is even
  // examined, if the offered protocol list omits this exact string — so a
  // wrong value breaks every MBP1 connection with no diagnosable signal.
  // Every prior test that touched this constant compared it against itself
  // (a tautology); this is the one place that pins the literal.
  it('is exactly "motrix-bridge.v1"', () => {
    expect(MBP1_SUBPROTOCOL).toBe('motrix-bridge.v1')
  })
})
