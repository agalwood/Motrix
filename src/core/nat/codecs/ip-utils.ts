import { ErrorCode } from '@shared/errors'
import { type ParseResult, parseErr, parseOk } from './parse-result'

// Strict IPv4 dotted-quad format: four decimal octets 0..255, no leading zeros
// except the single digit "0" itself.
const IPV4_RE = /^(?:0|[1-9]\d{0,2})(?:\.(?:0|[1-9]\d{0,2})){3}$/

/**
 * True when `n` is an integer in the valid TCP/UDP port range. By default the
 * range is 1..65535; pass `{ allowZero: true }` to also accept 0 (used where
 * 0 is a protocol-level "wildcard / any" sentinel, e.g. NAT-PMP external
 * port).
 */
export function isValidPort(
  n: number,
  opts: { allowZero?: boolean } = {}
): boolean {
  const min = opts.allowZero ? 0 : 1
  return Number.isInteger(n) && n >= min && n <= 65535
}

export function isIpv4String(s: string): boolean {
  if (!IPV4_RE.test(s)) return false
  for (const part of s.split('.')) {
    const n = Number(part)
    if (n < 0 || n > 255) return false
  }
  return true
}

export function parseIpv4(
  s: string
): ParseResult<readonly [number, number, number, number]> {
  if (!isIpv4String(s)) {
    return parseErr(ErrorCode.NatParseError, `invalid IPv4: ${s.slice(0, 32)}`)
  }
  const [a, b, c, d] = s.split('.').map(Number) as [
    number,
    number,
    number,
    number,
  ]
  return parseOk([a, b, c, d] as const)
}

export function isPrivateIpv4(s: string): boolean {
  const r = parseIpv4(s)
  if (!r.ok) return false
  const [a, b] = r.value
  if (a === 10) return true
  if (a === 172 && b >= 16 && b <= 31) return true
  if (a === 192 && b === 168) return true
  return false
}

export function isLinkLocalIpv4(s: string): boolean {
  const r = parseIpv4(s)
  if (!r.ok) return false
  const [a, b] = r.value
  return a === 169 && b === 254
}

export function isLoopbackIpv4(s: string): boolean {
  const r = parseIpv4(s)
  if (!r.ok) return false
  return r.value[0] === 127
}

export function isPublicIpv4(s: string): boolean {
  if (!isIpv4String(s)) return false
  if (isPrivateIpv4(s) || isLinkLocalIpv4(s) || isLoopbackIpv4(s)) return false
  const r = parseIpv4(s)
  if (!r.ok) return false
  const [a] = r.value
  if (a >= 224 && a <= 239) return false
  if (a === 0 || a === 255) return false
  return true
}

export function ipv4ToBuffer(s: string): Buffer {
  const r = parseIpv4(s)
  if (!r.ok) throw new Error(`invalid IPv4: ${s}`)
  return Buffer.from(r.value)
}

export function bufferToIpv4(buf: Buffer, offset = 0): string {
  if (buf.length < offset + 4) throw new Error('buffer too short for IPv4')
  return `${buf.readUInt8(offset)}.${buf.readUInt8(offset + 1)}.${buf.readUInt8(offset + 2)}.${buf.readUInt8(offset + 3)}`
}
