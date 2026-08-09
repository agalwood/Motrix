import { EventEmitter } from 'node:events'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { createSocketMock } = vi.hoisted(() => ({
  createSocketMock: vi.fn(),
}))

vi.mock('node:dgram', () => ({
  default: { createSocket: createSocketMock },
}))

import { NodeUdpSocket } from './udp-socket'

class FakeSocket extends EventEmitter {
  bind = vi.fn(
    (_port: number, _address: string | undefined, callback: () => void) =>
      callback()
  )
  addMembership = vi.fn()
  setMulticastTTL = vi.fn()
  send = vi.fn(
    (
      _msg: Buffer,
      _port: number,
      _address: string,
      callback: (error: Error | null) => void
    ) => callback(null)
  )
  close = vi.fn((callback: () => void) => callback())
  address = vi.fn(() => ({
    port: 12345,
    address: '127.0.0.1',
    family: 'IPv4',
  }))
}

function createSubject(options: { reuseAddr?: boolean } = {}) {
  const socket = new FakeSocket()
  createSocketMock.mockReturnValueOnce(socket)
  const subject = new NodeUdpSocket({ type: 'udp4', ...options })
  return { socket, subject }
}

describe('NodeUdpSocket', () => {
  beforeEach(() => {
    createSocketMock.mockReset()
  })

  it('creates a reusable udp4 socket by default and binds on an ephemeral port', async () => {
    const { socket, subject } = createSubject()

    await subject.bind()

    expect(createSocketMock).toHaveBeenCalledWith({
      type: 'udp4',
      reuseAddr: true,
    })
    expect(socket.bind).toHaveBeenCalledWith(0, undefined, expect.any(Function))
  })

  it('rejects bind when the native socket emits an error', async () => {
    const { socket, subject } = createSubject({ reuseAddr: false })
    socket.bind.mockImplementationOnce(() => {
      queueMicrotask(() => socket.emit('error', new Error('address in use')))
    })

    await expect(subject.bind(5351, '0.0.0.0')).rejects.toThrow(
      'address in use'
    )
    expect(createSocketMock).toHaveBeenCalledWith({
      type: 'udp4',
      reuseAddr: false,
    })
  })

  it('forwards multicast configuration and sends datagrams', async () => {
    const { socket, subject } = createSubject()
    const payload = Buffer.from('hello')

    subject.addMembership('239.255.255.250', '192.168.1.10')
    subject.setMulticastTTL(4)
    await subject.send(payload, 1900, '239.255.255.250')

    expect(socket.addMembership).toHaveBeenCalledWith(
      '239.255.255.250',
      '192.168.1.10'
    )
    expect(socket.setMulticastTTL).toHaveBeenCalledWith(4)
    expect(socket.send).toHaveBeenCalledWith(
      payload,
      1900,
      '239.255.255.250',
      expect.any(Function)
    )
  })

  it('rejects a failed native send', async () => {
    const { socket, subject } = createSubject()
    socket.send.mockImplementationOnce(
      (
        _msg: Buffer,
        _port: number,
        _address: string,
        callback: (error: Error | null) => void
      ) => callback(new Error('network down'))
    )

    await expect(
      subject.send(Buffer.from('x'), 5351, '192.168.1.1')
    ).rejects.toThrow('network down')
  })

  it('fans native messages out to registered listeners', () => {
    const { socket, subject } = createSubject()
    const first = vi.fn()
    const removed = vi.fn()
    subject.onMessage(first)
    subject.onMessage(removed)
    subject.offMessage(removed)

    const message = Buffer.from('response')
    const rinfo = { address: '192.168.1.1', port: 5351, size: message.length }
    socket.emit('message', message, rinfo)

    expect(first).toHaveBeenCalledWith(message, rinfo)
    expect(removed).not.toHaveBeenCalled()
  })

  it('reports native address state and tolerates an unbound socket', () => {
    const { socket, subject } = createSubject()
    expect(subject.address()).toEqual({
      port: 12345,
      address: '127.0.0.1',
    })

    socket.address.mockImplementationOnce(() => {
      throw new Error('not bound')
    })
    expect(subject.address()).toBeNull()
  })

  it('closes once and rejects later mutations', async () => {
    const { socket, subject } = createSubject()

    await subject.close()
    await subject.close()

    expect(socket.close).toHaveBeenCalledOnce()
    expect(subject.address()).toBeNull()
    await expect(subject.bind()).rejects.toThrow('socket closed')
    await expect(
      subject.send(Buffer.from('x'), 1, '127.0.0.1')
    ).rejects.toThrow('socket closed')
    expect(() => subject.addMembership('239.0.0.1')).toThrow('socket closed')
    expect(() => subject.setMulticastTTL(1)).toThrow('socket closed')
  })
})
