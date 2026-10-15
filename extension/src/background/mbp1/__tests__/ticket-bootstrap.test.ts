import { ed25519 } from '@noble/curves/ed25519.js'
import { describe, expect, it } from 'vitest'
import { b64uDecode, concatBytes, utf8 } from '@/background/mbp1/canonical'
import {
  buildBootstrapRequest,
  generateBindingKeypair,
  signTicketProof,
} from '@/background/mbp1/ticket-bootstrap'

describe('MBP1 NM bootstrap (§9.1)', () => {
  it('generates a 32-byte Ed25519 keypair whose pub matches priv', () => {
    const kp = generateBindingKeypair()
    expect(kp.priv.length).toBe(32)
    expect(kp.pub.length).toBe(32)
    expect(ed25519.getPublicKey(kp.priv)).toEqual(kp.pub)
  })

  it('generates a fresh keypair on every call', () => {
    const a = generateBindingKeypair()
    const b = generateBindingKeypair()
    expect(a.priv).not.toEqual(b.priv)
    expect(a.pub).not.toEqual(b.pub)
  })

  it('builds the wire-shaped bootstrap request with a literal allowLaunch', () => {
    const kp = generateBindingKeypair()
    const request = buildBootstrapRequest(kp.pub, true)
    expect(request).toEqual({
      action: 'bootstrap',
      protocolVersion: 1,
      bindingPub: expect.any(String),
      allowLaunch: true,
    })
    // Line A's NM host only wakes Motrix when this field is literally `true`,
    // so assert the exact primitive rather than a truthy value.
    expect(request.allowLaunch).toBe(true)
    expect(b64uDecode(request.bindingPub)).toEqual(kp.pub)
  })

  it('carries allowLaunch: false through instead of forcing a wake', () => {
    // The field is the caller's decision, not a constant. Hardcoding `true`
    // would have made every background liveness probe launch the desktop app
    // once the discovery chain wired this up — exactly what the flag prevents.
    const kp = generateBindingKeypair()
    const request = buildBootstrapRequest(kp.pub, false)
    expect(request.allowLaunch).toBe(false)
    // Present and explicit, never omitted: the host reads a missing field as
    // "do not wake", but an omitted field also loses the caller's intent.
    expect('allowLaunch' in request).toBe(true)
  })

  it('signs ticketProof over the domain-tagged transcript, verifiable with strict rules', () => {
    const kp = generateBindingKeypair()
    const TT = new Uint8Array([1, 2, 3, 4])
    const sig = signTicketProof(kp.priv, TT)
    expect(sig.length).toBe(64)
    const msg = concatBytes(utf8('MBP1/ticket-proof/v1'), TT)
    expect(ed25519.verify(sig, msg, kp.pub, { zip215: false })).toBe(true)
  })

  it('does not verify against TT alone, without the domain-separation label', () => {
    const kp = generateBindingKeypair()
    const TT = new Uint8Array([1, 2, 3, 4])
    const sig = signTicketProof(kp.priv, TT)
    // Proves the signed message really is label ‖ TT, not TT by itself —
    // a signature that verified against bare TT would mean the domain tag
    // was dropped.
    expect(ed25519.verify(sig, TT, kp.pub, { zip215: false })).toBe(false)
  })

  it('does not verify against a different TT', () => {
    const kp = generateBindingKeypair()
    const TT = new Uint8Array([1, 2, 3, 4])
    const otherTT = new Uint8Array([1, 2, 3, 5])
    const sig = signTicketProof(kp.priv, TT)
    const otherMsg = concatBytes(utf8('MBP1/ticket-proof/v1'), otherTT)
    expect(ed25519.verify(sig, otherMsg, kp.pub, { zip215: false })).toBe(false)
  })

  it('does not verify against a different binding key', () => {
    const kp = generateBindingKeypair()
    const other = generateBindingKeypair()
    const TT = new Uint8Array([1, 2, 3, 4])
    const sig = signTicketProof(kp.priv, TT)
    const msg = concatBytes(utf8('MBP1/ticket-proof/v1'), TT)
    expect(ed25519.verify(sig, msg, other.pub, { zip215: false })).toBe(false)
  })
})
