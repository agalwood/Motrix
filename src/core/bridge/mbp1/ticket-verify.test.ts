import { ed25519 } from '@noble/curves/ed25519.js'
import { utf8ToBytes } from '@noble/hashes/utils.js'
import { describe, expect, it } from 'vitest'
import { bytesToHex, hexToBytes, loadMbp1Vectors } from './__tests__/vectors'
import { hmacSha256, toBase64Url } from './canonical'
import type { TicketContext } from './ticket-verify'
import {
  deriveTicketKey,
  MAX_REMAINING_LIFETIME_MS,
  TicketReplayCache,
  ticketMacInput,
  validateBindingPub,
  verifyNmTicket,
  verifyTicketProofStrict,
} from './ticket-verify'

const v = loadMbp1Vectors()
const { inputs, expected, mustReject } = v.nmTicket

const ticketKey = deriveTicketKey(inputs.localToken)
const vectorBindingPub = hexToBytes(inputs.bindingPub)

/** The MAC-covered field set of a ticket, in parsed (not wire) form. */
interface TicketFields {
  v: number
  purpose: string
  protocolVersion: number
  serverGeneration: string
  browser: string
  callerId: string
  exp: number
  bindingPub: Uint8Array
}

const BASE: TicketFields = {
  v: inputs.v,
  purpose: 'mbp1-attestation',
  protocolVersion: 1,
  serverGeneration: inputs.serverGeneration,
  browser: inputs.browser,
  callerId: inputs.callerId,
  exp: inputs.exp,
  bindingPub: vectorBindingPub,
}

/**
 * Builds a wire ticket carrying a MAC that is *valid* under the vector
 * `localToken`. Re-minting matters for every §9.2 row below the MAC row: the
 * MAC covers `v`, `protocolVersion`, `serverGeneration`, `browser`,
 * `callerId`, `exp`, and `bindingPub`, so tampering one of those without
 * re-minting would stop at the MAC row and prove nothing about the row the
 * test is aiming at. `deriveTicketKey`/`ticketMacInput` are pinned to the
 * normative vector by the first describe block before being used this way.
 */
function minted(over: Partial<TicketFields> = {}): Record<string, unknown> {
  const t = { ...BASE, ...over }
  return {
    ...t,
    bindingPub: toBase64Url(t.bindingPub),
    mac: toBase64Url(hmacSha256(ticketKey, ticketMacInput(t))),
  }
}

function ctx(over: Partial<TicketContext> = {}): TicketContext {
  return {
    localToken: inputs.localToken,
    serverGeneration: inputs.serverGeneration,
    nowMs: (inputs.exp - 30) * 1000,
    helloBrowser: inputs.browser,
    helloClaimedExtensionId: inputs.callerId,
    helloTicketBindingKey: vectorBindingPub,
    replay: new TicketReplayCache(),
    ...over,
  }
}

const smallOrderBindingPubs = mustReject[0].bindingPub as string[]
const dirtyBindingPub = mustReject[1].bindingPub as string
const identityBindingPub = mustReject[2].bindingPub as string
const identityForgerySig = mustReject[2].signature as string
const sigWithLargeS = mustReject[3].signature as string
const sigWithNonCanonicalR = mustReject[4].signature as string

describe('ticketKey and canonical MAC input (§9.2)', () => {
  it('derives ticketKey from localToken alone', () => {
    expect(bytesToHex(ticketKey)).toBe(expected.ticketKey)
  })

  it('reproduces the canonical MAC input', () => {
    expect(bytesToHex(ticketMacInput(BASE))).toBe(expected.canonical)
  })

  it('reproduces the ticket mac', () => {
    expect(bytesToHex(hmacSha256(ticketKey, ticketMacInput(BASE)))).toBe(
      expected.mac
    )
  })

  it('mints the vector mac, so re-minted tampered tickets are trustworthy', () => {
    expect(minted().mac).toBe(toBase64Url(hexToBytes(expected.mac)))
  })

  it('leads with the fixed domain tag, not the wire purpose (§9.2 vs §6.4)', () => {
    const other = ticketMacInput({ ...BASE, purpose: 'other' })
    expect(bytesToHex(other)).toBe(expected.canonical)
  })
})

describe('bindingPub validation (§9.1)', () => {
  it('accepts the vector binding key', () => {
    expect(validateBindingPub(vectorBindingPub)).toBe(true)
  })

  it.each(smallOrderBindingPubs)(
    'rejects the small-order encoding %s',
    (hex) => {
      expect(validateBindingPub(hexToBytes(hex))).toBe(false)
    }
  )

  it('rejects a dirty (non-torsion-free) point', () => {
    expect(validateBindingPub(hexToBytes(dirtyBindingPub))).toBe(false)
  })

  it('rejects a non-canonical encoding (y = p)', () => {
    expect(
      validateBindingPub(
        hexToBytes(
          'edffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f'
        )
      )
    ).toBe(false)
  })

  it('rejects a point that is not on the curve', () => {
    expect(
      validateBindingPub(
        hexToBytes(
          '0200000000000000000000000000000000000000000000000000000000000000'
        )
      )
    ).toBe(false)
  })

  it('rejects a key that is not 32 bytes', () => {
    expect(validateBindingPub(vectorBindingPub.subarray(0, 31))).toBe(false)
  })
})

describe('verifyNmTicket — valid ticket (§9.2)', () => {
  it('attests the ticket callerId and defers the §6.5 proof', () => {
    expect(verifyNmTicket(minted(), ctx())).toEqual({
      kind: 'attested',
      callerId: inputs.callerId,
      deferredProof: { bindingPub: vectorBindingPub },
    })
  })

  it('accepts a remaining lifetime of exactly 60 s', () => {
    const verdict = verifyNmTicket(
      minted(),
      ctx({ nowMs: (inputs.exp - 60) * 1000 })
    )
    expect(verdict.kind).toBe('attested')
  })
})

describe('verifyNmTicket — abort rows (§9.2)', () => {
  it('aborts when the mac fails constant-time recompute', () => {
    const wire = minted()
    const mac = hexToBytes(expected.mac)
    mac[0] ^= 0x01
    expect(verifyNmTicket({ ...wire, mac: toBase64Url(mac) }, ctx())).toEqual({
      kind: 'abort',
      reason: 'macMismatch',
    })
  })

  it('aborts when the mac has the wrong length', () => {
    const wire = minted()
    const short = hexToBytes(expected.mac).subarray(0, 31)
    expect(verifyNmTicket({ ...wire, mac: toBase64Url(short) }, ctx())).toEqual(
      { kind: 'abort', reason: 'macMismatch' }
    )
  })

  it('aborts when v is not exactly 1', () => {
    expect(verifyNmTicket(minted({ v: 2 }), ctx())).toEqual({
      kind: 'abort',
      reason: 'formatMismatch',
    })
  })

  it('aborts when purpose is not exactly "mbp1-attestation"', () => {
    expect(verifyNmTicket(minted({ purpose: 'other' }), ctx())).toEqual({
      kind: 'abort',
      reason: 'formatMismatch',
    })
  })

  it('aborts when protocolVersion is not exactly 1', () => {
    expect(verifyNmTicket(minted({ protocolVersion: 2 }), ctx())).toEqual({
      kind: 'abort',
      reason: 'formatMismatch',
    })
  })

  it.each(smallOrderBindingPubs)(
    'aborts on the small-order bindingPub %s',
    (hex) => {
      const bindingPub = hexToBytes(hex)
      expect(
        verifyNmTicket(
          minted({ bindingPub }),
          ctx({ helloTicketBindingKey: bindingPub })
        )
      ).toEqual({ kind: 'abort', reason: 'bindingKeyInvalid' })
    }
  )

  it('aborts on a dirty (non-torsion-free) bindingPub', () => {
    const bindingPub = hexToBytes(dirtyBindingPub)
    expect(
      verifyNmTicket(
        minted({ bindingPub }),
        ctx({ helloTicketBindingKey: bindingPub })
      )
    ).toEqual({ kind: 'abort', reason: 'bindingKeyInvalid' })
  })

  it('aborts when bindingPub differs from pairHello.ticketBindingKey', () => {
    const otherKey = ed25519.getPublicKey(hexToBytes(expected.ticketKey))
    expect(
      verifyNmTicket(minted(), ctx({ helloTicketBindingKey: otherKey }))
    ).toEqual({ kind: 'abort', reason: 'bindingKeyMismatch' })
  })

  it('aborts when pairHello carried no ticketBindingKey', () => {
    expect(
      verifyNmTicket(minted(), ctx({ helloTicketBindingKey: null }))
    ).toEqual({ kind: 'abort', reason: 'bindingKeyMismatch' })
  })

  it('aborts when callerId differs from pairHello.claimedExtensionId', () => {
    expect(verifyNmTicket(minted({ callerId: 'a'.repeat(32) }), ctx())).toEqual(
      { kind: 'abort', reason: 'callerIdMismatch' }
    )
  })

  it('aborts when nmTicket.browser differs from pairHello.browser', () => {
    expect(verifyNmTicket(minted({ browser: 'firefox' }), ctx())).toEqual({
      kind: 'abort',
      reason: 'browserMismatch',
    })
  })

  it('aborts on a replayed ticket mac (one-shot)', () => {
    const shared = ctx()
    expect(verifyNmTicket(minted(), shared).kind).toBe('attested')
    expect(verifyNmTicket(minted(), shared)).toEqual({
      kind: 'abort',
      reason: 'replayed',
    })
  })

  it('aborts when the remaining lifetime exceeds 60 s', () => {
    expect(
      verifyNmTicket(minted(), ctx({ nowMs: (inputs.exp - 3600) * 1000 }))
    ).toEqual({ kind: 'abort', reason: 'expTooFar' })
  })

  it('aborts on a structurally invalid wire object', () => {
    expect(verifyNmTicket({ v: 1 }, ctx())).toEqual({
      kind: 'abort',
      reason: 'schema',
    })
    expect(verifyNmTicket(null, ctx())).toEqual({
      kind: 'abort',
      reason: 'schema',
    })
  })

  it('aborts on an unknown wire field, which no MAC or digest covers', () => {
    expect(verifyNmTicket({ ...minted(), extra: 1 }, ctx())).toEqual({
      kind: 'abort',
      reason: 'schema',
    })
  })

  it('aborts on a non-ASCII string field (§2)', () => {
    const wire = { ...minted(), callerId: 'ibpkjhgpbidfmbmomagmldcdlpbmchgé' }
    expect(verifyNmTicket(wire, ctx())).toEqual({
      kind: 'abort',
      reason: 'schema',
    })
  })

  it('aborts on padded (non-canonical) base64url ticket bytes', () => {
    const wire = minted()
    expect(
      verifyNmTicket(
        { ...wire, bindingPub: `${wire.bindingPub as string}=` },
        ctx()
      )
    ).toEqual({ kind: 'abort', reason: 'schema' })
  })
})

describe('verifyNmTicket — downgrade rows (§9.2)', () => {
  it('downgrades an authentic ticket from an unknown server generation', () => {
    expect(
      verifyNmTicket(
        minted(),
        ctx({ serverGeneration: '00000000-0000-4000-8000-000000000000' })
      )
    ).toEqual({
      kind: 'downgrade',
      reason: 'unknownGeneration',
      deferredProof: { bindingPub: vectorBindingPub },
    })
  })

  it('downgrades an authentic ticket that has expired', () => {
    expect(
      verifyNmTicket(minted(), ctx({ nowMs: (inputs.exp + 1) * 1000 }))
    ).toEqual({
      kind: 'downgrade',
      reason: 'expired',
      deferredProof: { bindingPub: vectorBindingPub },
    })
  })

  it('aborts rather than downgrades when a stale generation also has a bad mac', () => {
    const wire = minted()
    const mac = hexToBytes(expected.mac)
    mac[31] ^= 0x80
    expect(
      verifyNmTicket(
        { ...wire, mac: toBase64Url(mac) },
        ctx({ serverGeneration: '00000000-0000-4000-8000-000000000000' })
      )
    ).toEqual({ kind: 'abort', reason: 'macMismatch' })
  })
})

describe('verifyNmTicket — identity rows (§5)', () => {
  // This module proves *which* extension called; §5 leaves the official vs
  // attested-non-official split to the immutable allowlist, which the pairing
  // wiring owns. These two rows assert that the attested verdict carries the
  // MAC-covered ticket `callerId` — the value that allowlist lookup consumes.
  it('yields a callerId that resolves to official when allowlisted', () => {
    const verdict = verifyNmTicket(minted(), ctx())
    expect(verdict).toMatchObject({ kind: 'attested' })
    const allowlist = [inputs.callerId]
    expect(
      verdict.kind === 'attested' && allowlist.includes(verdict.callerId)
    ).toBe(true)
  })

  it('yields a callerId that resolves to attested-non-official otherwise', () => {
    const verdict = verifyNmTicket(minted(), ctx())
    expect(verdict).toMatchObject({ kind: 'attested' })
    const allowlist = ['b'.repeat(32)]
    expect(
      verdict.kind === 'attested' && allowlist.includes(verdict.callerId)
    ).toBe(false)
  })
})

describe('deferred ticketProof verification (§6.5, §9.1)', () => {
  const tt = hexToBytes(v.spake2[0].expected.TT)
  const proof = hexToBytes(v.spake2[0].expected.ticketProof as string)

  it('accepts the vector proof under the vector bindingPub', () => {
    expect(verifyTicketProofStrict(vectorBindingPub, tt, proof)).toBe(true)
  })

  it('rejects a proof over a different transcript', () => {
    const other = Uint8Array.from(tt)
    other[0] ^= 0x01
    expect(verifyTicketProofStrict(vectorBindingPub, other, proof)).toBe(false)
  })

  it('stops the (identity ‖ 0) forgery at the key check, before verification', () => {
    expect(validateBindingPub(hexToBytes(identityBindingPub))).toBe(false)
  })

  it('also rejects the (identity ‖ 0) forgery in strict mode (zip215:false)', () => {
    // noble's own default is the permissive zip215:true, which accepts this
    // signature for every message. This is the only vector input that tells
    // the two modes apart, so it is the regression guard for the option.
    expect(
      verifyTicketProofStrict(
        hexToBytes(identityBindingPub),
        tt,
        hexToBytes(identityForgerySig)
      )
    ).toBe(false)
  })

  it('rejects S >= ell under RFC 8032 strict mode', () => {
    expect(
      verifyTicketProofStrict(vectorBindingPub, tt, hexToBytes(sigWithLargeS))
    ).toBe(false)
  })

  it('rejects a non-canonical R encoding under RFC 8032 strict mode', () => {
    expect(
      verifyTicketProofStrict(
        vectorBindingPub,
        tt,
        hexToBytes(sigWithNonCanonicalR)
      )
    ).toBe(false)
  })

  it('returns false instead of throwing on a signature that is not 64 bytes', () => {
    expect(
      verifyTicketProofStrict(vectorBindingPub, tt, proof.subarray(0, 63))
    ).toBe(false)
  })

  it('binds the proof to the "MBP1/ticket-proof/v1" label', () => {
    const seed = hexToBytes(v.spake2[0].inputs.bindingSeed)
    const unlabelled = ed25519.sign(tt, seed)
    expect(verifyTicketProofStrict(vectorBindingPub, tt, unlabelled)).toBe(
      false
    )
    const labelled = ed25519.sign(
      new Uint8Array([...utf8ToBytes('MBP1/ticket-proof/v1'), ...tt]),
      seed
    )
    expect(bytesToHex(labelled)).toBe(v.spake2[0].expected.ticketProof)
  })
})

describe('TicketReplayCache', () => {
  it('remembers a mac until it is pruned past its exp', () => {
    const cache = new TicketReplayCache()
    const key = toBase64Url(hexToBytes(expected.mac))
    cache.add(key, inputs.exp * 1000, inputs.exp * 1000 - 1000)
    expect(cache.has(key)).toBe(true)
    cache.prune(inputs.exp * 1000 - 1)
    expect(cache.has(key)).toBe(true)
    cache.prune(inputs.exp * 1000)
    expect(cache.has(key)).toBe(false)
  })

  it('clamps retention so a far-future exp cannot pin an entry forever', () => {
    // `add` runs before the `expTooFar` row, so an absurd `exp` from a host
    // holding `localToken` would otherwise leave an entry `prune` never drops.
    const cache = new TicketReplayCache()
    const key = toBase64Url(hexToBytes(expected.mac))
    const now = 1_000_000
    cache.add(key, now + 100 * 365 * 24 * 3600 * 1000, now)

    expect(cache.has(key)).toBe(true)
    cache.prune(now + MAX_REMAINING_LIFETIME_MS - 1)
    expect(cache.has(key)).toBe(true)
    cache.prune(now + MAX_REMAINING_LIFETIME_MS)
    expect(cache.has(key)).toBe(false)
  })

  it('still honours an exp nearer than the clamp', () => {
    const cache = new TicketReplayCache()
    const key = toBase64Url(hexToBytes(expected.mac))
    const now = 1_000_000
    cache.add(key, now + 5_000, now)

    cache.prune(now + 5_000)
    expect(cache.has(key)).toBe(false)
  })

  it('cannot raise identity by replaying a ticket whose entry was pruned', () => {
    const shared = ctx()
    expect(verifyNmTicket(minted(), shared).kind).toBe('attested')
    const later = { ...shared, nowMs: (inputs.exp + 1) * 1000 }
    expect(verifyNmTicket(minted(), later)).toMatchObject({
      kind: 'downgrade',
      reason: 'expired',
    })
  })
})
