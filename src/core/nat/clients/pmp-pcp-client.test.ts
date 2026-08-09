import { tick } from '@core/nat/__test__/utils'
import { createMockUdpFactory } from '@core/nat/net/mock-udp-socket'
import { ErrorCode } from '@shared/errors'
import { beforeEach, describe, expect, it } from 'vitest'
import { PmpPcpClient } from './pmp-pcp-client'

describe('PmpPcpClient', () => {
  let client: PmpPcpClient
  let udpFactory: ReturnType<typeof createMockUdpFactory>
  const gatewayIp = '192.168.1.1'
  const clientIp = Buffer.concat([
    Buffer.alloc(10),
    Buffer.from([0xff, 0xff]),
    Buffer.from([192, 168, 1, 100]),
  ])

  beforeEach(() => {
    udpFactory = createMockUdpFactory()
    client = new PmpPcpClient({
      udpFactory: udpFactory.factory,
      gatewayIp,
      clientIp,
    })
  })

  it('binds a single UDP socket on first use', async () => {
    void client.natPmpGetExternalIp({ timeoutMs: 50 })
    await tick()
    expect(udpFactory.sockets).toHaveLength(1)
  })

  it('rejects response with mismatched source IP', async () => {
    const p = client.natPmpGetExternalIp({ timeoutMs: 500 })
    await tick()
    const bogus = Buffer.alloc(12)
    bogus[0] = 0
    bogus[1] = 0x80 // version 0, opcode 0 | response bit
    // Craft as if from a DIFFERENT address
    udpFactory.sockets[0]?.emitMessage(bogus, {
      address: '10.0.0.99',
      port: 5351,
      size: 12,
    })
    // Now emit the correct response
    bogus.writeUInt16BE(0, 2)
    bogus.writeUInt32BE(0, 4)
    bogus[8] = 203
    bogus[9] = 0
    bogus[10] = 113
    bogus[11] = 42
    udpFactory.sockets[0]?.emitMessage(bogus, {
      address: gatewayIp,
      port: 5351,
      size: 12,
    })

    const r = await p
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.value.externalIp).toBe('203.0.113.42')
  })

  it('times out when no response', async () => {
    const r = await client.natPmpGetExternalIp({ timeoutMs: 50 })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toBe(ErrorCode.NatTimeout)
  })

  it('close() closes the socket', async () => {
    void client.natPmpGetExternalIp({ timeoutMs: 50 })
    await tick()
    await client.close()
    expect(udpFactory.sockets[0]?.closed).toBe(true)
  })

  it('pcpMap succeeds with matching nonce', async () => {
    const p = client.pcpMap({
      internalPort: 6881,
      externalPort: 6881,
      protocol: 'TCP',
      ttl: 7200,
      timeoutMs: 500,
    })
    await tick()
    const sent = udpFactory.sockets[0]?.sendCalls[0]?.data
    expect(sent).toBeDefined()
    // PCP nonce is in request bytes 24..36
    const nonce = sent!.subarray(24, 36)

    const resp = Buffer.alloc(60)
    resp[0] = 2 // version
    resp[1] = 0x80 | 1 // opcode MAP | response
    resp[3] = 0 // result
    resp.writeUInt32BE(7200, 4)
    resp.writeUInt32BE(60, 8)
    nonce.copy(resp, 24)
    resp[36] = 6 // TCP
    resp.writeUInt16BE(6881, 40)
    resp.writeUInt16BE(6881, 42)
    udpFactory.sockets[0]?.emitMessage(resp, {
      address: gatewayIp,
      port: 5351,
      size: 60,
    })

    const r = await p
    expect(r.ok).toBe(true)
  })

  it('rejects concurrent NAT-PMP requests with NatProtocolRejected', async () => {
    // First request — never gets a response
    const p1 = client.natPmpGetExternalIp({ timeoutMs: 500 })
    await tick()
    // Second concurrent — must be rejected immediately
    const p2 = await client.natPmpGetExternalIp({ timeoutMs: 500 })
    expect(p2.ok).toBe(false)
    if (!p2.ok) expect(p2.error).toBe(ErrorCode.NatProtocolRejected)
    // Let p1 time out so we don't leak handles
    await p1
  })

  it('rejects PCP requests over MAX_CONCURRENT_REQUESTS', async () => {
    // Saturate with 4 concurrent (use long timeout — they won't settle)
    const promises = [0, 1, 2, 3].map(() =>
      client.pcpMap({
        internalPort: 6881,
        externalPort: 6881,
        protocol: 'TCP',
        ttl: 7200,
        timeoutMs: 500,
      })
    )
    await tick()
    // Fifth must be rejected
    const r = await client.pcpMap({
      internalPort: 6881,
      externalPort: 6881,
      protocol: 'TCP',
      ttl: 7200,
      timeoutMs: 500,
    })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toBe(ErrorCode.NatProtocolRejected)
    // Let the 4 in-flight time out
    await Promise.all(promises)
  })

  it('close() is a no-op when no socket was created', async () => {
    // Don't call any request method — just close immediately
    await expect(client.close()).resolves.toBeUndefined()
    expect(udpFactory.sockets).toHaveLength(0)
  })

  describe('setGatewayIp', () => {
    it('redirects subsequent NAT-PMP traffic at the new gateway', async () => {
      client.setGatewayIp('10.0.0.1')
      void client.natPmpGetExternalIp({ timeoutMs: 50 })
      await tick()
      const sock = udpFactory.sockets[0]
      expect(sock).toBeDefined()
      expect(sock?.sendCalls).toHaveLength(1)
      expect(sock?.sendCalls[0]?.address).toBe('10.0.0.1')
    })

    it('rejects invalid IPv4 syntax', () => {
      expect(() => client.setGatewayIp('not-an-ip')).toThrow(RangeError)
      expect(() => client.setGatewayIp('')).toThrow(RangeError)
      expect(() => client.setGatewayIp('192.168.1')).toThrow(RangeError)
    })

    it('rejects out-of-range octets', () => {
      expect(() => client.setGatewayIp('300.1.1.1')).toThrow(RangeError)
      expect(() => client.setGatewayIp('10.0.0.256')).toThrow(RangeError)
    })
  })
})
