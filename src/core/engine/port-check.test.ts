import { EventEmitter } from 'node:events'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { createServerMock } = vi.hoisted(() => ({
  createServerMock: vi.fn(),
}))

vi.mock('node:net', () => ({
  default: { createServer: createServerMock },
}))

import { checkPort, findAvailablePort } from './port-check'

class FakeServer extends EventEmitter {
  listen = vi.fn((_port: number, _host: string) => undefined)
  close = vi.fn((callback: () => void) => callback())
}

describe('checkPort', () => {
  beforeEach(() => {
    createServerMock.mockReset()
  })

  it('returns true after binding and closing the loopback listener', async () => {
    const server = new FakeServer()
    createServerMock.mockReturnValueOnce(server)
    server.listen.mockImplementationOnce(() => {
      queueMicrotask(() => server.emit('listening'))
    })

    await expect(checkPort(16800)).resolves.toBe(true)
    expect(server.listen).toHaveBeenCalledWith(16800, '127.0.0.1')
    expect(server.close).toHaveBeenCalledOnce()
  })

  it('returns false when the port cannot be bound', async () => {
    const server = new FakeServer()
    createServerMock.mockReturnValueOnce(server)
    server.listen.mockImplementationOnce(() => {
      queueMicrotask(() => server.emit('error', new Error('in use')))
    })

    await expect(checkPort(16800)).resolves.toBe(false)
    expect(server.close).not.toHaveBeenCalled()
  })
})

describe('findAvailablePort', () => {
  beforeEach(() => {
    createServerMock.mockReset()
  })

  function queueBindResult(available: boolean): FakeServer {
    const server = new FakeServer()
    server.listen.mockImplementationOnce(() => {
      queueMicrotask(() =>
        server.emit(available ? 'listening' : 'error', new Error('in use'))
      )
    })
    createServerMock.mockReturnValueOnce(server)
    return server
  }

  it('clamps low preferred ports and returns the first bindable candidate', async () => {
    const occupiedA = queueBindResult(false)
    const occupiedB = queueBindResult(false)
    const available = queueBindResult(true)

    await expect(findAvailablePort(80, 5)).resolves.toBe(1026)
    expect(occupiedA.listen).toHaveBeenCalledWith(1024, '127.0.0.1')
    expect(occupiedB.listen).toHaveBeenCalledWith(1025, '127.0.0.1')
    expect(available.listen).toHaveBeenCalledWith(1026, '127.0.0.1')
  })

  it('stops at the maximum TCP port', async () => {
    const lastPort = queueBindResult(false)

    await expect(findAvailablePort(65_535, 3)).resolves.toBeNull()
    expect(lastPort.listen).toHaveBeenCalledWith(65_535, '127.0.0.1')
    expect(createServerMock).toHaveBeenCalledOnce()
  })

  it('returns null without probing when attempts is zero', async () => {
    await expect(findAvailablePort(16800, 0)).resolves.toBeNull()
    expect(createServerMock).not.toHaveBeenCalled()
  })
})
