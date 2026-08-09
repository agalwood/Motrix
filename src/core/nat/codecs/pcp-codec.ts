import crypto from 'node:crypto'
import { ErrorCode } from '@shared/errors'
import { PROTOCOL_MAX_LIFETIME_SECONDS } from './constants'
import { isValidPort } from './ip-utils'
import { type ParseResult, parseErr, parseOk } from './parse-result'

export const PCP_VERSION = 2
export const PCP_OPCODE_MAP = 1
export const PCP_OPCODE_PEER = 2

export const PCP_PROTOCOL_TCP = 6
export const PCP_PROTOCOL_UDP = 17

export const PCP_REQUEST_MAP_SIZE = 60
export const PCP_RESPONSE_MAP_MIN_SIZE = 60
export const PCP_RESPONSE_MAX_SIZE = 1100

export const PCP_NONCE_LEN = 12
/** Byte offset of the 12-byte mapping nonce within a PCP MAP packet. */
export const PCP_NONCE_OFFSET = 24

export interface PcpMapResponse {
  resultCode: number
  epochSeconds: number
  protocol: number
  internalPort: number
  externalPort: number
  externalIp: Buffer
  ttl: number
  /** The 12-byte mapping nonce, needed to delete this mapping (RFC 6887). */
  nonce: Buffer
}

export function buildPcpMapRequest(
  protocol: 'TCP' | 'UDP',
  internalPort: number,
  suggestedExternalPort: number,
  lifetime: number,
  clientIp: Buffer,
  existingNonce?: Buffer
): { request: Buffer; nonce: Buffer } {
  if (!isValidPort(internalPort)) {
    throw new Error('internalPort out of range')
  }
  if (clientIp.length !== 16) {
    throw new Error('clientIp must be 16 bytes (IPv6 / v4-mapped IPv6)')
  }
  if (!Number.isInteger(lifetime) || lifetime < 0 || lifetime > 0xffffffff) {
    throw new Error('lifetime out of range')
  }
  if (existingNonce && existingNonce.length !== PCP_NONCE_LEN) {
    throw new Error('existingNonce must be 12 bytes')
  }

  const nonce = existingNonce ?? crypto.randomBytes(PCP_NONCE_LEN)
  const buf = Buffer.alloc(PCP_REQUEST_MAP_SIZE)
  buf[0] = PCP_VERSION
  buf[1] = PCP_OPCODE_MAP
  buf.writeUInt16BE(0, 2)
  buf.writeUInt32BE(lifetime, 4)
  clientIp.copy(buf, 8)
  nonce.copy(buf, 24)
  buf[36] = protocol === 'TCP' ? PCP_PROTOCOL_TCP : PCP_PROTOCOL_UDP
  buf.writeUInt16BE(internalPort, 40)
  buf.writeUInt16BE(suggestedExternalPort, 42)
  return { request: buf, nonce }
}

export function parsePcpMapResponse(
  buf: Buffer,
  expectedNonce: Buffer,
  sourceIp: string,
  gatewayIp: string
): ParseResult<PcpMapResponse> {
  if (sourceIp !== gatewayIp) {
    return parseErr(ErrorCode.NatSecurityViolation, 'pcp source IP mismatch')
  }
  if (
    buf.length < PCP_RESPONSE_MAP_MIN_SIZE ||
    buf.length > PCP_RESPONSE_MAX_SIZE
  ) {
    return parseErr(
      ErrorCode.NatParseError,
      `pcp response length: ${buf.length}`
    )
  }
  if (expectedNonce.length !== PCP_NONCE_LEN) {
    return parseErr(ErrorCode.NatParseError, 'expectedNonce must be 12 bytes')
  }
  if (buf.readUInt8(0) !== PCP_VERSION) {
    return parseErr(
      ErrorCode.NatParseError,
      `pcp wrong version: ${buf.readUInt8(0)}`
    )
  }
  const rawOpcode = buf.readUInt8(1)
  if ((rawOpcode & 0x80) === 0) {
    return parseErr(ErrorCode.NatParseError, 'pcp response bit not set')
  }
  if ((rawOpcode & 0x7f) !== PCP_OPCODE_MAP) {
    return parseErr(ErrorCode.NatParseError, 'pcp opcode mismatch')
  }
  const resultCode = buf.readUInt8(3)
  if (resultCode !== 0) {
    return parseErr(
      ErrorCode.NatProtocolRejected,
      `pcp error: result code ${resultCode}`
    )
  }
  const lifetime = buf.readUInt32BE(4)
  const epochSeconds = buf.readUInt32BE(8)

  const responseNonce = buf.subarray(
    PCP_NONCE_OFFSET,
    PCP_NONCE_OFFSET + PCP_NONCE_LEN
  )
  let nonceOk = false
  try {
    nonceOk = crypto.timingSafeEqual(responseNonce, expectedNonce)
  } catch {
    nonceOk = false
  }
  if (!nonceOk) {
    return parseErr(ErrorCode.NatSecurityViolation, 'pcp nonce mismatch')
  }

  const protocol = buf.readUInt8(36)
  const internalPort = buf.readUInt16BE(40)
  const externalPort = buf.readUInt16BE(42)
  const externalIp = Buffer.from(buf.subarray(44, 60))

  const ttl = Math.min(lifetime, PROTOCOL_MAX_LIFETIME_SECONDS)

  return parseOk({
    resultCode,
    epochSeconds,
    protocol,
    internalPort,
    externalPort,
    externalIp,
    ttl,
    nonce: expectedNonce,
  })
}

/**
 * Extract the 12-byte mapping nonce from a raw PCP packet for correlation,
 * without fully parsing/validating it. Returns null when the buffer is not a
 * PCP MAP response (wrong version) or is too short to contain the nonce —
 * matching the demux pre-checks in PmpPcpClient.onMessage.
 */
export function peekPcpNonce(buf: Buffer): Buffer | null {
  if (buf.length < PCP_RESPONSE_MAP_MIN_SIZE) return null
  if (buf.readUInt8(0) !== PCP_VERSION) return null
  return buf.subarray(PCP_NONCE_OFFSET, PCP_NONCE_OFFSET + PCP_NONCE_LEN)
}
