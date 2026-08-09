import crypto from 'node:crypto'
import { fc, test } from '@fast-check/vitest'
import { ErrorCode } from '@shared/errors'
import { describe, expect, it } from 'vitest'
import {
  buildPcpMapRequest,
  PCP_OPCODE_MAP,
  PCP_PROTOCOL_TCP,
  PCP_VERSION,
  parsePcpMapResponse,
} from './pcp-codec'

function buildMockResponse(opts: {
  version?: number
  opcode?: number
  resultCode?: number
  lifetime?: number
  nonce: Buffer
  internalPort?: number
  externalPort?: number
  externalIp?: Buffer
  protocol?: number
}): Buffer {
  const buf = Buffer.alloc(60)
  buf[0] = opts.version ?? PCP_VERSION
  buf[1] = 0x80 | (opts.opcode ?? PCP_OPCODE_MAP)
  buf[2] = 0
  buf[3] = opts.resultCode ?? 0
  buf.writeUInt32BE(opts.lifetime ?? 7200, 4)
  buf.writeUInt32BE(60, 8)
  opts.nonce.copy(buf, 24)
  buf[36] = opts.protocol ?? PCP_PROTOCOL_TCP
  buf.writeUInt16BE(opts.internalPort ?? 6881, 40)
  buf.writeUInt16BE(opts.externalPort ?? 6881, 42)
  const defaultIp = Buffer.concat([
    Buffer.alloc(10),
    Buffer.from([0xff, 0xff]),
    Buffer.from([203, 0, 113, 42]),
  ])
  ;(opts.externalIp ?? defaultIp).copy(buf, 44)
  return buf
}

describe('buildPcpMapRequest', () => {
  it('produces 60-byte request with fresh nonce', () => {
    const clientIp = Buffer.concat([
      Buffer.alloc(10),
      Buffer.from([0xff, 0xff]),
      Buffer.from([192, 168, 1, 100]),
    ])
    const { request, nonce } = buildPcpMapRequest(
      'TCP',
      6881,
      6881,
      7200,
      clientIp
    )
    expect(request.length).toBe(60)
    expect(request[0]).toBe(PCP_VERSION)
    expect(request[1]).toBe(PCP_OPCODE_MAP)
    expect(request.readUInt32BE(4)).toBe(7200)
    expect(nonce.length).toBe(12)
    expect(request.subarray(24, 36).equals(nonce)).toBe(true)
  })

  it('two successive calls produce different nonces', () => {
    const clientIp = Buffer.concat([
      Buffer.alloc(10),
      Buffer.from([0xff, 0xff]),
      Buffer.from([192, 168, 1, 1]),
    ])
    const a = buildPcpMapRequest('TCP', 6881, 6881, 7200, clientIp)
    const b = buildPcpMapRequest('TCP', 6881, 6881, 7200, clientIp)
    expect(a.nonce.equals(b.nonce)).toBe(false)
  })
})

describe('parsePcpMapResponse', () => {
  it('accepts matching nonce', () => {
    const nonce = crypto.randomBytes(12)
    const buf = buildMockResponse({ nonce })
    const r = parsePcpMapResponse(buf, nonce, '192.168.1.1', '192.168.1.1')
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.value.externalPort).toBe(6881)
      expect(r.value.ttl).toBe(7200)
    }
  })

  it('rejects mismatched nonce (response spoofing)', () => {
    const nonce = crypto.randomBytes(12)
    const badNonce = crypto.randomBytes(12)
    const buf = buildMockResponse({ nonce: badNonce })
    const r = parsePcpMapResponse(buf, nonce, '192.168.1.1', '192.168.1.1')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toBe(ErrorCode.NatSecurityViolation)
  })

  it('rejects wrong source IP', () => {
    const nonce = crypto.randomBytes(12)
    const buf = buildMockResponse({ nonce })
    const r = parsePcpMapResponse(buf, nonce, '10.0.0.99', '192.168.1.1')
    expect(r.ok).toBe(false)
  })

  it('rejects wrong version', () => {
    const nonce = crypto.randomBytes(12)
    const buf = buildMockResponse({ nonce, version: 1 })
    const r = parsePcpMapResponse(buf, nonce, '192.168.1.1', '192.168.1.1')
    expect(r.ok).toBe(false)
  })

  it('rejects wrong opcode', () => {
    const nonce = crypto.randomBytes(12)
    const buf = buildMockResponse({ nonce, opcode: 99 })
    const r = parsePcpMapResponse(buf, nonce, '192.168.1.1', '192.168.1.1')
    expect(r.ok).toBe(false)
  })

  it('rejects buffer shorter than 60 bytes', () => {
    const nonce = crypto.randomBytes(12)
    const buf = Buffer.alloc(30)
    const r = parsePcpMapResponse(buf, nonce, '192.168.1.1', '192.168.1.1')
    expect(r.ok).toBe(false)
  })

  it('clamps excessive lifetime', () => {
    const nonce = crypto.randomBytes(12)
    const buf = buildMockResponse({ nonce, lifetime: 0x7fffffff })
    const r = parsePcpMapResponse(buf, nonce, '192.168.1.1', '192.168.1.1')
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.value.ttl).toBeLessThanOrEqual(86400)
  })

  it('rejects non-zero result code as protocol error', () => {
    const nonce = crypto.randomBytes(12)
    const buf = buildMockResponse({ nonce, resultCode: 2 })
    const r = parsePcpMapResponse(buf, nonce, '192.168.1.1', '192.168.1.1')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toBe(ErrorCode.NatProtocolRejected)
  })
})

test.prop([fc.uint8Array({ maxLength: 128 })])(
  'parsePcpMapResponse never throws',
  (bytes) => {
    const nonce = crypto.randomBytes(12)
    const r = parsePcpMapResponse(
      Buffer.from(bytes),
      nonce,
      '192.168.1.1',
      '192.168.1.1'
    )
    expect(typeof r.ok).toBe('boolean')
  }
)

describe('buildPcpMapRequest additional branches', () => {
  it('rejects clientIp not 16 bytes', () => {
    expect(() =>
      buildPcpMapRequest('TCP', 6881, 6881, 7200, Buffer.alloc(4))
    ).toThrow('clientIp must be 16 bytes')
  })

  it('rejects lifetime out of range', () => {
    const clientIp = Buffer.alloc(16)
    expect(() => buildPcpMapRequest('TCP', 6881, 6881, -1, clientIp)).toThrow(
      'lifetime out of range'
    )
  })

  it('sets UDP protocol byte when protocol is UDP', () => {
    const clientIp = Buffer.alloc(16)
    const { request } = buildPcpMapRequest('UDP', 6881, 0, 0, clientIp)
    expect(request[36]).toBe(17) // PCP_PROTOCOL_UDP
  })
})

describe('parsePcpMapResponse additional branches', () => {
  it('rejects expectedNonce not 12 bytes', () => {
    const buf = buildMockResponse({ nonce: crypto.randomBytes(12) })
    const r = parsePcpMapResponse(
      buf,
      Buffer.alloc(8),
      '192.168.1.1',
      '192.168.1.1'
    )
    expect(r.ok).toBe(false)
  })

  it('rejects missing response bit in opcode', () => {
    const nonce = crypto.randomBytes(12)
    const buf = buildMockResponse({ nonce })
    buf[1] = PCP_OPCODE_MAP // no high bit
    const r = parsePcpMapResponse(buf, nonce, '192.168.1.1', '192.168.1.1')
    expect(r.ok).toBe(false)
  })

  it('rejects buffer exceeding max size', () => {
    const nonce = crypto.randomBytes(12)
    const big = Buffer.alloc(1101)
    const r = parsePcpMapResponse(big, nonce, '192.168.1.1', '192.168.1.1')
    expect(r.ok).toBe(false)
  })
})
