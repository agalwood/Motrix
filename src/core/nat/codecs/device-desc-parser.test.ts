import { fc, test } from '@fast-check/vitest'
import { ErrorCode } from '@shared/errors'
import { describe, expect, it } from 'vitest'
import { parseDeviceDescription } from './device-desc-parser'

const VALID_DESC = `<?xml version="1.0"?>
<root xmlns="urn:schemas-upnp-org:device-1-0">
  <specVersion><major>1</major><minor>0</minor></specVersion>
  <device>
    <deviceType>urn:schemas-upnp-org:device:InternetGatewayDevice:1</deviceType>
    <friendlyName>Test Router</friendlyName>
    <manufacturer>TP-LINK</manufacturer>
    <modelName>AX73</modelName>
    <deviceList>
      <device>
        <deviceType>urn:schemas-upnp-org:device:WANDevice:1</deviceType>
        <deviceList>
          <device>
            <deviceType>urn:schemas-upnp-org:device:WANConnectionDevice:1</deviceType>
            <serviceList>
              <service>
                <serviceType>urn:schemas-upnp-org:service:WANIPConnection:1</serviceType>
                <serviceId>urn:upnp-org:serviceId:WANIPConn1</serviceId>
                <controlURL>/ctl/IPConn</controlURL>
                <eventSubURL>/evt/IPConn</eventSubURL>
                <SCPDURL>/IPConn.xml</SCPDURL>
              </service>
            </serviceList>
          </device>
        </deviceList>
      </device>
    </deviceList>
  </device>
</root>`

describe('parseDeviceDescription happy path', () => {
  it('extracts manufacturer and model', () => {
    const r = parseDeviceDescription(VALID_DESC)
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.value.manufacturer).toBe('TP-LINK')
      expect(r.value.modelName).toBe('AX73')
      expect(r.value.friendlyName).toBe('Test Router')
    }
  })

  it('extracts WANIPConnection service', () => {
    const r = parseDeviceDescription(VALID_DESC)
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.value.services).toHaveLength(1)
      const s = r.value.services[0]
      expect(s?.serviceType).toBe(
        'urn:schemas-upnp-org:service:WANIPConnection:1'
      )
      expect(s?.controlUrl).toBe('/ctl/IPConn')
    }
  })

  it('ignores non-port-mapping services', () => {
    const xml = VALID_DESC.replace(
      'urn:schemas-upnp-org:service:WANIPConnection:1',
      'urn:schemas-upnp-org:service:LANHostConfigManagement:1'
    )
    const r = parseDeviceDescription(xml)
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.value.services).toEqual([])
  })
})

describe('parseDeviceDescription security', () => {
  it('rejects relative path with ..', () => {
    const xml = VALID_DESC.replace('/ctl/IPConn', '/ctl/../../../secret')
    const r = parseDeviceDescription(xml)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toBe(ErrorCode.NatSecurityViolation)
  })

  it('rejects absolute URL in controlURL', () => {
    const xml = VALID_DESC.replace('/ctl/IPConn', 'http://evil.com/ctl')
    const r = parseDeviceDescription(xml)
    expect(r.ok).toBe(false)
  })

  it('rejects controlURL with CRLF', () => {
    const xml = VALID_DESC.replace('/ctl/IPConn', '/ctl/\r\nInjected: x')
    const r = parseDeviceDescription(xml)
    expect(r.ok).toBe(false)
  })

  it('rejects controlURL with non-ASCII', () => {
    const xml = VALID_DESC.replace('/ctl/IPConn', '/ctl/ä')
    const r = parseDeviceDescription(xml)
    expect(r.ok).toBe(false)
  })

  it('rejects descriptions exceeding size', () => {
    const huge = `<?xml version="1.0"?><root>${'<x/>'.repeat(30000)}</root>`
    const r = parseDeviceDescription(huge)
    expect(r.ok).toBe(false)
  })
})

test.prop([fc.string({ maxLength: 4096 })])(
  'parseDeviceDescription never throws',
  (s) => {
    const r = parseDeviceDescription(s)
    expect(typeof r.ok).toBe('boolean')
  }
)

describe('parseDeviceDescription additional branches', () => {
  it('returns empty string for missing friendlyName/manufacturer/modelName', () => {
    const xml = `<?xml version="1.0"?>
<root xmlns="urn:schemas-upnp-org:device-1-0">
  <device>
    <serviceList>
      <service>
        <serviceType>urn:schemas-upnp-org:service:WANIPConnection:1</serviceType>
        <controlURL>/ctl/ip</controlURL>
      </service>
    </serviceList>
  </device>
</root>`
    const r = parseDeviceDescription(xml)
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.value.friendlyName).toBe('')
      expect(r.value.manufacturer).toBe('')
      expect(r.value.modelName).toBe('')
    }
  })

  it('rejects when root element is not <root>', () => {
    const xml = `<?xml version="1.0"?>
<notroot><device/></notroot>`
    const r = parseDeviceDescription(xml)
    expect(r.ok).toBe(false)
  })

  it('rejects when device element is missing', () => {
    const xml = `<?xml version="1.0"?>
<root xmlns="urn:schemas-upnp-org:device-1-0">
  <specVersion><major>1</major></specVersion>
</root>`
    const r = parseDeviceDescription(xml)
    expect(r.ok).toBe(false)
  })

  it('skips service with missing serviceType', () => {
    const xml = `<?xml version="1.0"?>
<root><device><serviceList><service><controlURL>/ctl</controlURL></service></serviceList></device></root>`
    const r = parseDeviceDescription(xml)
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.value.services).toHaveLength(0)
  })

  it('skips service with missing controlURL', () => {
    const xml = `<?xml version="1.0"?>
<root><device><serviceList><service>
  <serviceType>urn:schemas-upnp-org:service:WANIPConnection:1</serviceType>
</service></serviceList></device></root>`
    const r = parseDeviceDescription(xml)
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.value.services).toHaveLength(0)
  })

  it('skips service when controlURL is empty string (treated as missing)', () => {
    // Empty string is falsy so the service is skipped, not rejected
    const xml = VALID_DESC.replace('/ctl/IPConn', '')
    const r = parseDeviceDescription(xml)
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.value.services).toHaveLength(0)
  })

  it('rejects controlURL exceeding max length (validateControlUrl path)', () => {
    // Must start with / to pass the prefix check, then be too long
    const longPath = `/${'a'.repeat(201)}`
    const xml = VALID_DESC.replace('/ctl/IPConn', longPath)
    const r = parseDeviceDescription(xml)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toBe(ErrorCode.NatSecurityViolation)
  })

  it('rejects controlURL without leading slash', () => {
    const xml = VALID_DESC.replace('/ctl/IPConn', 'ctl/IPConn')
    const r = parseDeviceDescription(xml)
    expect(r.ok).toBe(false)
  })

  it('rejects controlURL that looks like https absolute URL', () => {
    const xml = VALID_DESC.replace('/ctl/IPConn', 'https://evil.com/ctl')
    const r = parseDeviceDescription(xml)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toBe(ErrorCode.NatSecurityViolation)
  })

  it('rejects controlURL with disallowed character (space)', () => {
    const xml = VALID_DESC.replace('/ctl/IPConn', '/ctl/bad path')
    const r = parseDeviceDescription(xml)
    expect(r.ok).toBe(false)
  })

  it('finds friendlyName via findDescendants fallback', () => {
    // Put friendlyName nested deeper (so findChild fails, findDescendants picks it up)
    const xml = `<?xml version="1.0"?>
<root xmlns="urn:schemas-upnp-org:device-1-0">
  <device>
    <nested><friendlyName>Deep Router</friendlyName></nested>
    <serviceList>
      <service>
        <serviceType>urn:schemas-upnp-org:service:WANIPConnection:1</serviceType>
        <controlURL>/ctl/ip</controlURL>
      </service>
    </serviceList>
  </device>
</root>`
    const r = parseDeviceDescription(xml)
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.value.friendlyName).toBe('Deep Router')
  })
})
