import { describe, expect, it } from 'vitest'
import { createMockUdpFactory } from './mock-udp-socket'

describe('MockUdpSocket', () => {
  it('records send calls', async () => {
    const { factory, sockets } = createMockUdpFactory()
    const s = factory({ type: 'udp4' })
    await s.bind()
    await s.send(Buffer.from('hello'), 1234, '1.2.3.4')
    expect(sockets[0]!.sendCalls).toHaveLength(1)
    expect(sockets[0]!.sendCalls[0]!.data.toString()).toBe('hello')
  })

  it('delivers emitted messages to listeners', async () => {
    const { factory, sockets } = createMockUdpFactory()
    const s = factory({ type: 'udp4' })
    await s.bind()
    const received: Buffer[] = []
    s.onMessage((msg) => received.push(msg))
    sockets[0]!.emitMessage(Buffer.from('ack'), {
      address: '1.2.3.4',
      port: 5351,
      size: 3,
    })
    expect(received[0]!.toString()).toBe('ack')
  })

  it('rejects mutations after close', async () => {
    const { factory } = createMockUdpFactory()
    const s = factory({ type: 'udp4' })
    await s.bind()
    await s.close()
    await expect(s.send(Buffer.from('x'), 1, '1.1.1.1')).rejects.toThrow(
      'socket closed'
    )
    await expect(s.bind()).rejects.toThrow('socket closed')
    expect(() => s.addMembership('239.255.255.250')).toThrow('socket closed')
    expect(() => s.setMulticastTTL(4)).toThrow('socket closed')
  })
})
