import { fc, test } from '@fast-check/vitest'
import { ErrorCode } from '@shared/errors'
import { describe, expect, it } from 'vitest'
import {
  buildExternalIpRequest,
  buildMappingRequest,
  NATPMP_OPCODE_EXTERNAL_IP,
  NATPMP_OPCODE_MAP_TCP,
  NATPMP_OPCODE_MAP_UDP,
  parseNatPmpResponse,
} from './natpmp-codec'

describe('buildExternalIpRequest', () => {
  it('produces 2-byte request', () => {
    const buf = buildExternalIpRequest()
    expect(buf.length).toBe(2)
    expect(buf[0]).toBe(0)
    expect(buf[1]).toBe(0)
  })
})

describe('buildMappingRequest', () => {
  it('produces 12-byte TCP map request', () => {
    const buf = buildMappingRequest('TCP', 6881, 6881, 7200)
    expect(buf.length).toBe(12)
    expect(buf[0]).toBe(0)
    expect(buf[1]).toBe(NATPMP_OPCODE_MAP_TCP)
    expect(buf.readUInt16BE(2)).toBe(0)
    expect(buf.readUInt16BE(4)).toBe(6881)
    expect(buf.readUInt16BE(6)).toBe(6881)
    expect(buf.readUInt32BE(8)).toBe(7200)
  })

  it('produces UDP map request with correct opcode', () => {
    const buf = buildMappingRequest('UDP', 6881, 6881, 7200)
    expect(buf[1]).toBe(NATPMP_OPCODE_MAP_UDP)
  })

  it('rejects out-of-range port', () => {
    expect(() => buildMappingRequest('TCP', 0, 6881, 7200)).toThrow()
    expect(() => buildMappingRequest('TCP', 70000, 6881, 7200)).toThrow()
  })

  it('rejects out-of-range ttl', () => {
    expect(() => buildMappingRequest('TCP', 6881, 6881, -1)).toThrow()
  })
})

describe('parseNatPmpResponse external IP', () => {
  function buildExternalIpResponse(
    resultCode: number,
    ip: [number, number, number, number]
  ): Buffer {
    const buf = Buffer.alloc(12)
    buf[0] = 0
    buf[1] = 128 | NATPMP_OPCODE_EXTERNAL_IP
    buf.writeUInt16BE(resultCode, 2)
    buf.writeUInt32BE(1234, 4)
    buf[8] = ip[0]
    buf[9] = ip[1]
    buf[10] = ip[2]
    buf[11] = ip[3]
    return buf
  }

  it('parses successful external IP response', () => {
    const buf = buildExternalIpResponse(0, [203, 0, 113, 42])
    const r = parseNatPmpResponse(
      buf,
      NATPMP_OPCODE_EXTERNAL_IP,
      '192.168.1.1',
      '192.168.1.1'
    )
    expect(r.ok).toBe(true)
    if (r.ok && r.value.kind === 'external-ip') {
      expect(r.value.externalIp).toBe('203.0.113.42')
    }
  })

  it('rejects response from wrong source IP', () => {
    const buf = buildExternalIpResponse(0, [203, 0, 113, 42])
    const r = parseNatPmpResponse(
      buf,
      NATPMP_OPCODE_EXTERNAL_IP,
      '10.0.0.99',
      '192.168.1.1'
    )
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toBe(ErrorCode.NatSecurityViolation)
  })

  it('rejects wrong length', () => {
    const buf = Buffer.alloc(10)
    const r = parseNatPmpResponse(
      buf,
      NATPMP_OPCODE_EXTERNAL_IP,
      '1.1.1.1',
      '1.1.1.1'
    )
    expect(r.ok).toBe(false)
  })

  it('rejects wrong version', () => {
    const buf = buildExternalIpResponse(0, [1, 2, 3, 4])
    buf[0] = 1
    const r = parseNatPmpResponse(
      buf,
      NATPMP_OPCODE_EXTERNAL_IP,
      '1.1.1.1',
      '1.1.1.1'
    )
    expect(r.ok).toBe(false)
  })

  it('rejects missing response bit', () => {
    const buf = buildExternalIpResponse(0, [1, 2, 3, 4])
    buf[1] = NATPMP_OPCODE_EXTERNAL_IP
    const r = parseNatPmpResponse(
      buf,
      NATPMP_OPCODE_EXTERNAL_IP,
      '1.1.1.1',
      '1.1.1.1'
    )
    expect(r.ok).toBe(false)
  })

  it('rejects non-zero result code as protocol error', () => {
    for (const code of [1, 2, 3, 4, 5]) {
      const buf = buildExternalIpResponse(code, [1, 2, 3, 4])
      const r = parseNatPmpResponse(
        buf,
        NATPMP_OPCODE_EXTERNAL_IP,
        '1.1.1.1',
        '1.1.1.1'
      )
      expect(r.ok).toBe(false)
      if (!r.ok) expect(r.error).toBe(ErrorCode.NatProtocolRejected)
    }
  })
})

describe('parseNatPmpResponse mapping', () => {
  function buildMapResponse(
    opcode: number,
    resultCode: number,
    intPort: number,
    extPort: number,
    ttl: number
  ): Buffer {
    const buf = Buffer.alloc(16)
    buf[0] = 0
    buf[1] = 128 | opcode
    buf.writeUInt16BE(resultCode, 2)
    buf.writeUInt32BE(0, 4)
    buf.writeUInt16BE(intPort, 8)
    buf.writeUInt16BE(extPort, 10)
    buf.writeUInt32BE(ttl, 12)
    return buf
  }

  it('parses successful TCP mapping', () => {
    const buf = buildMapResponse(NATPMP_OPCODE_MAP_TCP, 0, 6881, 6881, 7200)
    const r = parseNatPmpResponse(
      buf,
      NATPMP_OPCODE_MAP_TCP,
      '192.168.1.1',
      '192.168.1.1'
    )
    expect(r.ok).toBe(true)
    if (r.ok && r.value.kind === 'mapping') {
      expect(r.value.externalPort).toBe(6881)
      expect(r.value.ttl).toBe(7200)
    }
  })

  it('clamps TTL to 86400', () => {
    const buf = buildMapResponse(NATPMP_OPCODE_MAP_TCP, 0, 6881, 6881, 999999)
    const r = parseNatPmpResponse(
      buf,
      NATPMP_OPCODE_MAP_TCP,
      '192.168.1.1',
      '192.168.1.1'
    )
    expect(r.ok).toBe(true)
    if (r.ok && r.value.kind === 'mapping') expect(r.value.ttl).toBe(86400)
  })

  it('rejects non-zero result code in mapping response', () => {
    const buf = buildMapResponse(NATPMP_OPCODE_MAP_TCP, 3, 6881, 6881, 7200)
    const r = parseNatPmpResponse(
      buf,
      NATPMP_OPCODE_MAP_TCP,
      '1.1.1.1',
      '1.1.1.1'
    )
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toBe(ErrorCode.NatProtocolRejected)
  })
})

test.prop([fc.uint8Array({ minLength: 0, maxLength: 64 })])(
  'parseNatPmpResponse never throws',
  (bytes) => {
    const r = parseNatPmpResponse(
      Buffer.from(bytes),
      NATPMP_OPCODE_EXTERNAL_IP,
      '1.1.1.1',
      '1.1.1.1'
    )
    expect(typeof r.ok).toBe('boolean')
  }
)

describe('buildMappingRequest additional branches', () => {
  it('rejects non-integer internalPort', () => {
    expect(() => buildMappingRequest('TCP', 1.5, 6881, 7200)).toThrow()
  })

  it('rejects externalPort out of range', () => {
    expect(() => buildMappingRequest('TCP', 6881, 70000, 7200)).toThrow()
  })

  it('rejects non-integer externalPort', () => {
    expect(() => buildMappingRequest('TCP', 6881, 1.5, 7200)).toThrow()
  })

  it('rejects TTL exceeding uint32 max', () => {
    expect(() => buildMappingRequest('TCP', 6881, 6881, 0x100000000)).toThrow()
  })
})

describe('parseNatPmpResponse additional branches', () => {
  it('rejects opcode mismatch', () => {
    const buf = Buffer.alloc(12)
    buf[0] = 0
    buf[1] = 128 | NATPMP_OPCODE_MAP_TCP // response bit + TCP opcode
    buf.writeUInt16BE(0, 2)
    buf.writeUInt32BE(0, 4)
    // but expected opcode is external IP
    const r = parseNatPmpResponse(
      buf,
      NATPMP_OPCODE_EXTERNAL_IP,
      '1.1.1.1',
      '1.1.1.1'
    )
    expect(r.ok).toBe(false)
  })

  it('rejects invalid result code > 5', () => {
    const buf = Buffer.alloc(12)
    buf[0] = 0
    buf[1] = 128 | NATPMP_OPCODE_EXTERNAL_IP
    buf.writeUInt16BE(6, 2) // result code 6 is invalid
    buf.writeUInt32BE(0, 4)
    const r = parseNatPmpResponse(
      buf,
      NATPMP_OPCODE_EXTERNAL_IP,
      '1.1.1.1',
      '1.1.1.1'
    )
    expect(r.ok).toBe(false)
  })

  it('rejects external-IP response with length 16 instead of 12', () => {
    const buf = Buffer.alloc(16)
    buf[0] = 0
    buf[1] = 128 | NATPMP_OPCODE_EXTERNAL_IP
    buf.writeUInt16BE(0, 2)
    buf.writeUInt32BE(0, 4)
    const r = parseNatPmpResponse(
      buf,
      NATPMP_OPCODE_EXTERNAL_IP,
      '1.1.1.1',
      '1.1.1.1'
    )
    expect(r.ok).toBe(false)
  })

  it('rejects mapping response with length 12 instead of 16', () => {
    const buf = Buffer.alloc(12)
    buf[0] = 0
    buf[1] = 128 | NATPMP_OPCODE_MAP_TCP
    buf.writeUInt16BE(0, 2)
    buf.writeUInt32BE(0, 4)
    const r = parseNatPmpResponse(
      buf,
      NATPMP_OPCODE_MAP_TCP,
      '1.1.1.1',
      '1.1.1.1'
    )
    expect(r.ok).toBe(false)
  })
})
