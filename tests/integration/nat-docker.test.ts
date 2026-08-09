import { nodeHttpClient } from '@core/nat/net/http-client'
import { nodeUdpSocketFactory } from '@core/nat/net/udp-socket'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  composeDown,
  composeUp,
  dockerMatrixAvailable,
} from './helpers/docker-harness'

// Opt-in: set NAT_DOCKER_MATRIX=1 to run the matrix locally. CI enables
// this via the nat-integration workflow. Default skip keeps `pnpm test`
// fast on developer machines (no docker-compose spin-up per run).
const SKIP =
  process.env.NAT_DOCKER_MATRIX !== '1' || !(await dockerMatrixAvailable())

describe.skipIf(SKIP)('NAT docker matrix', () => {
  beforeAll(async () => {
    await composeUp()
  }, 60_000)

  afterAll(async () => {
    await composeDown()
  }, 30_000)

  describe('UPnP IGD v1', () => {
    it('discovers miniupnpd', async () => {
      const { UpnpClient } = await import('@core/nat/clients')
      const client = new UpnpClient({
        udpFactory: nodeUdpSocketFactory,
        http: nodeHttpClient,
      })
      const r = await client.discover({ timeoutMs: 5000 })
      expect(r.ok).toBe(true)
      if (r.ok) {
        expect(r.value.manufacturer).toMatch(/miniupnpd/i)
      }
    })
  })

  describe('PCP fake server', () => {
    it('accepts MAP and echoes nonce', async () => {
      const { PmpPcpClient } = await import('@core/nat/clients')
      const clientIp = Buffer.concat([
        Buffer.alloc(10),
        Buffer.from([0xff, 0xff]),
        Buffer.from([127, 0, 0, 1]),
      ])
      const client = new PmpPcpClient({
        udpFactory: nodeUdpSocketFactory,
        gatewayIp: '127.0.0.1',
        clientIp,
      })
      const r = await client.pcpMap({
        protocol: 'TCP',
        internalPort: 6881,
        externalPort: 6881,
        ttl: 7200,
        timeoutMs: 3000,
      } as unknown)
      expect(r.ok).toBe(true)
      await client.close()
    })
  })

  describe('Hostile router', () => {
    it('rejects XXE response', async () => {
      const res = await nodeHttpClient.request({
        method: 'GET',
        host: '127.0.0.1',
        port: 49154,
        path: '/xxe',
        timeoutMs: 3000,
      })
      expect(res.ok).toBe(true)
      if (res.ok) {
        // HTTP client does not parse — it just delivers bytes. The codec
        // layer is what rejects. Feed the body to parseXml and verify rejection.
        const { parseXml } = await import('@core/nat/codecs')
        const parsed = parseXml(res.value.body)
        expect(parsed.ok).toBe(false)
      }
    })

    it('rejects 302 redirect', async () => {
      const res = await nodeHttpClient.request({
        method: 'GET',
        host: '127.0.0.1',
        port: 49154,
        path: '/redirect',
        timeoutMs: 3000,
      })
      expect(res.ok).toBe(false)
    })
  })

  describe('Broken router', () => {
    it('parser handles malformed HTTP without crashing', async () => {
      const res = await nodeHttpClient.request({
        method: 'GET',
        host: '127.0.0.1',
        port: 49155,
        path: '/',
        timeoutMs: 3000,
      })
      // Could fail at HTTP level — verify graceful failure, not crash
      expect(typeof res.ok).toBe('boolean')
    })
  })
})
