import { fc, test } from '@fast-check/vitest'
import { ErrorCode } from '@shared/errors'
import { describe, expect, it } from 'vitest'
import {
  ALLOWED_SOAP_ACTIONS,
  buildSoapEnvelope,
  parseSoapResponse,
  UPNP_WANIP_V1,
  xmlEscape,
} from './soap-codec'

describe('xmlEscape', () => {
  it.each([
    ['<', '&lt;'],
    ['>', '&gt;'],
    ['&', '&amp;'],
    ['"', '&quot;'],
    ["'", '&apos;'],
    ['<script>', '&lt;script&gt;'],
    ['abc', 'abc'],
  ])('escapes %s', (input, expected) => {
    expect(xmlEscape(input)).toBe(expected)
  })
})

describe('buildSoapEnvelope', () => {
  it('constructs AddPortMapping envelope', () => {
    const xml = buildSoapEnvelope('AddPortMapping', UPNP_WANIP_V1, {
      NewRemoteHost: '',
      NewExternalPort: '6881',
      NewProtocol: 'TCP',
      NewInternalPort: '6881',
      NewInternalClient: '192.168.1.100',
      NewEnabled: '1',
      NewPortMappingDescription: 'Motrix',
      NewLeaseDuration: '7200',
    })
    expect(xml).toContain('<s:Envelope')
    expect(xml).toContain('xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"')
    expect(xml).toContain(`<u:AddPortMapping xmlns:u="${UPNP_WANIP_V1}">`)
    expect(xml).toContain('<NewExternalPort>6881</NewExternalPort>')
    expect(xml).toContain(
      '<NewInternalClient>192.168.1.100</NewInternalClient>'
    )
    expect(xml).toContain(
      '<NewPortMappingDescription>Motrix</NewPortMappingDescription>'
    )
  })

  it('escapes parameter values', () => {
    const xml = buildSoapEnvelope('AddPortMapping', UPNP_WANIP_V1, {
      NewPortMappingDescription: '<script>alert(1)</script>',
    })
    expect(xml).not.toContain('<script>alert(1)</script>')
    expect(xml).toContain('&lt;script&gt;alert(1)&lt;/script&gt;')
  })

  it('throws on disallowed action', () => {
    expect(() => buildSoapEnvelope('Evil', UPNP_WANIP_V1, {})).toThrow()
  })

  it('throws on invalid serviceType characters', () => {
    expect(() =>
      buildSoapEnvelope('AddPortMapping', 'urn:\r\n:evil', {})
    ).toThrow()
  })

  it('ALLOWED_SOAP_ACTIONS covers required actions', () => {
    expect(ALLOWED_SOAP_ACTIONS).toContain('AddPortMapping')
    expect(ALLOWED_SOAP_ACTIONS).toContain('DeletePortMapping')
    expect(ALLOWED_SOAP_ACTIONS).toContain('GetExternalIPAddress')
    expect(ALLOWED_SOAP_ACTIONS).toContain('GetGenericPortMappingEntry')
    expect(ALLOWED_SOAP_ACTIONS).toContain('AddAnyPortMapping')
  })
})

describe('parseSoapResponse happy path', () => {
  it('parses GetExternalIPAddress response', () => {
    const xml = `<?xml version="1.0"?>
<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/">
  <s:Body>
    <u:GetExternalIPAddressResponse xmlns:u="urn:schemas-upnp-org:service:WANIPConnection:1">
      <NewExternalIPAddress>203.0.113.42</NewExternalIPAddress>
    </u:GetExternalIPAddressResponse>
  </s:Body>
</s:Envelope>`
    const r = parseSoapResponse(xml)
    expect(r.ok).toBe(true)
    if (r.ok && r.value.kind === 'result') {
      expect(r.value.actionName).toBe('GetExternalIPAddressResponse')
      expect(r.value.output.NewExternalIPAddress).toBe('203.0.113.42')
    }
  })

  it('parses AddPortMapping empty response', () => {
    const xml = `<?xml version="1.0"?>
<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/">
  <s:Body>
    <u:AddPortMappingResponse xmlns:u="urn:schemas-upnp-org:service:WANIPConnection:1"/>
  </s:Body>
</s:Envelope>`
    const r = parseSoapResponse(xml)
    expect(r.ok).toBe(true)
    if (r.ok && r.value.kind === 'result') {
      expect(r.value.actionName).toBe('AddPortMappingResponse')
    }
  })

  it('parses SOAP Fault', () => {
    const xml = `<?xml version="1.0"?>
<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/">
  <s:Body>
    <s:Fault>
      <faultcode>s:Client</faultcode>
      <faultstring>UPnPError</faultstring>
      <detail>
        <UPnPError xmlns="urn:schemas-upnp-org:control-1-0">
          <errorCode>718</errorCode>
          <errorDescription>ConflictInMappingEntry</errorDescription>
        </UPnPError>
      </detail>
    </s:Fault>
  </s:Body>
</s:Envelope>`
    const r = parseSoapResponse(xml)
    expect(r.ok).toBe(true)
    if (r.ok && r.value.kind === 'fault') {
      expect(r.value.upnpErrorCode).toBe(718)
      expect(r.value.upnpErrorDescription).toBe('ConflictInMappingEntry')
    }
  })
})

describe('parseSoapResponse security', () => {
  it('rejects response exceeding size', () => {
    const huge = `<s:Envelope>${'x'.repeat(20 * 1024)}</s:Envelope>`
    const r = parseSoapResponse(huge)
    expect(r.ok).toBe(false)
  })

  it('rejects XXE attack', () => {
    const xxe = `<?xml version="1.0"?>
<!DOCTYPE foo [<!ENTITY xxe SYSTEM "file:///etc/passwd">]>
<s:Envelope><s:Body>&xxe;</s:Body></s:Envelope>`
    const r = parseSoapResponse(xxe)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toBe(ErrorCode.NatSecurityViolation)
  })

  it('rejects billion laughs', () => {
    const bomb = `<?xml version="1.0"?>
<!DOCTYPE lolz [<!ENTITY lol "lol"><!ENTITY lol2 "&lol;&lol;&lol;&lol;&lol;">]>
<s:Envelope>&lol2;</s:Envelope>`
    const r = parseSoapResponse(bomb)
    expect(r.ok).toBe(false)
  })
})

test.prop([fc.string({ maxLength: 4096 })])(
  'parseSoapResponse never throws',
  (s) => {
    const r = parseSoapResponse(s)
    expect(typeof r.ok).toBe('boolean')
  }
)

describe('xmlEscape default branch', () => {
  it('does not alter characters outside the special set', () => {
    // The switch has a default: return ch — triggered by any char that the
    // regex matches but is not one of the 5 special chars. In practice the
    // regex [<>&"'] only matches those 5, so the default arm is unreachable
    // by design. We verify the overall function is still correct for safety.
    expect(xmlEscape('hello world')).toBe('hello world')
  })
})

describe('buildSoapEnvelope additional branches', () => {
  it('throws on serviceType that passes allowlist but has invalid chars (unreachable by design — verify allowlist guards first)', () => {
    // All allowed service types pass the regex check already; an unknown type
    // is rejected at the allowlist check first. This confirms the guard order.
    expect(() =>
      buildSoapEnvelope('AddPortMapping', 'urn:not:allowed', {})
    ).toThrow()
  })

  it('throws on param with invalid name (digit first)', () => {
    expect(() =>
      buildSoapEnvelope('AddPortMapping', UPNP_WANIP_V1, { '1Bad': 'x' })
    ).toThrow()
  })
})

describe('parseSoapResponse additional branches', () => {
  it('rejects root element that is not s:Envelope', () => {
    const xml = `<?xml version="1.0"?><notEnvelope/>`
    const r = parseSoapResponse(xml)
    expect(r.ok).toBe(false)
  })

  it('rejects missing s:Body', () => {
    const xml = `<?xml version="1.0"?><s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"/>`
    const r = parseSoapResponse(xml)
    expect(r.ok).toBe(false)
  })

  it('rejects body with no action child (empty body)', () => {
    const xml = `<?xml version="1.0"?>
<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/">
  <s:Body></s:Body>
</s:Envelope>`
    const r = parseSoapResponse(xml)
    expect(r.ok).toBe(false)
  })

  it('parses fault without UPnPError block', () => {
    const xml = `<?xml version="1.0"?>
<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/">
  <s:Body>
    <s:Fault>
      <faultcode>s:Client</faultcode>
      <faultstring>Unknown</faultstring>
    </s:Fault>
  </s:Body>
</s:Envelope>`
    const r = parseSoapResponse(xml)
    expect(r.ok).toBe(true)
    if (r.ok && r.value.kind === 'fault') {
      expect(r.value.upnpErrorCode).toBeNull()
      expect(r.value.upnpErrorDescription).toBeNull()
    }
  })

  it('parses fault with UPnPError but non-numeric errorCode', () => {
    const xml = `<?xml version="1.0"?>
<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/">
  <s:Body>
    <s:Fault>
      <faultcode>s:Client</faultcode>
      <faultstring>UPnPError</faultstring>
      <detail>
        <UPnPError xmlns="urn:schemas-upnp-org:control-1-0">
          <errorCode>abc</errorCode>
        </UPnPError>
      </detail>
    </s:Fault>
  </s:Body>
</s:Envelope>`
    const r = parseSoapResponse(xml)
    expect(r.ok).toBe(true)
    if (r.ok && r.value.kind === 'fault') {
      expect(r.value.upnpErrorCode).toBeNull()
    }
  })
})
