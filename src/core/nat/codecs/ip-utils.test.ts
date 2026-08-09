import { fc, test } from '@fast-check/vitest'
import { describe, expect, it } from 'vitest'
import {
  bufferToIpv4,
  ipv4ToBuffer,
  isIpv4String,
  isLinkLocalIpv4,
  isLoopbackIpv4,
  isPrivateIpv4,
  isPublicIpv4,
  parseIpv4,
} from './ip-utils'

describe('isIpv4String', () => {
  it.each([
    ['192.168.1.1', true],
    ['10.0.0.1', true],
    ['127.0.0.1', true],
    ['255.255.255.255', true],
    ['0.0.0.0', true],
    ['256.0.0.1', false],
    ['1.2.3', false],
    ['1.2.3.4.5', false],
    ['abc', false],
    ['', false],
    ['192.168.1.1:8080', false],
    ['01.2.3.4', false],
  ])('classifies %s', (input, expected) => {
    expect(isIpv4String(input)).toBe(expected)
  })
})

describe('parseIpv4', () => {
  it('parses valid addresses', () => {
    const r = parseIpv4('192.168.1.1')
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.value).toEqual([192, 168, 1, 1])
  })

  it('rejects invalid addresses', () => {
    const r = parseIpv4('not.an.ip')
    expect(r.ok).toBe(false)
  })
})

describe('isPrivateIpv4', () => {
  it.each([
    ['10.0.0.1', true],
    ['10.255.255.255', true],
    ['172.16.0.1', true],
    ['172.31.255.255', true],
    ['172.15.0.1', false],
    ['172.32.0.1', false],
    ['192.168.0.1', true],
    ['192.168.255.255', true],
    ['8.8.8.8', false],
    ['127.0.0.1', false],
    ['224.0.0.1', false],
    ['255.255.255.255', false],
  ])('classifies %s', (ip, expected) => {
    expect(isPrivateIpv4(ip)).toBe(expected)
  })
})

describe('isLinkLocalIpv4', () => {
  it.each([
    ['169.254.0.1', true],
    ['169.254.255.255', true],
    ['169.253.0.1', false],
    ['169.255.0.1', false],
  ])('classifies %s', (ip, expected) => {
    expect(isLinkLocalIpv4(ip)).toBe(expected)
  })
})

describe('ipv4ToBuffer', () => {
  it('encodes 192.168.1.1', () => {
    const buf = ipv4ToBuffer('192.168.1.1')
    expect(buf).toEqual(Buffer.from([192, 168, 1, 1]))
  })
})

test.prop([fc.string({ maxLength: 40 })])('parseIpv4 never throws', (s) => {
  const r = parseIpv4(s)
  expect(typeof r.ok).toBe('boolean')
})

describe('isLoopbackIpv4', () => {
  it.each([
    ['127.0.0.1', true],
    ['127.255.255.255', true],
    ['128.0.0.1', false],
    ['not-an-ip', false],
  ])('classifies %s', (ip, expected) => {
    expect(isLoopbackIpv4(ip)).toBe(expected)
  })
})

describe('isPublicIpv4', () => {
  it.each([
    ['8.8.8.8', true],
    ['203.0.113.1', true],
    ['192.168.1.1', false],
    ['10.0.0.1', false],
    ['172.16.0.1', false],
    ['169.254.0.1', false],
    ['127.0.0.1', false],
    ['224.0.0.1', false],
    ['239.255.255.255', false],
    ['0.0.0.1', false],
    ['255.0.0.1', false],
    ['not-an-ip', false],
  ])('classifies %s', (ip, expected) => {
    expect(isPublicIpv4(ip)).toBe(expected)
  })
})

describe('bufferToIpv4', () => {
  it('converts a 4-byte buffer to dotted-quad', () => {
    expect(bufferToIpv4(Buffer.from([1, 2, 3, 4]))).toBe('1.2.3.4')
  })

  it('respects offset parameter', () => {
    expect(bufferToIpv4(Buffer.from([0, 0, 192, 168, 1, 1]), 2)).toBe(
      '192.168.1.1'
    )
  })

  it('throws when buffer too short', () => {
    expect(() => bufferToIpv4(Buffer.alloc(3))).toThrow()
  })

  it('throws on invalid IPv4 in ipv4ToBuffer', () => {
    expect(() => ipv4ToBuffer('not-an-ip')).toThrow()
  })
})
