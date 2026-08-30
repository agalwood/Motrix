import { describe, expect, it } from 'vitest'
import { bytesToHex, hexToBytes, loadMbp1Vectors } from './__tests__/vectors'
import { buildAad, buildAId, buildBId, ticketDigest } from './transcript'

const v = loadMbp1Vectors()
const v0 = v.spake2[0]
const v1 = v.spake2[1]

describe('identities (§6.4)', () => {
  it('reproduces A_id from the pairHello fields', () => {
    const aId = buildAId({
      browser: v0.inputs.browser,
      verifiedOrigin: v0.inputs.verifiedOrigin,
      claimedExtensionId: v0.inputs.claimedExtensionId,
      clientInstallationId: v0.inputs.clientInstallationId,
    })
    expect(bytesToHex(aId)).toBe(v0.intermediate.aId)
  })

  it('reproduces B_id from the instance id', () => {
    const bId = buildBId(v0.inputs.instanceId)
    expect(bytesToHex(bId)).toBe(v0.intermediate.bId)
  })
})

describe('ticketDigest (§6.4)', () => {
  it('reproduces the ticket digest over the wire purpose string, not a fixed domain tag', () => {
    const digest = ticketDigest({
      v: v.nmTicket.inputs.v,
      purpose: 'mbp1-attestation',
      protocolVersion: 1,
      serverGeneration: v.nmTicket.inputs.serverGeneration,
      browser: v.nmTicket.inputs.browser,
      callerId: v.nmTicket.inputs.callerId,
      exp: v.nmTicket.inputs.exp,
      bindingPub: hexToBytes(v.nmTicket.inputs.bindingPub),
      mac: hexToBytes(v.nmTicket.expected.mac),
    })
    expect(bytesToHex(digest)).toBe(v.nmTicket.expected.ticketDigest)
    expect(bytesToHex(digest)).toBe(v0.intermediate.ticketDigest)
  })

  it('changes when the wire purpose string flips (not hashing the fixed MAC domain tag)', () => {
    const digest = ticketDigest({
      v: v.nmTicket.inputs.v,
      purpose: 'something-else',
      protocolVersion: 1,
      serverGeneration: v.nmTicket.inputs.serverGeneration,
      browser: v.nmTicket.inputs.browser,
      callerId: v.nmTicket.inputs.callerId,
      exp: v.nmTicket.inputs.exp,
      bindingPub: hexToBytes(v.nmTicket.inputs.bindingPub),
      mac: hexToBytes(v.nmTicket.expected.mac),
    })
    expect(bytesToHex(digest)).not.toBe(v.nmTicket.expected.ticketDigest)
  })
})

describe('AAD (§6.4)', () => {
  it('reproduces the ticketed AAD', () => {
    const aad = buildAad(
      1,
      v0.inputs.pairNonce,
      hexToBytes(v0.intermediate.bindingPub),
      hexToBytes(v0.intermediate.ticketDigest)
    )
    expect(bytesToHex(aad)).toBe(v0.intermediate.aad)
  })

  it('reproduces the ticketless AAD with empty enc("") slots', () => {
    const aad = buildAad(1, v0.inputs.pairNonce, null, null)
    expect(bytesToHex(aad)).toBe(v1.intermediate.aad)
  })
})
