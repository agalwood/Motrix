import { ErrorCode } from '@shared/errors'
import { isIpv4String, isLinkLocalIpv4, isPrivateIpv4 } from './ip-utils'
import { type ParseResult, parseErr, parseOk } from './parse-result'

export const SSDP_MULTICAST_ADDR = '239.255.255.250'
export const SSDP_MULTICAST_PORT = 1900
export const SSDP_IGD_V1_ST =
  'urn:schemas-upnp-org:device:InternetGatewayDevice:1'
export const SSDP_IGD_V2_ST =
  'urn:schemas-upnp-org:device:InternetGatewayDevice:2'

/**
 * IGD search targets probed during SSDP discovery, in order. A control point
 * must M-SEARCH for both InternetGatewayDevice:1 and :2 — a v2-only gateway
 * is not guaranteed to answer the v1 target, so searching v1 alone silently
 * misses it (this mirrors how miniupnpc fans out over multiple STs). The
 * first valid response wins regardless of which target produced it; the
 * device-description parser already accepts both WANIPConnection:1 and :2.
 */
export const SSDP_IGD_SEARCH_TARGETS = [SSDP_IGD_V1_ST, SSDP_IGD_V2_ST] as const

export const SSDP_MAX_RESPONSE_SIZE = 4096
export const SSDP_HEADER_NAME_MAX = 64
export const SSDP_HEADER_VALUE_MAX = 512
export const SSDP_LOCATION_MAX_LENGTH = 256

export interface SsdpResponse {
  location: string
  server: string
  st: string
  usn: string
  /**
   * The LOCATION URL decomposed and validated by {@link validateLocationUrl}.
   * Exposed so callers can fetch the device description without re-running the
   * same validation that already gated this response.
   */
  endpoint: { host: string; port: number; path: string }
}

export function buildMSearch(st: string, mx: number): Buffer {
  if (mx < 1 || mx > 5) throw new Error('MX must be in 1..5')
  if (!/^[A-Za-z0-9:\-._]+$/.test(st) || st.length > 128) {
    throw new Error('invalid ST')
  }
  const lines = [
    'M-SEARCH * HTTP/1.1',
    `HOST: ${SSDP_MULTICAST_ADDR}:${SSDP_MULTICAST_PORT}`,
    'MAN: "ssdp:discover"',
    `MX: ${mx}`,
    `ST: ${st}`,
    '',
    '',
  ]
  return Buffer.from(lines.join('\r\n'), 'ascii')
}

export function parseMSearchResponse(raw: Buffer): ParseResult<SsdpResponse> {
  if (raw.length > SSDP_MAX_RESPONSE_SIZE) {
    return parseErr(ErrorCode.NatSecurityViolation, 'ssdp response too large')
  }

  for (const b of raw) {
    if (b > 0x7e) {
      return parseErr(ErrorCode.NatSecurityViolation, 'non-ASCII byte')
    }
    if (b < 0x20 && b !== 0x09 && b !== 0x0a && b !== 0x0d) {
      return parseErr(ErrorCode.NatSecurityViolation, 'control byte in ssdp')
    }
  }

  const text = raw.toString('ascii')
  const lines = text.split('\r\n')
  if (lines.length === 0) {
    return parseErr(ErrorCode.NatParseError, 'empty response')
  }

  const statusLine = lines[0] ?? ''
  if (statusLine !== 'HTTP/1.1 200 OK' && statusLine !== 'HTTP/1.0 200 OK') {
    return parseErr(
      ErrorCode.NatParseError,
      `bad status: ${statusLine.slice(0, 64)}`
    )
  }

  const headers: Record<string, string> = {}
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i] ?? ''
    if (line.length === 0) break
    const colon = line.indexOf(':')
    if (colon <= 0) return parseErr(ErrorCode.NatParseError, 'malformed header')
    const name = line.slice(0, colon).trim().toUpperCase()
    const value = line.slice(colon + 1).trim()
    if (name.length > SSDP_HEADER_NAME_MAX) {
      return parseErr(ErrorCode.NatSecurityViolation, 'header name too long')
    }
    if (value.length > SSDP_HEADER_VALUE_MAX) {
      return parseErr(ErrorCode.NatSecurityViolation, 'header value too long')
    }
    // Dot is required: UPnP 1.1 (UDA §1.2.2) mandates BOOTID.UPNP.ORG /
    // CONFIGID.UPNP.ORG on every advertisement, and '.' is a legal RFC 9110
    // token character — without it every spec-compliant IGD is rejected.
    if (!/^[A-Za-z0-9.-]+$/.test(name)) {
      return parseErr(ErrorCode.NatParseError, 'invalid header name')
    }
    headers[name] = value
  }

  const location = headers.LOCATION
  const server = headers.SERVER ?? ''
  const st = headers.ST ?? ''
  const usn = headers.USN ?? ''

  if (!location) return parseErr(ErrorCode.NatParseError, 'missing LOCATION')
  if (location.length > SSDP_LOCATION_MAX_LENGTH) {
    return parseErr(ErrorCode.NatSecurityViolation, 'location too long')
  }

  const locCheck = validateLocationUrl(location)
  if (!locCheck.ok) return locCheck

  return parseOk({ location, server, st, usn, endpoint: locCheck.value })
}

export function validateLocationUrl(url: string): ParseResult<{
  host: string
  port: number
  path: string
}> {
  if (!url.startsWith('http://')) {
    return parseErr(ErrorCode.NatSecurityViolation, 'location must be http://')
  }
  const rest = url.slice('http://'.length)
  if (rest.includes('@')) {
    return parseErr(ErrorCode.NatSecurityViolation, 'userinfo forbidden')
  }
  if (rest.includes('#')) {
    return parseErr(ErrorCode.NatSecurityViolation, 'fragment forbidden')
  }
  if (rest.includes('?')) {
    return parseErr(ErrorCode.NatSecurityViolation, 'query forbidden')
  }

  const slashIx = rest.indexOf('/')
  const authority = slashIx >= 0 ? rest.slice(0, slashIx) : rest
  const path = slashIx >= 0 ? rest.slice(slashIx) : '/'

  let host: string
  let port = 80
  const colonIx = authority.indexOf(':')
  if (colonIx >= 0) {
    host = authority.slice(0, colonIx)
    const portStr = authority.slice(colonIx + 1)
    if (!/^\d{1,5}$/.test(portStr)) {
      return parseErr(ErrorCode.NatParseError, 'invalid port')
    }
    port = Number(portStr)
    if (port < 1 || port > 65535) {
      return parseErr(ErrorCode.NatParseError, 'port out of range')
    }
  } else {
    host = authority
  }

  if (!isIpv4String(host)) {
    return parseErr(ErrorCode.NatSecurityViolation, 'host must be literal IPv4')
  }
  if (!isPrivateIpv4(host) && !isLinkLocalIpv4(host)) {
    return parseErr(
      ErrorCode.NatSecurityViolation,
      'host must be private or link-local IPv4'
    )
  }

  for (let i = 0; i < path.length; i++) {
    const c = path.charCodeAt(i)
    if (c < 0x20 || c > 0x7e) {
      return parseErr(
        ErrorCode.NatSecurityViolation,
        'path contains disallowed byte'
      )
    }
  }

  return parseOk({ host, port, path })
}
