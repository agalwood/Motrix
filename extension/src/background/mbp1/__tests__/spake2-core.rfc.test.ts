import { sha256 } from '@noble/hashes/sha2.js'
import { describe, expect, it } from 'vitest'
import { RFC9382_P256_VECTORS } from '@/background/mbp1/__fixtures__/vectors'
import { concatBytes, enc, utf8 } from '@/background/mbp1/canonical'
import { P256_GROUP, spake2Run } from '@/background/mbp1/spake2-core'

const hex = (b: Uint8Array) => Buffer.from(b).toString('hex')
const fromHex = (s: string) => Uint8Array.from(Buffer.from(s, 'hex'))

/**
 * `docs/bridge-pairing-protocol.md` §13 requires the group-generic SPAKE2
 * core to reproduce all four RFC 9382 Appendix B P-256 vectors *before* the
 * edwards25519 instantiation MBP1 actually uses (`ED25519_GROUP`, tested in
 * `spake2-core.mbp1.test.ts`) is trusted — passing only self-generated MBP1
 * vectors would prove nothing about the composition, since a
 * wrong-but-self-consistent implementation reproduces its own vectors
 * happily. `../__fixtures__/rfc9382-p256-vectors.json` carries every field
 * of those four vectors *except* `TT`: RFC 9382 does not print a `TT` field
 * directly on the wire, and this suite deliberately declines to fabricate one
 * rather than deriving it from spake2-core.ts itself, which would make this
 * gate circular (the whole point of these vectors is to prove the
 * transcript layout independently of this repository's code).
 *
 * `RFC_TT` below is transcribed directly from the RFC 9382 text
 * (https://www.rfc-editor.org/rfc/rfc9382.txt, Appendix B). The RFC
 * line-wraps each hex value across several source lines; those wrapped
 * lines were concatenated programmatically (a small throwaway script
 * parsing the fetched RFC text, not by hand — hand-splitting a long hex
 * string into `+`-joined line fragments is exactly how a stray or missing
 * byte pair goes unnoticed) and each `TT` below is pasted as a single
 * unbroken literal for that reason. It is verified two ways *before* it is
 * ever compared against this module's output, neither of which touches
 * spake2-core.ts:
 *
 *   1. `SHA-256(TT)` must equal `Ke || Ka`, which the RFC also prints
 *      separately as `Hash(TT)` — see the first `describe` block below.
 *   2. Each `TT` must reconstruct as
 *      `enc(A) || enc(B) || enc(pA) || enc(pB) || enc(K) || enc(I2OSP(w,32))`
 *      from that same vector's own `A`/`B`/`pA`/`pB`/`K`/`w` fields, using
 *      only `canonical.ts`'s already-independently-tested `enc`/
 *      `concatBytes` — never spake2-core.ts's own encoding logic. (RFC 9382
 *      §4 confirms `AAD` — and therefore the `"ConfirmationKeys" || AAD`
 *      info string used below in the gate itself — is nil when the
 *      Appendix B vectors don't state one; this transcript check does not
 *      involve AAD at all.)
 *
 * Both checks passed for all four vectors (recorded here, not just run
 * ad hoc) before this file's vector-reproduction assertions were written.
 */
const RFC_TT: readonly string[] = [
  // A='server', B='client'
  '06000000000000007365727665720600000000000000636c69656e74410000000000000004a56fa807caaa53a4d28dbb9853b9815c61a411118a6fe516a8798434751470f9010153ac33d0d5f2047ffdb1a3e42c9b4e6be662766e1eeb4116988ede5f912c41000000000000000406557e482bd03097ad0cbaa5df82115460d951e3451962f1eaf4367a420676d09857ccbc522686c83d1852abfa8ed6e4a1155cf8f1543ceca528afb591a1e0b741000000000000000412af7e89717850671913e6b469ace67bd90a4df8ce45c2af19010175e37eed69f75897996d539356e2fa6a406d528501f907e04d97515fbe83db277b715d332520000000000000002ee57912099d31560b3a44b1184b9b4866e904c49d12ac5042c97dca461b1a5f',
  // A='', B='client'
  '00000000000000000600000000000000636c69656e74410000000000000004a897b769e681c62ac1c2357319a3d363f610839c4477720d24cbe32f5fd85f44fb92ba966578c1b712be6962498834078262caa5b441ecfa9d4a9485720e918a410000000000000004e0f816fd1c35e22065d5556215c097e799390d16661c386e0ecc84593974a61b881a8c82327687d0501862970c64565560cb5671f696048050ca66ca5f8cc7fc4100000000000000048f83ec9f6e4f87cc6f9dc740bdc2769725f923364f01c84148c049a39a735ebda82eac03e00112fd6a5710682767cff5361f7e819e53d8d3c3a2922e0d837aa620000000000000000548d8729f730589e579b0475a582c1608138ddf7054b73b5381c7e883e2efae',
  // A='server', B=''
  '06000000000000007365727665720000000000000000410000000000000004f88fb71c99bfffaea370966b7eb99cd4be0ff1a7d335caac4211c4afd855e2e15a873b298503ad8ba1d9cbb9a392d2ba309b48bfd7879aefd0f2cea6009763b04100000000000000040c269d6be017dccb15182ac6bfcd9e2a14de019dd587eaf4bdfd353f031101e7cca177f8eb362a6e83e7d5e729c0732e1b528879c086f39ba0f31a9661bd34db41000000000000000445ee233b8ecb51ebd6e7da3f307e88a1616bae2166121221fdc0dadb986afaf3ec8a988dc9c626fa3b99f58a7ca7c9b844bb3e8dd9554aafc5b53813504c1cbe2000000000000000626e0cdc7b14c9db3e52a0b1b3a768c98e37852d5db30febe0497b14eae8c254',
  // A='', B=''
  '00000000000000000000000000000000410000000000000004a65b367a3f613cf9f0654b1b28a1e3a8a40387956c8ba6063e8658563890f46ca1ef6a676598889fc28de2950ab8120b79a5ef1ea4c9f44bc98f585634b46d66410000000000000004589f13218822710d98d8b2123a079041052d9941b9cf88c6617ddb2fcc0494662eea8ba6b64692dc318250030c6af045cb738bc81ba35b043c3dcb46adf6f58d4100000000000000041a3c03d51b452537ca2a1fea6110353c6d5ed483c4f0f86f4492ca3f378d40a994b4477f93c64d928edbbcd3e85a7c709b7ea73ee97986ce3d1438e13554377220000000000000007bf46c454b4c1b25799527d896508afd5fc62ef4ec59db1efb49113063d70cca',
]

describe('RFC 9382 Appendix B transcript transcription is verified, not derived', () => {
  it('carries all four published vectors (§13 requires all four)', () => {
    expect(RFC9382_P256_VECTORS).toHaveLength(4)
    expect(RFC_TT).toHaveLength(4)
  })

  it.each(RFC9382_P256_VECTORS.map((v, i) => [v, RFC_TT[i]] as const))(
    'transcribed TT for vector %#: SHA-256(TT) equals the RFC-printed Ke || Ka',
    (v, tt) => {
      if (tt === undefined) throw new Error('missing transcribed TT')
      const digest = sha256(fromHex(tt))
      const keKa = concatBytes(fromHex(v.Ke), fromHex(v.Ka))
      expect(hex(digest)).toBe(hex(keKa))
    }
  )

  it.each(RFC9382_P256_VECTORS.map((v, i) => [v, RFC_TT[i]] as const))(
    'transcribed TT for vector %#: reconstructs from A/B/pA/pB/K/w via canonical.ts enc()',
    (v, tt) => {
      if (tt === undefined) throw new Error('missing transcribed TT')
      const reconstructed = concatBytes(
        enc(v.A),
        enc(v.B),
        enc(fromHex(v.pA)),
        enc(fromHex(v.pB)),
        enc(fromHex(v.K)),
        enc(fromHex(v.w))
      )
      expect(hex(reconstructed)).toBe(tt)
    }
  )
})

describe('SPAKE2 core — RFC 9382 Appendix B P-256 gate (§13)', () => {
  it.each(RFC9382_P256_VECTORS.map((v, i) => [v, RFC_TT[i]] as const))(
    'reproduces RFC 9382 P-256 vector %#',
    (v, tt) => {
      if (tt === undefined) throw new Error('missing transcribed TT')
      const r = spake2Run(P256_GROUP, {
        aId: utf8(v.A),
        bId: utf8(v.B),
        w: BigInt(`0x${v.w}`),
        x: BigInt(`0x${v.x}`),
        y: BigInt(`0x${v.y}`),
        aad: new Uint8Array(0),
      })
      expect(hex(r.pA)).toBe(v.pA)
      expect(hex(r.pB)).toBe(v.pB)
      expect(hex(r.K)).toBe(v.K)
      expect(hex(r.TT)).toBe(tt)
      expect(hex(r.Ke)).toBe(v.Ke)
      expect(hex(r.Ka)).toBe(v.Ka)
      expect(hex(r.KcA)).toBe(v.KcA)
      expect(hex(r.KcB)).toBe(v.KcB)
      expect(hex(r.cA)).toBe(v.cA)
      expect(hex(r.cB)).toBe(v.cB)
    }
  )
})
