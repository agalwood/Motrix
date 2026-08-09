import { tick } from '@core/nat/__test__/utils'
import {
  SSDP_IGD_V1_ST,
  SSDP_IGD_V2_ST,
  SSDP_MULTICAST_ADDR,
  SSDP_MULTICAST_PORT,
} from '@core/nat/codecs/ssdp-codec'
import { createMockHttpClient } from '@core/nat/net/mock-http-client'
import { createMockUdpFactory } from '@core/nat/net/mock-udp-socket'
import { ErrorCode } from '@shared/errors'
import { beforeEach, describe, expect, it } from 'vitest'
import { UpnpClient } from './upnp-client'

function buildSsdpResponse(location: string): Buffer {
  return Buffer.from(
    `HTTP/1.1 200 OK\r\nLOCATION: ${location}\r\nST: ${SSDP_IGD_V1_ST}\r\nSERVER: test\r\nUSN: uuid:1::${SSDP_IGD_V1_ST}\r\n\r\n`,
    'ascii'
  )
}

function buildSsdpResponseV2(location: string): Buffer {
  return Buffer.from(
    `HTTP/1.1 200 OK\r\nLOCATION: ${location}\r\nST: ${SSDP_IGD_V2_ST}\r\nSERVER: test\r\nUSN: uuid:1::${SSDP_IGD_V2_ST}\r\n\r\n`,
    'ascii'
  )
}

const VALID_DEVICE_XML_V2 = `<?xml version="1.0"?>
<root xmlns="urn:schemas-upnp-org:device-1-0">
  <device>
    <deviceType>urn:schemas-upnp-org:device:InternetGatewayDevice:2</deviceType>
    <manufacturer>TestCorp</manufacturer>
    <modelName>TestV2</modelName>
    <serviceList>
      <service>
        <serviceType>urn:schemas-upnp-org:service:WANIPConnection:2</serviceType>
        <controlURL>/ctl/IPConn2</controlURL>
        <SCPDURL>/IPConn2.xml</SCPDURL>
      </service>
    </serviceList>
  </device>
</root>`

const VALID_DEVICE_XML = `<?xml version="1.0"?>
<root xmlns="urn:schemas-upnp-org:device-1-0">
  <device>
    <deviceType>urn:schemas-upnp-org:device:InternetGatewayDevice:1</deviceType>
    <manufacturer>TestCorp</manufacturer>
    <modelName>Test</modelName>
    <serviceList>
      <service>
        <serviceType>urn:schemas-upnp-org:service:WANIPConnection:1</serviceType>
        <controlURL>/ctl/IPConn</controlURL>
        <SCPDURL>/IPConn.xml</SCPDURL>
      </service>
    </serviceList>
  </device>
</root>`

describe('UpnpClient.discover', () => {
  let client: UpnpClient
  let udpFactory: ReturnType<typeof createMockUdpFactory>
  let http: ReturnType<typeof createMockHttpClient>

  beforeEach(() => {
    udpFactory = createMockUdpFactory()
    http = createMockHttpClient()
    client = new UpnpClient({
      udpFactory: udpFactory.factory,
      http: http.client,
      now: () => 0,
    })
  })

  it('sends M-SEARCH to SSDP multicast address', async () => {
    const discoverP = client.discover({ timeoutMs: 100 })
    // Wait a tick for send
    await tick()
    const sock = udpFactory.sockets[0]!
    // Two M-SEARCH packets: one per IGD search target (v1 + v2).
    expect(sock.sendCalls).toHaveLength(2)
    expect(sock.sendCalls[0]?.address).toBe(SSDP_MULTICAST_ADDR)
    expect(sock.sendCalls[0]?.port).toBe(SSDP_MULTICAST_PORT)
    expect(sock.sendCalls[0]?.data.toString('ascii')).toContain('M-SEARCH')
    // Let discovery time out
    await discoverP
  })

  it('searches for both IGD v1 and v2 targets', async () => {
    const discoverP = client.discover({ timeoutMs: 100 })
    await tick()
    const sock = udpFactory.sockets[0]!
    const sent = sock.sendCalls.map((c) => c.data.toString('ascii'))
    expect(sent.some((m) => m.includes(`ST: ${SSDP_IGD_V1_ST}`))).toBe(true)
    expect(sent.some((m) => m.includes(`ST: ${SSDP_IGD_V2_ST}`))).toBe(true)
    // Every probe targets the SSDP multicast endpoint.
    for (const call of sock.sendCalls) {
      expect(call.address).toBe(SSDP_MULTICAST_ADDR)
      expect(call.port).toBe(SSDP_MULTICAST_PORT)
    }
    await discoverP
  })

  it('discovers an IGD v2 gateway (WANIPConnection:2)', async () => {
    http.history
      .expect({
        method: 'GET',
        host: '192.168.1.1',
        port: 49153,
        path: '/desc',
      })
      .reply({ statusCode: 200, body: VALID_DEVICE_XML_V2 })

    const discoverP = client.discover({ timeoutMs: 2000 })
    await tick()
    udpFactory.sockets[0]?.emitMessage(
      buildSsdpResponseV2('http://192.168.1.1:49153/desc'),
      { address: '192.168.1.1', port: 1900, size: 0 }
    )

    const r = await discoverP
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.value.serviceType).toBe(
        'urn:schemas-upnp-org:service:WANIPConnection:2'
      )
      expect(r.value.controlUrl).toBe('/ctl/IPConn2')
    }
  })

  it('returns discovered gateway on valid response', async () => {
    http.history
      .expect({
        method: 'GET',
        host: '192.168.1.1',
        port: 49152,
        path: '/desc',
      })
      .reply({ statusCode: 200, body: VALID_DEVICE_XML })

    const discoverP = client.discover({ timeoutMs: 2000 })
    await tick()
    udpFactory.sockets[0]?.emitMessage(
      buildSsdpResponse('http://192.168.1.1:49152/desc'),
      { address: '192.168.1.1', port: 1900, size: 0 }
    )

    const r = await discoverP
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.value.gatewayIp).toBe('192.168.1.1')
      expect(r.value.controlUrl).toBe('/ctl/IPConn')
      expect(r.value.manufacturer).toBe('TestCorp')
    }
  })

  it('stops accepting responses after first valid gateway', async () => {
    http.history
      .expect({
        method: 'GET',
        host: '192.168.1.1',
        port: 49152,
        path: '/desc',
      })
      .reply({ statusCode: 200, body: VALID_DEVICE_XML })

    const discoverP = client.discover({ timeoutMs: 2000 })
    await tick()

    udpFactory.sockets[0]?.emitMessage(
      buildSsdpResponse('http://192.168.1.1:49152/desc'),
      { address: '192.168.1.1', port: 1900, size: 0 }
    )
    // Send more responses — should be ignored
    for (let i = 0; i < 5; i++) {
      udpFactory.sockets[0]?.emitMessage(
        buildSsdpResponse(`http://10.0.0.${i + 1}/other`),
        { address: `10.0.0.${i + 1}`, port: 1900, size: 0 }
      )
    }
    const r = await discoverP
    expect(r.ok).toBe(true)
    expect(http.history.calls).toHaveLength(1) // Only the first got HTTP-fetched
  })

  it('limits accepted responses per round to avoid flood', async () => {
    const discoverP = client.discover({ timeoutMs: 100, maxResponses: 3 })
    await tick()
    // Send 10 responses with public IPs (all rejected by codec — not a valid gateway)
    for (let i = 0; i < 10; i++) {
      udpFactory.sockets[0]?.emitMessage(
        buildSsdpResponse(`http://8.8.8.${i}/x`),
        { address: '8.8.8.8', port: 1900, size: 0 }
      )
    }
    const r = await discoverP
    expect(r.ok).toBe(false) // none valid
    // Socket should be closed
    expect(udpFactory.sockets[0]?.closed).toBe(true)
  })

  it('counts responses arriving during HTTP fetch against flood limit', async () => {
    http.history
      .expect({ method: 'GET', host: '192.168.1.1', port: 49152, path: '/a' })
      .delay(50)
      .reply({ statusCode: 200, body: VALID_DEVICE_XML })

    const discoverP = client.discover({ timeoutMs: 500, maxResponses: 2 })
    await tick()

    // First response starts an HTTP fetch; processingResponse = true during the 50ms delay
    udpFactory.sockets[0]?.emitMessage(
      buildSsdpResponse('http://192.168.1.1:49152/a'),
      { address: '192.168.1.1', port: 1900, size: 0 }
    )
    // Two more arrive during the fetch — must count against the limit
    udpFactory.sockets[0]?.emitMessage(
      buildSsdpResponse('http://192.168.1.2:49152/b'),
      { address: '192.168.1.2', port: 1900, size: 0 }
    )
    udpFactory.sockets[0]?.emitMessage(
      buildSsdpResponse('http://192.168.1.3:49152/c'),
      { address: '192.168.1.3', port: 1900, size: 0 }
    )

    const r = await discoverP
    expect(r.ok).toBe(true)
    expect(http.history.calls).toHaveLength(1)
  })

  it('rejects SSDP Location pointing to public IP (no HTTP issued)', async () => {
    const discoverP = client.discover({ timeoutMs: 500 })
    await tick()
    udpFactory.sockets[0]?.emitMessage(
      buildSsdpResponse('http://8.8.8.8/desc'),
      { address: '192.168.1.1', port: 1900, size: 0 }
    )
    const r = await discoverP
    expect(r.ok).toBe(false)
    expect(http.history.calls).toHaveLength(0)
  })

  it('times out when no valid response received', async () => {
    const r = await client.discover({ timeoutMs: 50 })
    expect(r.ok).toBe(false)
  })

  it('closes UDP socket after discovery', async () => {
    await client.discover({ timeoutMs: 50 })
    const sock = udpFactory.sockets[0]!
    expect(sock.closed).toBe(true)
  })
})

describe('UpnpClient control operations', () => {
  let client: UpnpClient
  let udpFactory: ReturnType<typeof createMockUdpFactory>
  let http: ReturnType<typeof createMockHttpClient>
  const gateway = {
    gatewayIp: '192.168.1.1',
    controlUrl: '/ctl/IPConn',
    controlHost: '192.168.1.1',
    controlPort: 49152,
    serviceType: 'urn:schemas-upnp-org:service:WANIPConnection:1',
    manufacturer: 'T',
    modelName: 'M',
  }

  beforeEach(() => {
    udpFactory = createMockUdpFactory()
    http = createMockHttpClient()
    client = new UpnpClient({
      udpFactory: udpFactory.factory,
      http: http.client,
      now: () => 0,
    })
  })

  it('mapPort issues AddPortMapping SOAP', async () => {
    const successBody = `<?xml version="1.0"?>
<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body>
<u:AddPortMappingResponse xmlns:u="urn:schemas-upnp-org:service:WANIPConnection:1"/>
</s:Body></s:Envelope>`
    http.history
      .expect({
        method: 'POST',
        host: '192.168.1.1',
        port: 49152,
        path: '/ctl/IPConn',
      })
      .reply({ statusCode: 200, body: successBody })

    const r = await client.mapPort(gateway, {
      internalIp: '192.168.1.100',
      internalPort: 6881,
      externalPort: 6881,
      protocol: 'TCP',
      ttl: 7200,
      description: 'Motrix',
    })
    expect(r.ok).toBe(true)
    expect(http.history.calls).toHaveLength(1)
    expect(http.history.calls[0]!.body).toContain(
      '<NewExternalPort>6881</NewExternalPort>'
    )
    expect(http.history.calls[0]!.body).toContain(
      '<NewInternalClient>192.168.1.100</NewInternalClient>'
    )
  })

  it('maps SOAP fault 718 to NatMappingConflict', async () => {
    const fault = `<?xml version="1.0"?>
<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body>
<s:Fault><faultcode>s:Client</faultcode><faultstring>UPnPError</faultstring>
<detail><UPnPError xmlns="urn:schemas-upnp-org:control-1-0">
<errorCode>718</errorCode><errorDescription>ConflictInMappingEntry</errorDescription>
</UPnPError></detail></s:Fault></s:Body></s:Envelope>`
    http.history
      .expect({
        method: 'POST',
        host: '192.168.1.1',
        port: 49152,
        path: '/ctl/IPConn',
      })
      .reply({ statusCode: 500, body: fault })

    const r = await client.mapPort(gateway, {
      internalIp: '192.168.1.100',
      internalPort: 6881,
      externalPort: 6881,
      protocol: 'TCP',
      ttl: 7200,
      description: 'Motrix',
    })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toBe(ErrorCode.NatMappingConflict)
  })

  it('unmapPort issues DeletePortMapping', async () => {
    const successBody = `<?xml version="1.0"?>
<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body>
<u:DeletePortMappingResponse xmlns:u="urn:schemas-upnp-org:service:WANIPConnection:1"/>
</s:Body></s:Envelope>`
    http.history
      .expect({
        method: 'POST',
        host: '192.168.1.1',
        port: 49152,
        path: '/ctl/IPConn',
      })
      .reply({ statusCode: 200, body: successBody })

    const r = await client.unmapPort(gateway, {
      externalPort: 6881,
      protocol: 'TCP',
    })
    expect(r.ok).toBe(true)
    expect(http.history.calls[0]!.body).toContain('<u:DeletePortMapping')
  })

  it('getExternalIp extracts NewExternalIPAddress', async () => {
    const body = `<?xml version="1.0"?>
<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body>
<u:GetExternalIPAddressResponse xmlns:u="urn:schemas-upnp-org:service:WANIPConnection:1">
<NewExternalIPAddress>203.0.113.42</NewExternalIPAddress>
</u:GetExternalIPAddressResponse></s:Body></s:Envelope>`
    http.history
      .expect({
        method: 'POST',
        host: '192.168.1.1',
        port: 49152,
        path: '/ctl/IPConn',
      })
      .reply({ statusCode: 200, body })

    const r = await client.getExternalIp(gateway)
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.value).toBe('203.0.113.42')
  })

  it('rejects mapPort with non-private internalIp', async () => {
    const r = await client.mapPort(gateway, {
      internalIp: '8.8.8.8',
      internalPort: 6881,
      externalPort: 6881,
      protocol: 'TCP',
      ttl: 7200,
      description: 'Motrix',
    })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toBe(ErrorCode.NatSecurityViolation)
    expect(http.history.calls).toHaveLength(0)
  })

  it('rejects mapPort with out-of-range port', async () => {
    const r = await client.mapPort(gateway, {
      internalIp: '192.168.1.100',
      internalPort: 6881,
      externalPort: 99999,
      protocol: 'TCP',
      ttl: 7200,
      description: 'Motrix',
    })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toBe(ErrorCode.NatProtocolRejected)
    expect(http.history.calls).toHaveLength(0)
  })

  it('rejects mapPort with negative ttl', async () => {
    const r = await client.mapPort(gateway, {
      internalIp: '192.168.1.100',
      internalPort: 6881,
      externalPort: 6881,
      protocol: 'TCP',
      ttl: -1,
      description: 'Motrix',
    })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toBe(ErrorCode.NatProtocolRejected)
    expect(http.history.calls).toHaveLength(0)
  })

  it('maps SOAP fault 725 to NatProtocolRejected', async () => {
    const fault = `<?xml version="1.0"?>
<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body>
<s:Fault><faultcode>s:Client</faultcode><faultstring>UPnPError</faultstring>
<detail><UPnPError xmlns="urn:schemas-upnp-org:control-1-0">
<errorCode>725</errorCode><errorDescription>OnlyPermanentLeasesSupported</errorDescription>
</UPnPError></detail></s:Fault></s:Body></s:Envelope>`
    http.history
      .expect({
        method: 'POST',
        host: '192.168.1.1',
        port: 49152,
        path: '/ctl/IPConn',
      })
      .reply({ statusCode: 500, body: fault })

    const r = await client.mapPort(gateway, {
      internalIp: '192.168.1.100',
      internalPort: 6881,
      externalPort: 6881,
      protocol: 'TCP',
      ttl: 7200,
      description: 'Motrix',
    })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toBe(ErrorCode.NatProtocolRejected)
  })

  it('maps SOAP fault 727 to NatProtocolRejected', async () => {
    const fault = `<?xml version="1.0"?>
<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body>
<s:Fault><faultcode>s:Client</faultcode><faultstring>UPnPError</faultstring>
<detail><UPnPError xmlns="urn:schemas-upnp-org:control-1-0">
<errorCode>727</errorCode><errorDescription>ExternalPortOnlySupportsWildcard</errorDescription>
</UPnPError></detail></s:Fault></s:Body></s:Envelope>`
    http.history
      .expect({
        method: 'POST',
        host: '192.168.1.1',
        port: 49152,
        path: '/ctl/IPConn',
      })
      .reply({ statusCode: 500, body: fault })

    const r = await client.mapPort(gateway, {
      internalIp: '192.168.1.100',
      internalPort: 6881,
      externalPort: 6881,
      protocol: 'TCP',
      ttl: 7200,
      description: 'Motrix',
    })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toBe(ErrorCode.NatProtocolRejected)
  })
})
