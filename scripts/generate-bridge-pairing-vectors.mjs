// scripts/generate-bridge-pairing-vectors.mjs
//
// The §13 reference generator for docs/bridge-pairing-protocol-vectors.json —
// the spec requires the vectors to come from a script checked in with the
// Phase-A implementation, and regeneration to be deterministic given the
// recorded inputs. Usage: `pnpm run generate:bridge-vectors`, or directly
// `node scripts/generate-bridge-pairing-vectors.mjs <output.json>`.
//
// MBP1 reference vector generator (rev 2, after crypto-review round 1).
// Step 1 validates the generic SPAKE2 core (TT layout, key schedule,
// confirmation MACs) against ALL FOUR RFC 9382 Appendix B P-256 vectors.
// Step 2 generates the MBP1 edwards25519 vectors defined by
// docs/bridge-pairing-protocol.md and self-checks them, including strict
// Ed25519 verification and weak binding-key rejection.
import { createCipheriv, createDecipheriv } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import { ed25519 } from '@noble/curves/ed25519.js'
import { p256 } from '@noble/curves/nist.js'
import { hkdf } from '@noble/hashes/hkdf.js'
import { hmac } from '@noble/hashes/hmac.js'
import { scrypt } from '@noble/hashes/scrypt.js'
import { sha256 } from '@noble/hashes/sha2.js'

// ---------- helpers ----------
const te = new TextEncoder()
const utf8 = (s) => te.encode(s)
const hex = (b) => Buffer.from(b).toString('hex')
const unhex = (s) =>
  Uint8Array.from(Buffer.from(s.replaceAll(/\s/g, ''), 'hex'))
const concat = (...parts) => {
  const total = parts.reduce((n, p) => n + p.length, 0)
  const out = new Uint8Array(total)
  let o = 0
  for (const p of parts) {
    out.set(p, o)
    o += p.length
  }
  return out
}
const len64LE = (n) => {
  const b = new Uint8Array(8)
  new DataView(b.buffer).setBigUint64(0, BigInt(n), true)
  return b
}
const enc = (bytes) => concat(len64LE(bytes.length), bytes)
const encStr = (s) => enc(utf8(s))
const encU32BE = (n) => {
  const b = new Uint8Array(4)
  new DataView(b.buffer).setUint32(0, n, false)
  return b
}
const encU64BE = (n) => {
  const b = new Uint8Array(8)
  new DataView(b.buffer).setBigUint64(0, BigInt(n), false)
  return b
}
const os2ip = (b) => BigInt(`0x${hex(b) || '0'}`)
const i2osp = (n, k) => {
  const s = n.toString(16).padStart(k * 2, '0')
  if (s.length > k * 2) throw new Error('int too large')
  return unhex(s)
}
const assertEq = (label, got, want) => {
  const g = typeof got === 'string' ? got : hex(got)
  const w = typeof want === 'string' ? want.replaceAll(/\s/g, '') : hex(want)
  if (g !== w) {
    throw new Error(`MISMATCH ${label}\n  got  ${g}\n  want ${w}`)
  }
  console.log(`ok  ${label}`)
}

// ---------- generic SPAKE2 core (RFC 9382) ----------
function spake2Run(cfg, { A, B, w, x, y, aad }) {
  const { Point, order, cofactor, M, N } = cfg
  const wr = w % order
  const X = Point.BASE.multiply(x % order)
  const pA = M.multiply(wr).add(X)
  const Y = Point.BASE.multiply(y % order)
  const pB = N.multiply(wr).add(Y)
  // A side: K = h * x * (pB - w*N); B side: K = h * y * (pA - w*M)
  const KA = pB
    .subtract(N.multiply(wr))
    .multiply(x % order)
    .multiply(cofactor)
  const KB = pA
    .subtract(M.multiply(wr))
    .multiply(y % order)
    .multiply(cofactor)
  if (hex(cfg.encode(KA)) !== hex(cfg.encode(KB))) throw new Error('K disagree')
  const K = KA
  const TT = concat(
    enc(A),
    enc(B),
    enc(cfg.encode(pA)),
    enc(cfg.encode(pB)),
    enc(cfg.encode(K)),
    enc(i2osp(wr, cfg.scalarLen))
  )
  const hash = sha256(TT)
  const Ke = hash.slice(0, 16)
  const Ka = hash.slice(16)
  const conf = hkdf(
    sha256,
    Ka,
    undefined,
    concat(utf8('ConfirmationKeys'), aad ?? new Uint8Array(0)),
    32
  )
  const KcA = conf.slice(0, 16)
  const KcB = conf.slice(16)
  const cA = hmac(sha256, KcA, TT)
  const cB = hmac(sha256, KcB, TT)
  return {
    pA: cfg.encode(pA),
    pB: cfg.encode(pB),
    K: cfg.encode(K),
    TT,
    Ke,
    Ka,
    KcA,
    KcB,
    cA,
    cB,
  }
}

// ---------- step 1: ALL FOUR RFC 9382 Appendix B (P-256) core vectors ----------
const p256cfg = {
  name: 'P-256',
  Point: p256.Point,
  order: p256.Point.Fn.ORDER,
  cofactor: 1n,
  M: p256.Point.fromHex(
    '02886e2f97ace46e55ba9dd7242579f2993b64e16ef3dcab95afd497333d8fa12f'
  ),
  N: p256.Point.fromHex(
    '03d8bbd6c639c62937b04d997f38c3770719c629d7014d49a24b4f98baa1292b49'
  ),
  encode: (p) => p.toBytes(false),
  scalarLen: 32,
}

const rfcVectors = [
  {
    label: "RFC9382 B#1 A='server' B='client'",
    A: utf8('server'),
    B: utf8('client'),
    w: '2ee57912099d31560b3a44b1184b9b4866e904c49d12ac5042c97dca461b1a5f',
    x: '43dd0fd7215bdcb482879fca3220c6a968e66d70b1356cac18bb26c84a78d729',
    y: 'dcb60106f276b02606d8ef0a328c02e4b629f84f89786af5befb0bc75b6e66be',
    pA: '04a56fa807caaa53a4d28dbb9853b9815c61a411118a6fe516a8798434751470f9010153ac33d0d5f2047ffdb1a3e42c9b4e6be662766e1eeb4116988ede5f912c',
    pB: '0406557e482bd03097ad0cbaa5df82115460d951e3451962f1eaf4367a420676d09857ccbc522686c83d1852abfa8ed6e4a1155cf8f1543ceca528afb591a1e0b7',
    K: '0412af7e89717850671913e6b469ace67bd90a4df8ce45c2af19010175e37eed69f75897996d539356e2fa6a406d528501f907e04d97515fbe83db277b715d3325',
    Ke: '0e0672dc86f8e45565d338b0540abe69',
    Ka: '15bdf72e2b35b5c9e5663168e960a91b',
    KcA: '00c12546835755c86d8c0db7851ae86f',
    KcB: 'a9fa3406c3b781b93d804485430ca27a',
    cA: '58ad4aa88e0b60d5061eb6b5dd93e80d9c4f00d127c65b3b35b1b5281fee38f0',
    cB: 'd3e2e547f1ae04f2dbdbf0fc4b79f8ecff2dff314b5d32fe9fcef2fb26dc459b',
  },
  {
    label: "RFC9382 B#2 A='' B='client'",
    A: new Uint8Array(0),
    B: utf8('client'),
    w: '0548d8729f730589e579b0475a582c1608138ddf7054b73b5381c7e883e2efae',
    x: '403abbe3b1b4b9ba17e3032849759d723939a27a27b9d921c500edde18ed654b',
    y: '903023b6598908936ea7c929bd761af6039577a9c3f9581064187c3049d87065',
    pA: '04a897b769e681c62ac1c2357319a3d363f610839c4477720d24cbe32f5fd85f44fb92ba966578c1b712be6962498834078262caa5b441ecfa9d4a9485720e918a',
    pB: '04e0f816fd1c35e22065d5556215c097e799390d16661c386e0ecc84593974a61b881a8c82327687d0501862970c64565560cb5671f696048050ca66ca5f8cc7fc',
    K: '048f83ec9f6e4f87cc6f9dc740bdc2769725f923364f01c84148c049a39a735ebda82eac03e00112fd6a5710682767cff5361f7e819e53d8d3c3a2922e0d837aa6',
    Ke: '642f05c473c2cd79909f9a841e2f30a7',
    Ka: '0bf89b18180af97353ba198789c2b963',
    KcA: 'c6be376fc7cd1301fd0a13adf3e7bffd',
    KcB: 'b7243f4ae60440a49b3f8cab3c1fba07',
    cA: '47d29e6666af1b7dd450d571233085d7a9866e4d49d2645e2df975489521232b',
    cB: '3313c5cefc361d27fb16847a91c2a73b766ffa90a4839122a9b70a2f6bd1d6df',
  },
  {
    label: "RFC9382 B#3 A='server' B=''",
    A: utf8('server'),
    B: new Uint8Array(0),
    w: '626e0cdc7b14c9db3e52a0b1b3a768c98e37852d5db30febe0497b14eae8c254',
    x: '07adb3db6bc623d3399726bfdbfd3d15a58ea776ab8a308b00392621291f9633',
    y: 'b6a4fc8dbb629d4ba51d6f91ed1532cf87adec98f25dd153a75accafafedec16',
    pA: '04f88fb71c99bfffaea370966b7eb99cd4be0ff1a7d335caac4211c4afd855e2e15a873b298503ad8ba1d9cbb9a392d2ba309b48bfd7879aefd0f2cea6009763b0',
    pB: '040c269d6be017dccb15182ac6bfcd9e2a14de019dd587eaf4bdfd353f031101e7cca177f8eb362a6e83e7d5e729c0732e1b528879c086f39ba0f31a9661bd34db',
    K: '0445ee233b8ecb51ebd6e7da3f307e88a1616bae2166121221fdc0dadb986afaf3ec8a988dc9c626fa3b99f58a7ca7c9b844bb3e8dd9554aafc5b53813504c1cbe',
    Ke: '005184ff460da2ce59062c87733c299c',
    Ka: '3521297d736598fc0a1127600efa1afb',
    KcA: 'f3da53604f0aeecea5a33be7bddf6edf',
    KcB: '9e3f86848736f159bd92b6e107ec6799',
    cA: 'bc9f9bbe99f26d0b2260e6456e05a86196a3307ec6663a18bf6ac825736533b2',
    cB: 'c2370e1bf813b086dff0d834e74425a06e6390f48f5411900276dcccc5a297ec',
  },
  {
    label: "RFC9382 B#4 A='' B=''",
    A: new Uint8Array(0),
    B: new Uint8Array(0),
    w: '7bf46c454b4c1b25799527d896508afd5fc62ef4ec59db1efb49113063d70cca',
    x: '8cef65df64bb2d0f83540c53632de911b5b24b3eab6cc74a97609fd659e95473',
    y: 'd7a66f64074a84652d8d623a92e20c9675c61cb5b4f6a0063e4648a2fdc02d53',
    pA: '04a65b367a3f613cf9f0654b1b28a1e3a8a40387956c8ba6063e8658563890f46ca1ef6a676598889fc28de2950ab8120b79a5ef1ea4c9f44bc98f585634b46d66',
    pB: '04589f13218822710d98d8b2123a079041052d9941b9cf88c6617ddb2fcc0494662eea8ba6b64692dc318250030c6af045cb738bc81ba35b043c3dcb46adf6f58d',
    K: '041a3c03d51b452537ca2a1fea6110353c6d5ed483c4f0f86f4492ca3f378d40a994b4477f93c64d928edbbcd3e85a7c709b7ea73ee97986ce3d1438e135543772',
    Ke: 'fc6374762ba5cf11f4b2caa08b2cd1b9',
    Ka: '907ae0e26e8d6234318d91583cd74c86',
    KcA: '5dbd2f477166b7fb6d61febbd77a5563',
    KcB: '7689b4654407a5faeffdc8f18359d8a3',
    cA: 'dfb4db8d48ae5a675963ea5e6c19d98d4ea028d8e898dad96ea19a80ade95dca',
    cB: 'd0f0609d1613138d354f7e95f19fb556bf52d751947241e8c7118df5ef0ae175',
  },
]

for (const v of rfcVectors) {
  const run = spake2Run(p256cfg, {
    A: v.A,
    B: v.B,
    w: os2ip(unhex(v.w)),
    x: os2ip(unhex(v.x)),
    y: os2ip(unhex(v.y)),
    aad: new Uint8Array(0),
  })
  assertEq(`${v.label} pA`, run.pA, v.pA)
  assertEq(`${v.label} pB`, run.pB, v.pB)
  assertEq(`${v.label} K`, run.K, v.K)
  assertEq(`${v.label} Ke`, run.Ke, v.Ke)
  assertEq(`${v.label} Ka`, run.Ka, v.Ka)
  assertEq(`${v.label} KcA`, run.KcA, v.KcA)
  assertEq(`${v.label} KcB`, run.KcB, v.KcB)
  assertEq(`${v.label} cA`, run.cA, v.cA)
  assertEq(`${v.label} cB`, run.cB, v.cB)
}

// ---------- step 2: MBP1 edwards25519 vectors ----------
const ed25519cfg = {
  name: 'edwards25519',
  Point: ed25519.Point,
  order: ed25519.Point.Fn.ORDER,
  cofactor: 8n,
  M: ed25519.Point.fromHex(
    'd048032c6ea0b6d697ddc2e86bda85a33adac920f1bf18e1b0c6d166a5cecdaf'
  ),
  N: ed25519.Point.fromHex(
    'd3bfb518f44f3430f29d0c92af503865a1ed3281dc69b35dd868ba85f886c4ab'
  ),
  encode: (p) => p.toBytes(),
  scalarLen: 32,
}
const ell = ed25519cfg.order

// --- fixed vector inputs (arbitrary but recorded; regeneration is deterministic).
// The spec (§6.3) requires rejection-sampled uniform scalars at runtime; test
// vectors supply the scalars directly, mirroring the RFC vectors.
const codeDisplayed = 'MTX7-K2Q9'
const codeNormalized = 'MTX7K2Q9'
const pairNonce = 'vec-nonce-8f3a1c5e7b2d4a90'
const browser = 'chromium'
const verifiedOrigin = 'chrome-extension://ibpkjhgpbidfmbmomagmldcdlpbmchgi'
const claimedExtensionId = 'ibpkjhgpbidfmbmomagmldcdlpbmchgi'
const clientInstallationId = '5f0b6f9e-8a3d-4c5e-9b2a-7d1e4f6a8c0b'
const instanceId = '0d9c2b7a-4e6f-4a1b-8c3d-2e5f7a9b1c4d'
const xSeed = unhex(
  '9c4c6f8a11d2b35e07a1c8d94e2f6b013a5d7e9f2c4b6a80d1e3f5a7b9c0d2e4' +
    'f6a8b0c2d4e6f8091b3d5f7a9c0e2f4b6d8a0c1e3f5b7d9a0c2e4f6b8d0a2c4e'
)
const ySeed = unhex(
  '2b7d9f1a3c5e7b9d0f2a4c6e8b0d2f4a6c8e0b1d3f5a7c9e0b2d4f6a8c1e3f5b' +
    '7d9a0c2e4f6b8d0a2c4e6f8b1d3a5c7e9f0b2d4a6c8e0f1b3d5a7c9e0f2b4d6a'
)
// scrypt(pw, "MBP1/w/v1" || nonce, N=2^14, r=8, p=1, dkLen=64); w = OS2IP mod ell
const wBytes = scrypt(
  utf8(codeNormalized),
  concat(utf8('MBP1/w/v1'), utf8(pairNonce)),
  { N: 2 ** 14, r: 8, p: 1, dkLen: 64 }
)
const w = os2ip(wBytes) % ell
const x = os2ip(xSeed) % ell
const y = os2ip(ySeed) % ell

// ticket binding key (Ed25519), fixed seed
const bindingSeed = unhex(
  '7f1d3b5a7c9e0f2b4d6a8c0e1f3b5d7a9c0e2f4b6d8a0c2e4f6a8b0d1e3f5a7c'
)
const bindingPub = ed25519.getPublicKey(bindingSeed)

// --- binding-key validation per §9.1 (canonical, on-curve, not identity,
// not small-order, torsion-free) ---
function isValidBindingPub(bytes) {
  if (bytes.length !== 32) return false
  let P
  try {
    P = ed25519.Point.fromHex(hex(bytes))
  } catch {
    return false
  }
  try {
    if (P.isSmallOrder()) return false
    if (!P.isTorsionFree()) return false
  } catch {
    return false
  }
  return true
}
if (!isValidBindingPub(bindingPub))
  throw new Error('honest bindingPub rejected')
console.log('ok  bindingPub validation accepts the honest key')

// --- nm ticket (§9.2) — minted before pairHello, so before the PAKE ---
const ticketV = 1
const localToken = 'vector-local-token-0123456789abcdef'
const serverGeneration = '3c2b1a09-8f7e-4d6c-b5a4-93827160f0e1'
const exp = 1755600000
const ticketKey = hkdf(
  sha256,
  utf8(localToken),
  utf8('MBP1/nm-ticket/v1'),
  utf8('mac'),
  32
)
const ticketCanonical = concat(
  encStr('mbp1-attestation'),
  encU32BE(ticketV),
  encU32BE(1),
  encStr(serverGeneration),
  encStr(browser),
  encStr(claimedExtensionId),
  encU64BE(exp),
  enc(bindingPub)
)
const ticketMac = hmac(sha256, ticketKey, ticketCanonical)
// AAD ticket digest (§6.4): over the CANONICAL ENCODINGS of the ticket's parsed
// field values (U32BE v/protocolVersion, U64BE exp, UTF-8 strings, raw decoded
// bytes for bindingPub/mac) — including the wire `purpose` string and `mac`, but
// NOT the §9.2 MAC canonical (which fixes purpose to a domain tag) and NOT the
// raw JSON serialization. This is what makes purpose/field tampering fail closed
// rather than downgrade.
const ticketWire = concat(
  encU32BE(ticketV),
  encStr('mbp1-attestation'), // wire purpose value
  encU32BE(1), // ticket protocolVersion
  encStr(serverGeneration),
  encStr(browser),
  encStr(claimedExtensionId),
  encU64BE(exp),
  enc(bindingPub),
  enc(ticketMac)
)
const ticketDigest = sha256(ticketWire)

// --- identities and AAD per §6.4 (ticketBindingKey + ticket digest in AAD) ---
const A_id = concat(
  encStr('MBP1/A/v1'),
  encStr(browser),
  encStr(verifiedOrigin),
  encStr(claimedExtensionId),
  encStr(clientInstallationId)
)
const B_id = concat(
  encStr('MBP1/B/v1'),
  encStr('motrix-bridge'),
  encStr(instanceId)
)
const AAD = concat(
  encU32BE(1),
  encStr(pairNonce),
  enc(bindingPub), // ticketBindingKey (== ticket.bindingPub here)
  enc(ticketDigest)
)
const AADnoTicket = concat(
  encU32BE(1),
  encStr(pairNonce),
  enc(new Uint8Array(0)),
  enc(new Uint8Array(0))
)

const run = spake2Run(ed25519cfg, { A: A_id, B: B_id, w, x, y, aad: AAD })
const runNoTicket = spake2Run(ed25519cfg, {
  A: A_id,
  B: B_id,
  w,
  x,
  y,
  aad: AADnoTicket,
})
assertEq('mbp1 TT stable across AAD variants', runNoTicket.TT, run.TT)
// tampering ANY wire field (or the separate bindingKey) => different AAD =>
// different confirmation keys => fail closed. Cover every field, not a subset.
const confirmationOf = (aad) =>
  hex(spake2Run(ed25519cfg, { A: A_id, B: B_id, w, x, y, aad }).cA)
const wireDigest = (f) =>
  sha256(
    concat(
      encU32BE(f.v ?? ticketV),
      encStr(f.purpose ?? 'mbp1-attestation'),
      encU32BE(f.pv ?? 1),
      encStr(f.gen ?? serverGeneration),
      encStr(f.browser ?? browser),
      encStr(f.caller ?? claimedExtensionId),
      encU64BE(f.exp ?? exp),
      enc(f.bindingPub ?? bindingPub),
      enc(f.mac ?? ticketMac)
    )
  )
{
  const tamperedMac = Uint8Array.from(ticketMac)
  tamperedMac[0] ^= 0x01
  const otherKey = ed25519.getPublicKey(unhex('11'.repeat(32)))
  const fieldTampers = {
    v: { v: 2 },
    purpose: { purpose: 'mbp1-attestationX' },
    ticketProtocolVersion: { pv: 2 },
    serverGeneration: { gen: `${serverGeneration}X` },
    browser: { browser: 'firefox' },
    callerId: { caller: `${claimedExtensionId}X` },
    exp: { exp: exp + 1 },
    bindingPub: { bindingPub: otherKey },
    mac: { mac: tamperedMac },
  }
  for (const [field, delta] of Object.entries(fieldTampers)) {
    const aad = concat(
      encU32BE(1),
      encStr(pairNonce),
      enc(bindingPub),
      enc(wireDigest(delta))
    )
    if (confirmationOf(aad) === hex(run.cA)) {
      throw new Error(`ticket field tamper not caught: ${field}`)
    }
  }
  // separate pairHello.ticketBindingKey field (outside the digest)
  const aadBindKey = concat(
    encU32BE(1),
    encStr(pairNonce),
    enc(otherKey),
    enc(ticketDigest)
  )
  if (confirmationOf(aadBindKey) === hex(run.cA))
    throw new Error('bindingKey tamper not caught')
  console.log(
    `ok  every ticket field (${Object.keys(fieldTampers).join(',')}) + bindingKey tamper desynchronizes confirmation`
  )
}

// --- ticket proof: strict Ed25519 over "MBP1/ticket-proof/v1" || TT ---
const ticketProofMsg = concat(utf8('MBP1/ticket-proof/v1'), run.TT)
const ticketProof = ed25519.sign(ticketProofMsg, bindingSeed)
if (
  !ed25519.verify(ticketProof, ticketProofMsg, bindingPub, { zip215: false })
) {
  throw new Error('strict proof verify failed')
}
console.log('ok  mbp1 ticketProof verifies (strict)')

// --- weak binding-key rejection (§9.1 / review M3, L4) ---
const IDENTITY_ENC =
  '0100000000000000000000000000000000000000000000000000000000000000'
const SMALL_ORDER_ENC =
  'c7176a703d4dd84fba3c0b760d10670f2a2053fa2c39ccc64ec7fd7792ac037a'
// The full set of edwards25519 small-order point encodings (order dividing 8),
// per RFC 8032 / the cofactor subgroup. §9.1 MUST reject every one of them.
const SMALL_ORDER_ENCODINGS = [
  '0100000000000000000000000000000000000000000000000000000000000000', // identity (order 1)
  'ecffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f', // order 2
  '0000000000000000000000000000000000000000000000000000000000000000', // order 4
  '0000000000000000000000000000000000000000000000000000000000000080', // order 4 (x sign set)
  'c7176a703d4dd84fba3c0b760d10670f2a2053fa2c39ccc64ec7fd7792ac037a', // order 8
  'c7176a703d4dd84fba3c0b760d10670f2a2053fa2c39ccc64ec7fd7792ac03fa', // order 8
  '26e8958fc2b227b045c3f489f2ef98f0d5dfac05d3c63339b13802886d53fc05', // order 8
  '26e8958fc2b227b045c3f489f2ef98f0d5dfac05d3c63339b13802886d53fc85', // order 8
]
for (const encHex of SMALL_ORDER_ENCODINGS) {
  if (isValidBindingPub(unhex(encHex))) {
    throw new Error(`small-order bindingPub accepted: ${encHex}`)
  }
}
// A "dirty" (non-torsion-free) key: a prime-order point plus a small-order
// component. On the curve, not identity, not small-order, but NOT torsion-free.
const dirtyPub = ed25519.Point.BASE.add(
  ed25519.Point.fromHex(SMALL_ORDER_ENC)
).toBytes()
const DIRTY_ENC = hex(dirtyPub)
if (isValidBindingPub(dirtyPub)) {
  throw new Error('dirty (non-torsion-free) bindingPub accepted')
}
console.log('ok  identity, small-order, and dirty-torsion bindingPub rejected')
// The identity-key forgery (R = identity, S = 0) satisfies even the strict
// cofactorless equation, which is exactly why §9.1 rejects the key itself.
{
  const weakPub = unhex(IDENTITY_ENC)
  const weakSig = concat(weakPub, new Uint8Array(32))
  let accepted = false
  try {
    accepted = ed25519.verify(weakSig, ticketProofMsg, weakPub, {
      zip215: false,
    })
  } catch {
    accepted = false
  }
  console.log(
    `ok  identity-key forgery ${accepted ? 'passes the bare equation (key-level rejection is load-bearing)' : 'is rejected by this library, but key-level rejection is still required'}`
  )
}
// Malleated signature with S' = S + ℓ (S' ≥ ℓ): actual bytes, strict-rejected.
const S_le = ticketProof.slice(32) // S is little-endian in the signature
const S_val = os2ip(Uint8Array.from(S_le).reverse())
const Sbig_le = Uint8Array.from(i2osp(S_val + ell, 32)).reverse()
const sigSGeqEll = concat(ticketProof.slice(0, 32), Sbig_le)
{
  let accepted
  try {
    accepted = ed25519.verify(sigSGeqEll, ticketProofMsg, bindingPub, {
      zip215: false,
    })
  } catch {
    accepted = false
  }
  if (accepted) throw new Error('S >= ell signature accepted by strict verify')
  console.log('ok  S>=ell malleated signature rejected (strict)')
}
// Non-canonical R: replace R with the non-canonical encoding of the identity
// (y = p, i.e. 0xED..7F), which strict mode MUST reject as a non-canonical
// point encoding. Actual bytes emitted for cross-implementation testing.
const NONCANONICAL_R =
  'edffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f'
const sigNonCanonicalR = concat(unhex(NONCANONICAL_R), new Uint8Array(32))
{
  let accepted
  try {
    accepted = ed25519.verify(sigNonCanonicalR, ticketProofMsg, bindingPub, {
      zip215: false,
    })
  } catch {
    accepted = false
  }
  if (accepted)
    throw new Error('non-canonical R signature accepted by strict verify')
  console.log('ok  non-canonical R signature rejected (strict)')
}

// --- pair traffic keys per §6.6 (pair-specific labels) ---
const kC2S = hkdf(
  sha256,
  run.Ke,
  utf8('MBP1/pair/v1'),
  utf8('MBP1-pair-traffic-c2s'),
  32
)
const kS2C = hkdf(
  sha256,
  run.Ke,
  utf8('MBP1/pair/v1'),
  utf8('MBP1-pair-traffic-s2c'),
  32
)

// --- reconnect vector (§8) ---
const mutualKey = unhex(
  'a3b1c5d7e9f0a2b4c6d8e0f1a3b5c7d9e1f0a2c4b6d8e0f2a4b6c8d0e2f4a6b8'
)
const credentialId = '9e8d7c6b-5a49-4838-a2b1-c0d9e8f7a6b5'
const S = unhex(
  '5a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f9'
)
const C = unhex(
  '0f1e2d3c4b5a69788796a5b4c3d2e1f00f1e2d3c4b5a69788796a5b4c3d2e1f0'
)
const RT = concat(
  encStr('MBP1/reconnect/v1'),
  encU32BE(1),
  encStr(credentialId),
  encStr(browser),
  encStr(verifiedOrigin),
  encStr(instanceId)
)
const macClient = hmac(sha256, mutualKey, concat(utf8('MBP1-R/c'), S, C, RT))
const macServer = hmac(sha256, mutualKey, concat(utf8('MBP1-R/s'), S, C, RT))
const rkC2S = hkdf(
  sha256,
  mutualKey,
  concat(S, C),
  utf8('MBP1-traffic-c2s'),
  32
)
const rkS2C = hkdf(
  sha256,
  mutualKey,
  concat(S, C),
  utf8('MBP1-traffic-s2c'),
  32
)

// --- envelope vectors (§10) ---
const gcmSeal = (key, dirTag, seq, plaintext) => {
  const nonce = concat(encU32BE(dirTag), encU64BE(seq))
  const cipher = createCipheriv('aes-256-gcm', key, nonce)
  cipher.setAAD(utf8('MBP1/env/v1'))
  const ct = concat(
    cipher.update(plaintext),
    cipher.final(),
    cipher.getAuthTag()
  )
  return concat(encU64BE(seq), ct)
}
const gcmOpen = (key, dirTag, expectedSeq, frame) => {
  const seq = new DataView(frame.buffer, frame.byteOffset).getBigUint64(
    0,
    false
  )
  if (seq !== BigInt(expectedSeq)) throw new Error('seq mismatch')
  const body = frame.slice(8)
  const ct = body.slice(0, -16)
  const tag = body.slice(-16)
  const nonce = concat(encU32BE(dirTag), encU64BE(expectedSeq))
  const d = createDecipheriv('aes-256-gcm', key, nonce)
  d.setAAD(utf8('MBP1/env/v1'))
  d.setAuthTag(tag)
  return concat(d.update(ct), d.final())
}
const pt0 = utf8(
  '{"jsonrpc":"2.0","id":1,"method":"motrix/initialize","params":{}}'
)
const pt1 = utf8('{"jsonrpc":"2.0","id":1,"result":{"ok":true}}')
const frameC0 = gcmSeal(kC2S, 1, 0, pt0)
const frameS0 = gcmSeal(kS2C, 2, 0, pt1)
const frameC1 = gcmSeal(kC2S, 1, 1, pt1)
assertEq('envelope c2s#0 roundtrip', gcmOpen(kC2S, 1, 0, frameC0), pt0)
assertEq('envelope s2c#0 roundtrip', gcmOpen(kS2C, 2, 0, frameS0), pt1)
// rejection self-checks: tamper, dirTag-only mismatch (same key), wrong key
let rejected = 0
try {
  const t = Uint8Array.from(frameC0)
  t[t.length - 1] ^= 0x01
  gcmOpen(kC2S, 1, 0, t)
} catch {
  rejected++
}
try {
  gcmOpen(kC2S, 2, 0, frameC0) // same key, flipped dirTag only
} catch {
  rejected++
}
try {
  gcmOpen(kS2C, 2, 0, frameC0) // wrong key and dirTag
} catch {
  rejected++
}
if (rejected !== 3) throw new Error('rejection self-check failed')
console.log('ok  envelope tamper/dirTag/key rejection')

// ---------- emit ----------
const out = {
  description:
    'Normative MBP1 cross-implementation test vectors (rev 2, post crypto-review round 1). ' +
    'Generated per docs/bridge-pairing-protocol.md. The generic SPAKE2 core was validated ' +
    'against all four RFC 9382 Appendix B P-256 vectors before generation. All byte strings ' +
    'are lowercase hex.',
  generator: {
    library:
      '@noble/curves 2.0.1, @noble/hashes 2.0.1, node:crypto AES-256-GCM',
    coreValidation:
      'RFC 9382 Appendix B vectors #1-#4 (P-256) reproduced exactly',
  },
  spake2: [
    {
      name: 'first-pair, chromium, nm ticket present',
      inputs: {
        codeDisplayed,
        codeNormalized,
        pairNonce,
        browser,
        verifiedOrigin,
        claimedExtensionId,
        clientInstallationId,
        instanceId,
        x: hex(i2osp(x, 32)),
        y: hex(i2osp(y, 32)),
        bindingSeed: hex(bindingSeed),
      },
      intermediate: {
        scryptOutput: hex(wBytes),
        w: hex(i2osp(w, 32)),
        aId: hex(A_id),
        bId: hex(B_id),
        bindingPub: hex(bindingPub),
        ticketDigest: hex(ticketDigest),
        aad: hex(AAD),
      },
      expected: {
        pA: hex(run.pA),
        pB: hex(run.pB),
        K: hex(run.K),
        TT: hex(run.TT),
        Ke: hex(run.Ke),
        Ka: hex(run.Ka),
        KcA: hex(run.KcA),
        KcB: hex(run.KcB),
        cA: hex(run.cA),
        cB: hex(run.cB),
        ticketProof: hex(ticketProof),
        trafficC2S: hex(kC2S),
        trafficS2C: hex(kS2C),
      },
    },
    {
      name: 'first-pair, same inputs, no nm ticket (AAD variant)',
      inputs: { note: 'identical to vector 0 except nmTicket absent' },
      intermediate: { aad: hex(AADnoTicket) },
      expected: {
        TT: hex(runNoTicket.TT),
        KcA: hex(runNoTicket.KcA),
        KcB: hex(runNoTicket.KcB),
        cA: hex(runNoTicket.cA),
        cB: hex(runNoTicket.cB),
      },
    },
  ],
  scryptW: {
    inputs: {
      codeNormalized,
      pairNonce,
      params: { N: 16384, r: 8, p: 1, dkLen: 64 },
    },
    expected: { scryptOutput: hex(wBytes), w: hex(i2osp(w, 32)) },
  },
  reconnect: {
    inputs: {
      mutualKey: hex(mutualKey),
      credentialId,
      browser,
      verifiedOrigin,
      instanceId,
      S: hex(S),
      C: hex(C),
    },
    expected: {
      RT: hex(RT),
      macClient: hex(macClient),
      macServer: hex(macServer),
      trafficC2S: hex(rkC2S),
      trafficS2C: hex(rkS2C),
    },
  },
  nmTicket: {
    inputs: {
      v: ticketV,
      localToken,
      serverGeneration,
      browser,
      callerId: claimedExtensionId,
      exp,
      bindingPub: hex(bindingPub),
    },
    expected: {
      ticketKey: hex(ticketKey),
      canonical: hex(ticketCanonical),
      mac: hex(ticketMac),
      ticketDigest: hex(ticketDigest),
    },
    mustReject: [
      {
        case: 'bindingPub = any small-order / torsion point encoding (full set)',
        bindingPub: SMALL_ORDER_ENCODINGS,
        reason:
          'every order-dividing-8 encoding rejected by §9.1 validation (identity, order-2, order-4, order-8)',
      },
      {
        case: 'bindingPub = dirty (non-torsion-free) point',
        bindingPub: DIRTY_ENC,
        reason:
          'has a torsion component; rejected by the §9.1 torsion-free check',
      },
      {
        case: 'ticketProof = (identity || 0) under bindingPub = identity',
        bindingPub: IDENTITY_ENC,
        signature: `${IDENTITY_ENC}${'00'.repeat(32)}`,
        reason:
          'passes the bare verification equation for any message; stopped by key-level rejection of identity bindingPub',
      },
      {
        case: 'ticketProof with S >= ell (S malleated by + ell)',
        signature: hex(sigSGeqEll),
        reason: 'RFC 8032 strict (zip215:false) rejects S >= ell',
      },
      {
        case: 'ticketProof with a non-canonical R encoding (y = p)',
        signature: hex(sigNonCanonicalR),
        reason: 'RFC 8032 strict rejects non-canonical point encodings',
      },
      {
        case: 'any single wire field of the ticket (v, purpose, ticketProtocolVersion, serverGeneration, browser, callerId, exp, bindingPub, mac) modified in transit',
        reason:
          'ticketDigest over the parsed wire fields bound into the PAKE AAD (§6.4) desynchronizes key confirmation → fail closed',
      },
    ],
    note: "A torsion-tweaked proof (R=rB+T, S=r+k·a) by a signer who KNOWS bindingPriv is a conformance caveat of noble's cofactored equation, NOT a forgery, and is intentionally not asserted as rejected (spec §9.1).",
  },
  envelope: {
    inputs: {
      keyC2S: hex(kC2S),
      keyS2C: hex(kS2C),
      aad: 'MBP1/env/v1',
      plaintext0: hex(pt0),
      plaintext1: hex(pt1),
    },
    expected: {
      frameC2S_seq0: hex(frameC0),
      frameS2C_seq0: hex(frameS0),
      frameC2S_seq1: hex(frameC1),
    },
    mustReject: [
      {
        case: 'last ciphertext byte of frameC2S_seq0 XOR 0x01',
        reason: 'gcm auth failure',
      },
      {
        case: 'frameC2S_seq0 decrypted with the SAME key but dirTag 2',
        reason:
          'gcm auth failure (nonce direction tag); catches dirTag-ignoring implementations',
      },
      {
        case: 'frameC2S_seq0 decrypted with the s2c key',
        reason: 'gcm auth failure',
      },
      {
        case: 'frameC2S_seq1 presented when expected seq is 0',
        reason: 'strict sequence check',
      },
    ],
  },
}
const target = process.argv[2]
if (!target) throw new Error('usage: node generate.mjs <output.json>')
writeFileSync(target, `${JSON.stringify(out, null, 2)}\n`)
console.log('\nwrote', target)
