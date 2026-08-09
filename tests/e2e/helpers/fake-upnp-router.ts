import dgram from 'node:dgram'
import http from 'node:http'

const SSDP_MULTICAST = '239.255.255.250'
const SSDP_PORT = 1900

const DEVICE_DESC = `<?xml version="1.0"?>
<root xmlns="urn:schemas-upnp-org:device-1-0">
  <device>
    <deviceType>urn:schemas-upnp-org:device:InternetGatewayDevice:1</deviceType>
    <manufacturer>FakeCorp</manufacturer>
    <modelName>Fake-E2E-001</modelName>
    <serviceList>
      <service>
        <serviceType>urn:schemas-upnp-org:service:WANIPConnection:1</serviceType>
        <controlURL>/ctl</controlURL>
        <SCPDURL>/scpd.xml</SCPDURL>
      </service>
    </serviceList>
  </device>
</root>`

const MAP_RESPONSE = `<?xml version="1.0"?>
<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/">
  <s:Body>
    <u:AddPortMappingResponse xmlns:u="urn:schemas-upnp-org:service:WANIPConnection:1"/>
  </s:Body>
</s:Envelope>`

export interface FakeUpnpRouter {
  port: number
  soapCalls: string[]
  close(): Promise<void>
}

export async function startFakeUpnpRouter(): Promise<FakeUpnpRouter> {
  const calls: string[] = []

  const server = http.createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/desc') {
      res.writeHead(200, { 'Content-Type': 'text/xml' })
      res.end(DEVICE_DESC)
      return
    }
    if (req.method === 'POST' && req.url === '/ctl') {
      let body = ''
      req.on('data', (c) => (body += c))
      req.on('end', () => {
        calls.push(body)
        res.writeHead(200, { 'Content-Type': 'text/xml' })
        res.end(MAP_RESPONSE)
      })
      return
    }
    res.writeHead(404)
    res.end()
  })

  await new Promise<void>((resolve) =>
    server.listen(0, '127.0.0.1', () => resolve())
  )
  const addr = server.address()
  const port =
    typeof addr === 'object' && addr !== null && 'port' in addr
      ? (addr.port as number)
      : 0

  // SSDP listener — respond to M-SEARCH
  const ssdp = dgram.createSocket({ type: 'udp4', reuseAddr: true })
  await new Promise<void>((resolve, reject) => {
    ssdp.bind(SSDP_PORT, () => {
      try {
        ssdp.addMembership(SSDP_MULTICAST)
        resolve()
      } catch (err) {
        reject(err)
      }
    })
    ssdp.once('error', reject)
  })
  ssdp.on('message', (msg, rinfo) => {
    if (!msg.toString().startsWith('M-SEARCH')) return
    const response = Buffer.from(
      `HTTP/1.1 200 OK\r\nLOCATION: http://127.0.0.1:${port}/desc\r\nST: urn:schemas-upnp-org:device:InternetGatewayDevice:1\r\nSERVER: Fake/1.0\r\nUSN: uuid:fake::x\r\n\r\n`,
      'ascii'
    )
    ssdp.send(response, rinfo.port, rinfo.address)
  })

  return {
    port,
    soapCalls: calls,
    async close() {
      await new Promise<void>((resolve) => server.close(() => resolve()))
      await new Promise<void>((resolve) => ssdp.close(() => resolve()))
    },
  }
}
