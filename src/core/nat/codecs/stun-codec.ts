import crypto from 'node:crypto'
import { ErrorCode } from '@shared/errors'
import { isPublicIpv4 } from './ip-utils'
import { type ParseResult, parseErr, parseOk } from './parse-result'

export const STUN_MAGIC_COOKIE = 0x2112a442
export const STUN_HEADER_SIZE = 20
export const STUN_MAX_RESPONSE_SIZE = 576
export const STUN_MAX_ATTRIBUTES = 20
export const STUN_TXN_ID_SIZE = 12

export const STUN_MESSAGE_TYPE_BINDING_REQUEST = 0x0001
export const STUN_MESSAGE_TYPE_BINDING_SUCCESS = 0x0101

export const STUN_ATTR_MAPPED_ADDRESS = 0x0001
export const STUN_ATTR_XOR_MAPPED_ADDRESS = 0x0020

const STUN_ADDRESS_FAMILY_V4 = 1

export interface StunResult {
  mappedIp: string
  mappedPort: number
}

export function buildBindingRequest(): {
  buffer: Buffer
  transactionId: Buffer
} {
  const transactionId = crypto.randomBytes(STUN_TXN_ID_SIZE)
  const buffer = Buffer.alloc(STUN_HEADER_SIZE)
  buffer.writeUInt16BE(STUN_MESSAGE_TYPE_BINDING_REQUEST, 0)
  buffer.writeUInt16BE(0, 2)
  buffer.writeUInt32BE(STUN_MAGIC_COOKIE, 4)
  transactionId.copy(buffer, 8)
  return { buffer, transactionId }
}

export function parseBindingResponse(
  buf: Buffer,
  expectedTxId: Buffer
): ParseResult<StunResult> {
  if (buf.length < STUN_HEADER_SIZE || buf.length > STUN_MAX_RESPONSE_SIZE) {
    return parseErr(ErrorCode.NatParseError, `stun length: ${buf.length}`)
  }
  if (expectedTxId.length !== STUN_TXN_ID_SIZE) {
    return parseErr(ErrorCode.NatParseError, 'expectedTxId must be 12 bytes')
  }

  const msgType = buf.readUInt16BE(0)
  if (msgType !== STUN_MESSAGE_TYPE_BINDING_SUCCESS) {
    return parseErr(
      ErrorCode.NatParseError,
      `stun msg type: ${msgType.toString(16)}`
    )
  }

  const msgLen = buf.readUInt16BE(2)
  if (STUN_HEADER_SIZE + msgLen > buf.length) {
    return parseErr(
      ErrorCode.NatParseError,
      'stun message length exceeds buffer'
    )
  }

  const cookieBuf = Buffer.alloc(4)
  cookieBuf.writeUInt32BE(STUN_MAGIC_COOKIE, 0)
  if (!safeEqual(buf.subarray(4, 8), cookieBuf)) {
    return parseErr(ErrorCode.NatSecurityViolation, 'stun wrong magic cookie')
  }

  const txId = buf.subarray(8, 20)
  if (!safeEqual(txId, expectedTxId)) {
    return parseErr(ErrorCode.NatSecurityViolation, 'stun txId mismatch')
  }

  let xorMapped: StunResult | null = null
  let mapped: StunResult | null = null
  let offset = STUN_HEADER_SIZE
  let attrCount = 0
  const end = STUN_HEADER_SIZE + msgLen

  while (offset < end) {
    if (attrCount++ >= STUN_MAX_ATTRIBUTES) {
      return parseErr(
        ErrorCode.NatSecurityViolation,
        'too many stun attributes'
      )
    }
    if (offset + 4 > end) {
      return parseErr(ErrorCode.NatParseError, 'attribute header truncated')
    }
    const attrType = buf.readUInt16BE(offset)
    const attrLen = buf.readUInt16BE(offset + 2)
    if (offset + 4 + attrLen > end) {
      return parseErr(ErrorCode.NatParseError, 'attribute value exceeds bounds')
    }

    const attrStart = offset + 4
    if (attrType === STUN_ATTR_MAPPED_ADDRESS) {
      const parsed = parseMappedAddress(buf, attrStart, attrLen)
      if (!parsed.ok) return parsed
      if (parsed.value) mapped = parsed.value
    } else if (attrType === STUN_ATTR_XOR_MAPPED_ADDRESS) {
      const parsed = parseXorMappedAddress(buf, attrStart, attrLen)
      if (!parsed.ok) return parsed
      if (parsed.value) xorMapped = parsed.value
    }

    offset += 4 + padTo4(attrLen)
  }

  const result = xorMapped ?? mapped
  if (!result) {
    return parseErr(ErrorCode.NatParseError, 'no mapped address attribute')
  }
  if (!isPublicIpv4(result.mappedIp)) {
    return parseErr(
      ErrorCode.NatSecurityViolation,
      'stun returned non-public IP'
    )
  }
  return parseOk(result)
}

function padTo4(n: number): number {
  return (n + 3) & ~3
}

function parseMappedAddress(
  buf: Buffer,
  offset: number,
  length: number
): ParseResult<StunResult | null> {
  if (length < 8) {
    return parseErr(ErrorCode.NatParseError, 'mapped-address attr too short')
  }
  const family = buf.readUInt8(offset + 1)
  if (family !== STUN_ADDRESS_FAMILY_V4) return parseOk(null)
  const port = buf.readUInt16BE(offset + 2)
  const ip = `${buf.readUInt8(offset + 4)}.${buf.readUInt8(offset + 5)}.${buf.readUInt8(offset + 6)}.${buf.readUInt8(offset + 7)}`
  return parseOk({ mappedIp: ip, mappedPort: port })
}

function parseXorMappedAddress(
  buf: Buffer,
  offset: number,
  length: number
): ParseResult<StunResult | null> {
  if (length < 8) {
    return parseErr(
      ErrorCode.NatParseError,
      'xor-mapped-address attr too short'
    )
  }
  const family = buf.readUInt8(offset + 1)
  if (family !== STUN_ADDRESS_FAMILY_V4) return parseOk(null)
  const xorPortRaw = buf.readUInt16BE(offset + 2)
  const port = xorPortRaw ^ (STUN_MAGIC_COOKIE >>> 16)
  const cookieBuf = Buffer.alloc(4)
  cookieBuf.writeUInt32BE(STUN_MAGIC_COOKIE, 0)
  const ipOctets = [
    (buf.readUInt8(offset + 4) ^ (cookieBuf.readUInt8(0) ?? 0)) & 0xff,
    (buf.readUInt8(offset + 5) ^ (cookieBuf.readUInt8(1) ?? 0)) & 0xff,
    (buf.readUInt8(offset + 6) ^ (cookieBuf.readUInt8(2) ?? 0)) & 0xff,
    (buf.readUInt8(offset + 7) ^ (cookieBuf.readUInt8(3) ?? 0)) & 0xff,
  ]
  const ip = `${ipOctets[0]}.${ipOctets[1]}.${ipOctets[2]}.${ipOctets[3]}`
  return parseOk({ mappedIp: ip, mappedPort: port })
}

function safeEqual(a: Buffer, b: Buffer): boolean {
  if (a.length !== b.length) return false
  try {
    return crypto.timingSafeEqual(a, b)
  } catch {
    return false
  }
}
