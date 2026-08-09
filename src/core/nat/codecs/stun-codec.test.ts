import crypto from 'node:crypto'
import { fc, test } from '@fast-check/vitest'
import { ErrorCode } from '@shared/errors'
import { describe, expect, it } from 'vitest'
import {
  buildBindingRequest,
  parseBindingResponse,
  STUN_ATTR_MAPPED_ADDRESS,
  STUN_ATTR_XOR_MAPPED_ADDRESS,
  STUN_MAGIC_COOKIE,
  STUN_MESSAGE_TYPE_BINDING_SUCCESS,
} from './stun-codec'

function buildMappedAddressAttr(
  attrType: number,
  ip: [number, number, number, number],
  port: number,
  _txId: Buffer
): Buffer {
  const attr = Buffer.alloc(12)
  attr.writeUInt16BE(attrType, 0)
  attr.writeUInt16BE(8, 2)
  attr[4] = 0
  attr[5] = 1
  if (attrType === STUN_ATTR_XOR_MAPPED_ADDRESS) {
    const xorPort = port ^ (STUN_MAGIC_COOKIE >>> 16)
    attr.writeUInt16BE(xorPort & 0xffff, 6)
    const ipBuf = Buffer.from(ip)
    const cookieBuf = Buffer.alloc(4)
    cookieBuf.writeUInt32BE(STUN_MAGIC_COOKIE, 0)
    attr[8] = (ipBuf[0] ?? 0) ^ (cookieBuf[0] ?? 0)
    attr[9] = (ipBuf[1] ?? 0) ^ (cookieBuf[1] ?? 0)
    attr[10] = (ipBuf[2] ?? 0) ^ (cookieBuf[2] ?? 0)
    attr[11] = (ipBuf[3] ?? 0) ^ (cookieBuf[3] ?? 0)
  } else {
    attr.writeUInt16BE(port, 6)
    attr[8] = ip[0]
    attr[9] = ip[1]
    attr[10] = ip[2]
    attr[11] = ip[3]
  }
  return attr
}

function buildStunResponse(
  txId: Buffer,
  attrs: Buffer[],
  overrides: { type?: number; cookie?: number } = {}
): Buffer {
  const attrData = Buffer.concat(attrs)
  const header = Buffer.alloc(20)
  header.writeUInt16BE(overrides.type ?? STUN_MESSAGE_TYPE_BINDING_SUCCESS, 0)
  header.writeUInt16BE(attrData.length, 2)
  header.writeUInt32BE(overrides.cookie ?? STUN_MAGIC_COOKIE, 4)
  txId.copy(header, 8)
  return Buffer.concat([header, attrData])
}

describe('buildBindingRequest', () => {
  it('produces 20-byte header with magic cookie and txId', () => {
    const { buffer, transactionId } = buildBindingRequest()
    expect(buffer.length).toBe(20)
    expect(buffer.readUInt16BE(0)).toBe(0x0001)
    expect(buffer.readUInt16BE(2)).toBe(0)
    expect(buffer.readUInt32BE(4)).toBe(STUN_MAGIC_COOKIE)
    expect(buffer.subarray(8, 20).equals(transactionId)).toBe(true)
    expect(transactionId.length).toBe(12)
  })

  it('generates unique transaction IDs', () => {
    const a = buildBindingRequest()
    const b = buildBindingRequest()
    expect(a.transactionId.equals(b.transactionId)).toBe(false)
  })
})

describe('parseBindingResponse happy path', () => {
  it('parses XOR-MAPPED-ADDRESS with public IP', () => {
    const txId = crypto.randomBytes(12)
    const attr = buildMappedAddressAttr(
      STUN_ATTR_XOR_MAPPED_ADDRESS,
      [203, 0, 113, 42],
      51413,
      txId
    )
    const buf = buildStunResponse(txId, [attr])
    const r = parseBindingResponse(buf, txId)
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.value.mappedIp).toBe('203.0.113.42')
      expect(r.value.mappedPort).toBe(51413)
    }
  })

  it('prefers XOR-MAPPED-ADDRESS over MAPPED-ADDRESS', () => {
    const txId = crypto.randomBytes(12)
    const mapped = buildMappedAddressAttr(
      STUN_ATTR_MAPPED_ADDRESS,
      [1, 1, 1, 1],
      1000,
      txId
    )
    const xored = buildMappedAddressAttr(
      STUN_ATTR_XOR_MAPPED_ADDRESS,
      [203, 0, 113, 42],
      51413,
      txId
    )
    const buf = buildStunResponse(txId, [mapped, xored])
    const r = parseBindingResponse(buf, txId)
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.value.mappedIp).toBe('203.0.113.42')
  })
})

describe('parseBindingResponse security', () => {
  it('rejects wrong transaction ID', () => {
    const txId = crypto.randomBytes(12)
    const wrong = crypto.randomBytes(12)
    const attr = buildMappedAddressAttr(
      STUN_ATTR_XOR_MAPPED_ADDRESS,
      [8, 8, 8, 8],
      443,
      txId
    )
    const buf = buildStunResponse(txId, [attr])
    const r = parseBindingResponse(buf, wrong)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toBe(ErrorCode.NatSecurityViolation)
  })

  it('rejects wrong magic cookie', () => {
    const txId = crypto.randomBytes(12)
    const attr = buildMappedAddressAttr(
      STUN_ATTR_XOR_MAPPED_ADDRESS,
      [8, 8, 8, 8],
      443,
      txId
    )
    const buf = buildStunResponse(txId, [attr], { cookie: 0xdeadbeef })
    const r = parseBindingResponse(buf, txId)
    expect(r.ok).toBe(false)
  })

  it('rejects non-success message type', () => {
    const txId = crypto.randomBytes(12)
    const attr = buildMappedAddressAttr(
      STUN_ATTR_XOR_MAPPED_ADDRESS,
      [8, 8, 8, 8],
      443,
      txId
    )
    const buf = buildStunResponse(txId, [attr], { type: 0x0111 })
    const r = parseBindingResponse(buf, txId)
    expect(r.ok).toBe(false)
  })

  it('rejects buffer smaller than header', () => {
    const r = parseBindingResponse(Buffer.alloc(10), Buffer.alloc(12))
    expect(r.ok).toBe(false)
  })

  it('rejects buffer exceeding max size', () => {
    const r = parseBindingResponse(Buffer.alloc(600), Buffer.alloc(12))
    expect(r.ok).toBe(false)
  })

  it('rejects MAPPED-ADDRESS pointing to private IP', () => {
    const txId = crypto.randomBytes(12)
    const attr = buildMappedAddressAttr(
      STUN_ATTR_MAPPED_ADDRESS,
      [192, 168, 1, 1],
      443,
      txId
    )
    const buf = buildStunResponse(txId, [attr])
    const r = parseBindingResponse(buf, txId)
    expect(r.ok).toBe(false)
  })

  it('rejects attribute length exceeding message bounds', () => {
    const txId = crypto.randomBytes(12)
    const badAttr = Buffer.alloc(12)
    badAttr.writeUInt16BE(STUN_ATTR_XOR_MAPPED_ADDRESS, 0)
    badAttr.writeUInt16BE(1000, 2)
    const buf = buildStunResponse(txId, [badAttr])
    const r = parseBindingResponse(buf, txId)
    expect(r.ok).toBe(false)
  })
})

test.prop([fc.uint8Array({ maxLength: 576 })])(
  'parseBindingResponse never throws',
  (bytes) => {
    const r = parseBindingResponse(Buffer.from(bytes), crypto.randomBytes(12))
    expect(typeof r.ok).toBe('boolean')
  }
)

describe('parseBindingResponse additional branches', () => {
  it('rejects expectedTxId not 12 bytes', () => {
    const txId = crypto.randomBytes(12)
    const attr = buildMappedAddressAttr(
      STUN_ATTR_XOR_MAPPED_ADDRESS,
      [203, 0, 113, 1],
      80,
      txId
    )
    const buf = buildStunResponse(txId, [attr])
    const r = parseBindingResponse(buf, Buffer.alloc(8))
    expect(r.ok).toBe(false)
  })

  it('rejects when message length field exceeds buffer', () => {
    const txId = crypto.randomBytes(12)
    const header = Buffer.alloc(20)
    header.writeUInt16BE(STUN_MESSAGE_TYPE_BINDING_SUCCESS, 0)
    header.writeUInt16BE(9999, 2) // msgLen claims 9999 bytes but buffer only has header
    header.writeUInt32BE(STUN_MAGIC_COOKIE, 4)
    txId.copy(header, 8)
    const r = parseBindingResponse(header, txId)
    expect(r.ok).toBe(false)
  })

  it('rejects when no mapped address attribute present', () => {
    const txId = crypto.randomBytes(12)
    // Build response with zero-length attributes section (no address attr)
    const buf = buildStunResponse(txId, [])
    const r = parseBindingResponse(buf, txId)
    expect(r.ok).toBe(false)
  })

  it('rejects attribute with truncated header (< 4 bytes remaining)', () => {
    const txId = crypto.randomBytes(12)
    // Build a message with msgLen = 3 (only 3 bytes of attribute data, can't
    // even fit a 4-byte attribute header)
    const header = Buffer.alloc(20)
    header.writeUInt16BE(STUN_MESSAGE_TYPE_BINDING_SUCCESS, 0)
    header.writeUInt16BE(3, 2) // 3 bytes of payload
    header.writeUInt32BE(STUN_MAGIC_COOKIE, 4)
    txId.copy(header, 8)
    const payload = Buffer.alloc(3)
    const r = parseBindingResponse(Buffer.concat([header, payload]), txId)
    expect(r.ok).toBe(false)
  })

  it('returns null (skip) for MAPPED-ADDRESS with IPv6 family byte', () => {
    const txId = crypto.randomBytes(12)
    // Build a MAPPED-ADDRESS attr with family = 2 (IPv6) and a valid-length attr
    const attr = Buffer.alloc(12)
    attr.writeUInt16BE(STUN_ATTR_MAPPED_ADDRESS, 0)
    attr.writeUInt16BE(8, 2) // attrLen = 8
    attr[4] = 0
    attr[5] = 2 // family = IPv6 → should be skipped (return null)
    attr.writeUInt16BE(443, 6)
    attr[8] = 8
    attr[9] = 8
    attr[10] = 8
    attr[11] = 8
    const buf = buildStunResponse(txId, [attr])
    const r = parseBindingResponse(buf, txId)
    // Skipped MAPPED-ADDRESS, no XOR-MAPPED-ADDRESS either → no result
    expect(r.ok).toBe(false)
  })

  it('returns null (skip) for XOR-MAPPED-ADDRESS with IPv6 family byte', () => {
    const txId = crypto.randomBytes(12)
    const attr = Buffer.alloc(12)
    attr.writeUInt16BE(STUN_ATTR_XOR_MAPPED_ADDRESS, 0)
    attr.writeUInt16BE(8, 2)
    attr[4] = 0
    attr[5] = 2 // family = IPv6 → skip
    const buf = buildStunResponse(txId, [attr])
    const r = parseBindingResponse(buf, txId)
    expect(r.ok).toBe(false) // no address found
  })

  it('rejects MAPPED-ADDRESS attr shorter than 8 bytes', () => {
    const txId = crypto.randomBytes(12)
    const attr = Buffer.alloc(8)
    attr.writeUInt16BE(STUN_ATTR_MAPPED_ADDRESS, 0)
    attr.writeUInt16BE(4, 2) // attrLen = 4, which is < 8 minimum
    attr[4] = 0
    attr[5] = 1 // IPv4
    const buf = buildStunResponse(txId, [attr])
    const r = parseBindingResponse(buf, txId)
    expect(r.ok).toBe(false)
  })

  it('rejects XOR-MAPPED-ADDRESS attr shorter than 8 bytes', () => {
    const txId = crypto.randomBytes(12)
    const attr = Buffer.alloc(8)
    attr.writeUInt16BE(STUN_ATTR_XOR_MAPPED_ADDRESS, 0)
    attr.writeUInt16BE(4, 2) // attrLen = 4, which is < 8 minimum
    attr[4] = 0
    attr[5] = 1 // IPv4
    const buf = buildStunResponse(txId, [attr])
    const r = parseBindingResponse(buf, txId)
    expect(r.ok).toBe(false)
  })

  it('rejects when more than STUN_MAX_ATTRIBUTES attributes', () => {
    const txId = crypto.randomBytes(12)
    // Build 21 unknown-type attributes (4 bytes each: 2 type + 2 len, no value)
    // Unknown type 0xFFFF, attrLen=0 → each is 4 bytes with padding = 4 bytes
    const attrs: Buffer[] = []
    for (let i = 0; i <= 20; i++) {
      const attr = Buffer.alloc(4)
      attr.writeUInt16BE(0x9999, 0) // unknown attr type
      attr.writeUInt16BE(0, 2) // length 0
      attrs.push(attr)
    }
    const buf = buildStunResponse(txId, attrs)
    const r = parseBindingResponse(buf, txId)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toBe(ErrorCode.NatSecurityViolation)
  })
})
