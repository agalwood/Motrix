import { tick } from '@core/nat/__test__/utils'
import {
  STUN_ATTR_XOR_MAPPED_ADDRESS,
  STUN_MAGIC_COOKIE,
} from '@core/nat/codecs'
import { createMockUdpFactory } from '@core/nat/net/mock-udp-socket'
import { beforeEach, describe, expect, it } from 'vitest'
import { StunClient } from './stun-client'

function buildXorMappedResponse(
  txId: Buffer,
  publicIp: [number, number, number, number],
  port: number
): Buffer {
  const attr = Buffer.alloc(12)
  attr.writeUInt16BE(STUN_ATTR_XOR_MAPPED_ADDRESS, 0)
  attr.writeUInt16BE(8, 2)
  attr[4] = 0
  attr[5] = 1
  const xorPort = port ^ (STUN_MAGIC_COOKIE >>> 16)
  attr.writeUInt16BE(xorPort & 0xffff, 6)
  const cookie = Buffer.alloc(4)
  cookie.writeUInt32BE(STUN_MAGIC_COOKIE, 0)
  attr[8] = publicIp[0] ^ cookie[0]!
  attr[9] = publicIp[1] ^ cookie[1]!
  attr[10] = publicIp[2] ^ cookie[2]!
  attr[11] = publicIp[3] ^ cookie[3]!
  const header = Buffer.alloc(20)
  header.writeUInt16BE(0x0101, 0)
  header.writeUInt16BE(attr.length, 2)
  header.writeUInt32BE(STUN_MAGIC_COOKIE, 4)
  txId.copy(header, 8)
  return Buffer.concat([header, attr])
}

describe('StunClient.detectNatType', () => {
  let udpFactory: ReturnType<typeof createMockUdpFactory>
  let client: StunClient

  beforeEach(() => {
    udpFactory = createMockUdpFactory()
    client = new StunClient({ udpFactory: udpFactory.factory })
  })

  it('requires at least one STUN server', async () => {
    const r = await client.detectNatType({ servers: [], timeoutMs: 100 })
    expect(r.ok).toBe(false)
  })

  it('caps STUN server count at 10', async () => {
    const many = Array(20).fill('stun.example.com:3478')
    const r = await client.detectNatType({ servers: many, timeoutMs: 100 })
    expect(r.ok).toBe(false)
  })

  it('returns the mapped address from first responding server', async () => {
    const queryP = client.detectNatType({
      servers: ['1.2.3.4:3478'],
      timeoutMs: 500,
    })
    await tick()
    const sent = udpFactory.sockets[0]!.sendCalls[0]!
    const txId = sent.data.subarray(8, 20)
    const resp = buildXorMappedResponse(txId, [203, 0, 113, 42], 51413)
    udpFactory.sockets[0]!.emitMessage(resp, {
      address: '1.2.3.4',
      port: 3478,
      size: resp.length,
    })

    const r = await queryP
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.value.mappedIp).toBe('203.0.113.42')
  })

  it('times out when no server responds', async () => {
    const r = await client.detectNatType({
      servers: ['1.2.3.4:3478'],
      timeoutMs: 30,
    })
    expect(r.ok).toBe(false)
  })

  it('falls back to next server when first fails', async () => {
    const queryP = client.detectNatType({
      servers: ['1.1.1.1:3478', '2.2.2.2:3478'],
      timeoutMs: 100,
    })
    // First server is sequential — wait for the first send
    await tick()
    // Don't respond to first server (it will time out)
    // After ~100ms it times out and the loop tries the second
    await new Promise((r) => setTimeout(r, 150))
    // Now the second server has been queried
    expect(udpFactory.sockets.length).toBeGreaterThanOrEqual(2)
    const sent2 = udpFactory.sockets[1]!.sendCalls[0]!
    expect(sent2.address).toBe('2.2.2.2')
    const txId2 = sent2.data.subarray(8, 20)
    const resp = buildXorMappedResponse(txId2, [198, 51, 100, 7], 12345)
    udpFactory.sockets[1]!.emitMessage(resp, {
      address: '2.2.2.2',
      port: 3478,
      size: resp.length,
    })

    const r = await queryP
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.value.mappedIp).toBe('198.51.100.7')
  })

  it('skips invalid server formats and tries valid ones', async () => {
    const queryP = client.detectNatType({
      servers: ['not-a-valid-server', '1.2.3.4:3478'],
      timeoutMs: 500,
    })
    await tick()
    // The invalid one is skipped immediately, only one socket created
    expect(udpFactory.sockets).toHaveLength(1)
    const sent = udpFactory.sockets[0]!.sendCalls[0]!
    expect(sent.address).toBe('1.2.3.4')
    const txId = sent.data.subarray(8, 20)
    const resp = buildXorMappedResponse(txId, [203, 0, 113, 99], 1234)
    udpFactory.sockets[0]!.emitMessage(resp, {
      address: '1.2.3.4',
      port: 3478,
      size: resp.length,
    })
    const r = await queryP
    expect(r.ok).toBe(true)
  })
})
