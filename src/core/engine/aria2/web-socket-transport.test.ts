import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { WebSocketTransport } from './web-socket-transport'

const { MockWebSocket } = vi.hoisted(() => {
  class MockWebSocket {
    static instance: MockWebSocket | null = null
    readyState = 0
    listeners: Record<string, ((...args: unknown[]) => void)[]> = {}

    constructor(public url: string) {
      MockWebSocket.instance = this
    }

    on(event: string, handler: (...args: unknown[]) => void): this {
      if (!this.listeners[event]) this.listeners[event] = []
      this.listeners[event].push(handler)
      return this
    }

    removeAllListeners(): this {
      this.listeners = {}
      return this
    }

    send = vi.fn()
    close = vi.fn()
    terminate = vi.fn()

    _emit(event: string, ...args: unknown[]) {
      for (const handler of this.listeners[event] ?? []) {
        handler(...args)
      }
    }

    _simulateOpen() {
      this.readyState = 1
      this._emit('open')
    }

    _simulateMessage(data: string) {
      this._emit('message', data)
    }

    _simulateClose(code: number, reason: string) {
      this.readyState = 3
      this._emit('close', code, reason)
    }

    _simulateError(err: Error) {
      this._emit('error', err)
    }
  }

  return { MockWebSocket }
})

vi.mock('ws', () => ({
  default: MockWebSocket,
}))

describe('WebSocketTransport', () => {
  let transport: WebSocketTransport

  const getMockWebSocket = (): InstanceType<typeof MockWebSocket> => {
    const ws = MockWebSocket.instance
    expect(ws).not.toBeNull()
    if (!ws) throw new Error('MockWebSocket.instance is null')
    return ws
  }

  beforeEach(() => {
    MockWebSocket.instance = null
    transport = new WebSocketTransport()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  describe('connect', () => {
    it('creates a WebSocket and resolves on open', async () => {
      const connectPromise = transport.connect('ws://127.0.0.1:16800/jsonrpc')
      const ws = getMockWebSocket()
      expect(ws.url).toBe('ws://127.0.0.1:16800/jsonrpc')
      ws._simulateOpen()
      await expect(connectPromise).resolves.toBeUndefined()
      expect(transport.isConnected()).toBe(true)
    })

    it('rejects when connection fails with error', async () => {
      const connectPromise = transport.connect('ws://127.0.0.1:16800/jsonrpc')
      getMockWebSocket()._simulateError(new Error('Connection refused'))
      await expect(connectPromise).rejects.toThrow('Connection refused')
      expect(transport.isConnected()).toBe(false)
    })

    it('rejects if already connected', async () => {
      const p = transport.connect('ws://127.0.0.1:16800/jsonrpc')
      getMockWebSocket()._simulateOpen()
      await p
      await expect(
        transport.connect('ws://127.0.0.1:16800/jsonrpc')
      ).rejects.toThrow('already connected')
    })
  })

  describe('disconnect', () => {
    it('closes the socket and cleans up', async () => {
      const p = transport.connect('ws://127.0.0.1:16800/jsonrpc')
      getMockWebSocket()._simulateOpen()
      await p
      const ws = getMockWebSocket()
      transport.disconnect()
      expect(ws.close).toHaveBeenCalled()
      expect(transport.isConnected()).toBe(false)
    })

    it('is a no-op when not connected', () => {
      transport.disconnect()
      expect(transport.isConnected()).toBe(false)
    })
  })

  describe('send', () => {
    it('sends data through the socket', async () => {
      const p = transport.connect('ws://127.0.0.1:16800/jsonrpc')
      getMockWebSocket()._simulateOpen()
      await p
      transport.send('{"jsonrpc":"2.0"}')
      expect(getMockWebSocket().send).toHaveBeenCalledWith('{"jsonrpc":"2.0"}')
    })

    it('throws when not connected', () => {
      expect(() => transport.send('data')).toThrow('not connected')
    })
  })

  describe('onMessage', () => {
    it('dispatches incoming messages to handler', async () => {
      const handler = vi.fn()
      transport.onMessage(handler)
      const p = transport.connect('ws://127.0.0.1:16800/jsonrpc')
      getMockWebSocket()._simulateOpen()
      await p
      getMockWebSocket()._simulateMessage('{"jsonrpc":"2.0"}')
      expect(handler).toHaveBeenCalledWith('{"jsonrpc":"2.0"}')
    })
  })

  describe('onClose', () => {
    it('dispatches close events to handler', async () => {
      const handler = vi.fn()
      transport.onClose(handler)
      const p = transport.connect('ws://127.0.0.1:16800/jsonrpc')
      getMockWebSocket()._simulateOpen()
      await p
      getMockWebSocket()._simulateClose(1000, 'Normal closure')
      expect(handler).toHaveBeenCalledWith(1000, 'Normal closure')
    })
  })

  describe('onError', () => {
    it('dispatches error events to handler after connection', async () => {
      const handler = vi.fn()
      transport.onError(handler)
      const p = transport.connect('ws://127.0.0.1:16800/jsonrpc')
      getMockWebSocket()._simulateOpen()
      await p
      const err = new Error('Unexpected frame')
      getMockWebSocket()._simulateError(err)
      expect(handler).toHaveBeenCalledWith(err)
    })
  })
})
