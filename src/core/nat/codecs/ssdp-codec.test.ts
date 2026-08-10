import { fc, test } from '@fast-check/vitest'
import { ErrorCode } from '@shared/errors'
import { describe, expect, it } from 'vitest'
import {
  buildMSearch,
  parseMSearchResponse,
  SSDP_IGD_V1_ST,
  SSDP_MULTICAST_ADDR,
  SSDP_MULTICAST_PORT,
  validateLocationUrl,
} from './ssdp-codec'

function buildSsdpResponse(overrides: Record<string, string>): Buffer {
  const defaults: Record<string, string> = {
    LOCATION: 'http://192.168.1.1:49152/rootDesc.xml',
    SERVER: 'Linux/3.0 UPnP/1.0 MiniUPnPd/2.0',
    ST: SSDP_IGD_V1_ST,
    USN: 'uuid:router-1::urn:schemas-upnp-org:device:InternetGatewayDevice:1',
  }
  const headers = { ...defaults, ...overrides }
  let text = 'HTTP/1.1 200 OK\r\n'
  for (const [k, v] of Object.entries(headers)) text += `${k}: ${v}\r\n`
  text += 'CACHE-CONTROL: max-age=1800\r\n'
  text += '\r\n'
  return Buffer.from(text, 'ascii')
}

describe('buildMSearch', () => {
  it('builds valid M-SEARCH request', () => {
    const buf = buildMSearch(SSDP_IGD_V1_ST, 2)
    const text = buf.toString('ascii')
    expect(text).toMatch(/^M-SEARCH \* HTTP\/1\.1\r\n/)
    expect(text).toContain(
      `HOST: ${SSDP_MULTICAST_ADDR}:${SSDP_MULTICAST_PORT}`
    )
    expect(text).toContain('MAN: "ssdp:discover"')
    expect(text).toContain('MX: 2')
    expect(text).toContain(`ST: ${SSDP_IGD_V1_ST}`)
    expect(text).toMatch(/\r\n\r\n$/)
  })

  it('rejects MX outside 1..5', () => {
    expect(() => buildMSearch(SSDP_IGD_V1_ST, 0)).toThrow()
    expect(() => buildMSearch(SSDP_IGD_V1_ST, 6)).toThrow()
  })

  it('rejects ST exceeding 128 characters', () => {
    const longSt = 'a'.repeat(129)
    expect(() => buildMSearch(longSt, 2)).toThrow('invalid ST')
  })

  it('rejects ST with disallowed characters', () => {
    expect(() => buildMSearch('bad ST value!', 2)).toThrow('invalid ST')
  })
})

describe('parseMSearchResponse happy path', () => {
  it('parses valid response with private-IP Location', () => {
    const raw = buildSsdpResponse({})
    const r = parseMSearchResponse(raw)
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.value.location).toBe('http://192.168.1.1:49152/rootDesc.xml')
      expect(r.value.server).toContain('MiniUPnPd')
    }
  })

  it.each([
    'http://10.0.0.1/desc.xml',
    'http://172.16.0.1:5000/desc.xml',
    'http://192.168.1.1:8008/gatedesc.xml',
    'http://169.254.1.1:80/root.xml',
  ])('accepts private/link-local Location %s', (loc) => {
    const raw = buildSsdpResponse({ LOCATION: loc })
    const r = parseMSearchResponse(raw)
    expect(r.ok).toBe(true)
  })

  it('accepts the dotted UPnP 1.1 headers every compliant IGD sends', () => {
    // UDA 1.1 §1.2.2 mandates BOOTID.UPNP.ORG / CONFIGID.UPNP.ORG; miniupnpd
    // also emits OPT/01-NLS. Rejecting the dot rejected every real router.
    const raw = buildSsdpResponse({
      OPT: '"http://schemas.upnp.org/upnp/1/0/"; ns=01',
      '01-NLS': '1786330815',
      'BOOTID.UPNP.ORG': '1786330815',
      'CONFIGID.UPNP.ORG': '1337',
    })
    const r = parseMSearchResponse(raw)
    expect(r.ok).toBe(true)
  })
})

describe('parseMSearchResponse security', () => {
  it('rejects response exceeding max size', () => {
    const huge = Buffer.alloc(5000, 0x20)
    const r = parseMSearchResponse(huge)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toBe(ErrorCode.NatSecurityViolation)
  })

  it('rejects non-200 status', () => {
    const raw = Buffer.from('HTTP/1.1 404 Not Found\r\n\r\n', 'ascii')
    const r = parseMSearchResponse(raw)
    expect(r.ok).toBe(false)
  })

  it.each([
    'file:///etc/passwd',
    'https://192.168.1.1/desc.xml',
    'data:text/plain,hello',
    'javascript:alert(1)',
    'ftp://192.168.1.1/x',
  ])('rejects non-http scheme: %s', (loc) => {
    const raw = buildSsdpResponse({ LOCATION: loc })
    const r = parseMSearchResponse(raw)
    expect(r.ok).toBe(false)
  })

  it.each([
    'http://8.8.8.8/desc.xml',
    'http://1.1.1.1/desc.xml',
    'http://evil.attacker.com/desc.xml',
    'http://127.0.0.1/desc.xml',
    'http://224.0.0.1/desc.xml',
  ])('rejects non-private-IP Location: %s', (loc) => {
    const raw = buildSsdpResponse({ LOCATION: loc })
    const r = parseMSearchResponse(raw)
    expect(r.ok).toBe(false)
  })

  it('rejects Location with userinfo', () => {
    const raw = buildSsdpResponse({
      LOCATION: 'http://user:pass@192.168.1.1/desc.xml',
    })
    const r = parseMSearchResponse(raw)
    expect(r.ok).toBe(false)
  })

  it('accepts multi-header response', () => {
    const text =
      'HTTP/1.1 200 OK\r\nLOCATION: http://192.168.1.1/\r\nEVIL: injected\r\n\r\n'
    const r = parseMSearchResponse(Buffer.from(text, 'ascii'))
    expect(r.ok).toBe(true)
  })

  it('rejects header exceeding max length', () => {
    const longLoc = `http://192.168.1.1:49152/${'x'.repeat(600)}`
    const raw = buildSsdpResponse({ LOCATION: longLoc })
    const r = parseMSearchResponse(raw)
    expect(r.ok).toBe(false)
  })
})

test.prop([fc.uint8Array({ maxLength: 4096 })])(
  'parseMSearchResponse never throws on random input',
  (bytes) => {
    const r = parseMSearchResponse(Buffer.from(bytes))
    expect(typeof r.ok).toBe('boolean')
  }
)

describe('parseMSearchResponse additional branches', () => {
  it('rejects header line without colon', () => {
    const text = 'HTTP/1.1 200 OK\r\nNO-COLON-HERE\r\n\r\n'
    const r = parseMSearchResponse(Buffer.from(text, 'ascii'))
    expect(r.ok).toBe(false)
  })

  it('rejects header name exceeding max length', () => {
    const longName = 'X'.repeat(65)
    const text = `HTTP/1.1 200 OK\r\n${longName}: value\r\n\r\n`
    const r = parseMSearchResponse(Buffer.from(text, 'ascii'))
    expect(r.ok).toBe(false)
  })

  it('rejects header name with invalid characters', () => {
    const text = 'HTTP/1.1 200 OK\r\nX_INVALID: value\r\n\r\n'
    const r = parseMSearchResponse(Buffer.from(text, 'ascii'))
    expect(r.ok).toBe(false)
  })

  it('rejects header value exceeding max length', () => {
    const longValue = 'x'.repeat(513)
    const text = `HTTP/1.1 200 OK\r\nLOCATION: ${longValue}\r\n\r\n`
    const r = parseMSearchResponse(Buffer.from(text, 'ascii'))
    expect(r.ok).toBe(false)
  })

  it('accepts HTTP/1.0 200 OK status line', () => {
    const text =
      'HTTP/1.0 200 OK\r\nLOCATION: http://192.168.1.1/desc.xml\r\n\r\n'
    const r = parseMSearchResponse(Buffer.from(text, 'ascii'))
    expect(r.ok).toBe(true)
  })
})

describe('validateLocationUrl additional branches', () => {
  it('accepts location without explicit path (authority only, defaults to /)', () => {
    const text = 'HTTP/1.1 200 OK\r\nLOCATION: http://192.168.1.1\r\n\r\n'
    const r = parseMSearchResponse(Buffer.from(text, 'ascii'))
    expect(r.ok).toBe(true)
  })

  it('rejects location with port out of range', () => {
    const text =
      'HTTP/1.1 200 OK\r\nLOCATION: http://192.168.1.1:99999/desc.xml\r\n\r\n'
    const r = parseMSearchResponse(Buffer.from(text, 'ascii'))
    expect(r.ok).toBe(false)
  })

  it('rejects location with non-numeric port', () => {
    const text =
      'HTTP/1.1 200 OK\r\nLOCATION: http://192.168.1.1:abc/desc.xml\r\n\r\n'
    const r = parseMSearchResponse(Buffer.from(text, 'ascii'))
    expect(r.ok).toBe(false)
  })

  it('rejects location with non-IPv4 host', () => {
    const text =
      'HTTP/1.1 200 OK\r\nLOCATION: http://router.local/desc.xml\r\n\r\n'
    const r = parseMSearchResponse(Buffer.from(text, 'ascii'))
    expect(r.ok).toBe(false)
  })

  it('rejects location with fragment', () => {
    const text =
      'HTTP/1.1 200 OK\r\nLOCATION: http://192.168.1.1/desc.xml#anchor\r\n\r\n'
    const r = parseMSearchResponse(Buffer.from(text, 'ascii'))
    expect(r.ok).toBe(false)
  })

  it('rejects location with query string', () => {
    const text =
      'HTTP/1.1 200 OK\r\nLOCATION: http://192.168.1.1/desc.xml?foo=bar\r\n\r\n'
    const r = parseMSearchResponse(Buffer.from(text, 'ascii'))
    expect(r.ok).toBe(false)
  })

  it('rejects location exceeding SSDP_LOCATION_MAX_LENGTH', () => {
    const longUrl = `http://192.168.1.1/${'x'.repeat(300)}`
    const text = `HTTP/1.1 200 OK\r\nLOCATION: ${longUrl}\r\n\r\n`
    const r = parseMSearchResponse(Buffer.from(text, 'ascii'))
    expect(r.ok).toBe(false)
  })
})

describe('validateLocationUrl direct call', () => {
  it('rejects path containing disallowed byte (direct call bypasses byte scanner)', () => {
    // validateLocationUrl is exported — call it directly with a URL whose path
    // contains a control character that would be blocked by parseMSearchResponse
    // but not by validateLocationUrl's own pre-checks
    const url = 'http://192.168.1.1/path\x01here'
    const r = validateLocationUrl(url)
    expect(r.ok).toBe(false)
  })
})
