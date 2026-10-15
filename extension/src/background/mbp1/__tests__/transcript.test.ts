import { describe, expect, it } from 'vitest'
import { MBP1_VECTORS } from '@/background/mbp1/__fixtures__/vectors'
import {
  buildAad,
  buildAId,
  buildBId,
  type ParsedTicket,
  ticketDigest,
} from '@/background/mbp1/transcript'

const hex = (b: Uint8Array) => Buffer.from(b).toString('hex')
const fromHex = (s: string) => Uint8Array.from(Buffer.from(s, 'hex'))

describe('buildAId / buildBId (§6.4)', () => {
  it('builds A_id/B_id matching the vector', () => {
    const v = MBP1_VECTORS.spake2[0]
    if (!v?.inputs || !v.intermediate)
      throw new Error('vector 0 missing fields')
    const { inputs, intermediate } = v
    expect(
      hex(
        buildAId({
          browser: inputs.browser ?? '',
          verifiedOrigin: inputs.verifiedOrigin ?? '',
          claimedExtensionId: inputs.claimedExtensionId ?? '',
          clientInstallationId: inputs.clientInstallationId ?? '',
        })
      )
    ).toBe(intermediate.aId)
    expect(hex(buildBId(inputs.instanceId ?? ''))).toBe(intermediate.bId)
  })
})

/**
 * The `nmTicket` vector's fields ARE the ticket presented in `spake2[0]`
 * (same `bindingPub`, `browser`, `callerId` == `claimedExtensionId`, and
 * `nmTicket.expected.ticketDigest` == `spake2[0].intermediate.ticketDigest`)
 * — confirmed against the raw vector file before writing this helper, not
 * derived from `ticketDigest` itself.
 */
function nmTicketAsParsed(): ParsedTicket {
  const { inputs, expected } = MBP1_VECTORS.nmTicket
  const { v, serverGeneration, browser, callerId, exp, bindingPub } = inputs
  if (
    typeof v !== 'number' ||
    typeof serverGeneration !== 'string' ||
    typeof browser !== 'string' ||
    typeof callerId !== 'string' ||
    typeof exp !== 'number' ||
    typeof bindingPub !== 'string'
  ) {
    throw new Error('nmTicket vector missing fields')
  }
  return {
    v,
    // The wire `purpose` value, distinct from §9.2's fixed MAC domain tag —
    // in this vector the two happen to be the same literal (see the test
    // below for why that coincidence matters).
    purpose: 'mbp1-attestation',
    protocolVersion: 1,
    serverGeneration,
    browser,
    callerId,
    exp,
    bindingPub: fromHex(bindingPub),
    mac: fromHex(expected.mac),
  }
}

describe('ticketDigest (§6.4, cross-checked against §9.2)', () => {
  it('matches the nmTicket vector', () => {
    const digest = ticketDigest(nmTicketAsParsed())
    expect(hex(digest)).toBe(MBP1_VECTORS.nmTicket.expected.ticketDigest)
  })

  // The subtlest requirement in this protocol: §6.4's ticketDigest hashes
  // the wire `purpose` string, while §9.2's ticket MAC hashes a fixed
  // domain tag ("mbp1-attestation") instead of `purpose`. In this vector
  // `purpose` happens to equal that literal tag, so the vector alone cannot
  // tell the two constructions apart -- a construction that hashed the tag
  // (instead of the parsed `purpose` field) would reproduce
  // `nmTicket.expected.ticketDigest` exactly and still be wrong: it would
  // fail to move when `purpose` is tampered, defeating §6.4's requirement
  // that flipping ANY wire field changes the digest. This test proves the
  // distinction directly, by tampering `purpose` and requiring the digest
  // to move.
  it('changes when purpose is tampered, proving it hashes purpose (not a fixed tag)', () => {
    const base = nmTicketAsParsed()
    const tampered: ParsedTicket = { ...base, purpose: 'not-the-real-purpose' }
    expect(hex(ticketDigest(tampered))).not.toBe(hex(ticketDigest(base)))
    expect(hex(ticketDigest(base))).toBe(
      MBP1_VECTORS.nmTicket.expected.ticketDigest
    )
  })
})

describe('buildAad (§6.4)', () => {
  it('matches the ticketed variant (spake2[0])', () => {
    const v0 = MBP1_VECTORS.spake2[0]
    if (!v0?.inputs || !v0.intermediate)
      throw new Error('vector 0 missing fields')
    const aad = buildAad({
      protocolVersion: 1,
      pairNonce: v0.inputs.pairNonce ?? '',
      ticketBindingKey: fromHex(v0.intermediate.bindingPub),
      ticket: nmTicketAsParsed(),
    })
    expect(hex(aad)).toBe(v0.intermediate.aad)
  })

  it('matches the ticketless variant (spake2[1])', () => {
    const v0 = MBP1_VECTORS.spake2[0]
    const v1 = MBP1_VECTORS.spake2[1]
    if (!v0?.inputs || !v1?.intermediate)
      throw new Error('vector missing fields')
    const aad = buildAad({
      protocolVersion: 1,
      // Vector 1 is vector 0 with the ticket absent; its `inputs` only
      // records that fact, so the shared `pairNonce` comes from vector 0.
      pairNonce: v0.inputs.pairNonce ?? '',
      ticketBindingKey: null,
      ticket: null,
    })
    expect(hex(aad)).toBe(v1.intermediate.aad)
  })
})
