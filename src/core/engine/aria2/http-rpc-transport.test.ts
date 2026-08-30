import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { HttpRpcTransport } from './http-rpc-transport'

const { mockConnect, mockRequest } = vi.hoisted(() => ({
  mockConnect: vi.fn(),
  mockRequest: vi.fn(),
}))

vi.mock('node:net', () => ({
  default: {
    connect: mockConnect,
  },
}))

vi.mock('undici', () => ({
  Agent: class MockAgent {
    close = vi.fn().mockResolvedValue(undefined)
  },
  request: (...args: unknown[]) => mockRequest(...args),
}))

interface FakeSocket {
  handlers: Record<string, Array<(...args: unknown[]) => void>>
  on: (event: string, handler: (...args: unknown[]) => void) => FakeSocket
  setTimeout: (ms: number, handler?: () => void) => void
  end: ReturnType<typeof vi.fn>
  destroy: ReturnType<typeof vi.fn>
  emit: (event: string, ...args: unknown[]) => void
}

function createFakeSocket(): FakeSocket {
  const handlers: Record<string, Array<(...args: unknown[]) => void>> = {}
  const socket: FakeSocket = {
    handlers,
    on(event, handler) {
      if (!handlers[event]) handlers[event] = []
      handlers[event].push(handler)
      return socket
    },
    setTimeout: vi.fn(),
    end: vi.fn(),
    destroy: vi.fn(),
    emit(event, ...args) {
      for (const handler of handlers[event] ?? []) {
        handler(...args)
      }
    },
  }
  return socket
}

describe('HttpRpcTransport', () => {
  let transport: HttpRpcTransport
  let socket: FakeSocket

  beforeEach(() => {
    socket = createFakeSocket()
    mockConnect.mockReset()
    mockRequest.mockReset()
    mockConnect.mockImplementation(
      (_port: number, _host: string, onConnect?: () => void): FakeSocket => {
        if (onConnect) {
          queueMicrotask(onConnect)
        }
        return socket
      }
    )
    transport = new HttpRpcTransport()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  describe('connect', () => {
    it('probes TCP and resolves on a listening HTTP RPC port', async () => {
      await transport.connect('http://127.0.0.1:16800/jsonrpc')
      expect(mockConnect).toHaveBeenCalledWith(
        16800,
        '127.0.0.1',
        expect.any(Function)
      )
      expect(socket.end).toHaveBeenCalled()
      expect(transport.isConnected()).toBe(true)
    })

    it('rejects non-http URLs', async () => {
      await expect(
        transport.connect('ws://127.0.0.1:16800/jsonrpc')
      ).rejects.toThrow('http(s)')
      expect(transport.isConnected()).toBe(false)
    })

    it('rejects if already connected', async () => {
      await transport.connect('http://127.0.0.1:16800/jsonrpc')
      await expect(
        transport.connect('http://127.0.0.1:16800/jsonrpc')
      ).rejects.toThrow('already connected')
    })
  })

  describe('send', () => {
    it('POSTs JSON-RPC and delivers the response body as a message', async () => {
      const handler = vi.fn()
      transport.onMessage(handler)
      await transport.connect('http://127.0.0.1:16800/jsonrpc')
      mockRequest.mockResolvedValue({
        body: {
          text: async () => '{"jsonrpc":"2.0","id":"1","result":"OK"}',
        },
      })

      transport.send('{"jsonrpc":"2.0","id":"1"}')
      await vi.waitFor(() => {
        expect(handler).toHaveBeenCalledWith(
          '{"jsonrpc":"2.0","id":"1","result":"OK"}'
        )
      })
      expect(mockRequest).toHaveBeenCalledWith(
        'http://127.0.0.1:16800/jsonrpc',
        expect.objectContaining({
          method: 'POST',
          headers: expect.objectContaining({
            'content-type': 'application/json',
            connection: 'close',
          }),
          body: '{"jsonrpc":"2.0","id":"1"}',
        })
      )
    })

    it('throws when not connected', () => {
      expect(() => transport.send('data')).toThrow('not connected')
    })

    it('forwards request errors to the error handler', async () => {
      const handler = vi.fn()
      transport.onError(handler)
      await transport.connect('http://127.0.0.1:16800/jsonrpc')
      mockRequest.mockRejectedValue(new Error('ECONNRESET'))

      transport.send('{"jsonrpc":"2.0"}')
      await vi.waitFor(() => {
        expect(handler).toHaveBeenCalledWith(expect.any(Error))
      })
      expect(handler.mock.calls[0][0].message).toBe('ECONNRESET')
    })
  })

  describe('disconnect', () => {
    it('clears connected state', async () => {
      await transport.connect('http://127.0.0.1:16800/jsonrpc')
      transport.disconnect()
      expect(transport.isConnected()).toBe(false)
    })
  })
})
