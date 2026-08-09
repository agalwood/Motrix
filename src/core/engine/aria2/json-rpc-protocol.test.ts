import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { JsonRpcProtocol } from './json-rpc-protocol'
import type { WebSocketTransport } from './web-socket-transport'

class FakeTransport {
  private messageHandler: ((data: string) => void) | null = null
  sent: string[] = []

  connect = vi.fn<(url: string) => Promise<void>>().mockResolvedValue(undefined)
  disconnect = vi.fn()
  isConnected = vi.fn().mockReturnValue(true)

  send(data: string): void {
    this.sent.push(data)
  }

  onMessage(handler: (data: string) => void): void {
    this.messageHandler = handler
  }

  onClose = vi.fn()
  onError = vi.fn()

  _receive(data: string) {
    this.messageHandler?.(data)
  }

  _respondTo(id: string | number, result: unknown) {
    this._receive(JSON.stringify({ jsonrpc: '2.0', id: String(id), result }))
  }

  _respondError(id: string | number, code: number, message: string) {
    this._receive(
      JSON.stringify({
        jsonrpc: '2.0',
        id: String(id),
        error: { code, message },
      })
    )
  }

  _notify(method: string, params: unknown[]) {
    this._receive(JSON.stringify({ jsonrpc: '2.0', method, params }))
  }
}

describe('JsonRpcProtocol', () => {
  let transport: FakeTransport
  let protocol: JsonRpcProtocol

  beforeEach(() => {
    vi.useFakeTimers()
    transport = new FakeTransport()
    protocol = new JsonRpcProtocol(transport as unknown as WebSocketTransport, {
      timeoutMs: 5000,
    })
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  describe('call', () => {
    it('sends a JSON-RPC 2.0 request and resolves on response', async () => {
      const resultPromise = protocol.call<string>('aria2.getVersion', [])
      expect(transport.sent).toHaveLength(1)
      const request = JSON.parse(transport.sent[0])
      expect(request.jsonrpc).toBe('2.0')
      expect(request.method).toBe('aria2.getVersion')
      expect(request.params).toEqual([])
      expect(request.id).toBeDefined()
      transport._respondTo(request.id, {
        version: '1.37.0',
        enabledFeatures: ['BitTorrent'],
      })
      const result = await resultPromise
      expect(result).toEqual({
        version: '1.37.0',
        enabledFeatures: ['BitTorrent'],
      })
    })

    it('rejects on JSON-RPC error response', async () => {
      const resultPromise = protocol.call<string>('aria2.addUri', [
        ['http://bad'],
      ])
      const request = JSON.parse(transport.sent[0])
      transport._respondError(request.id, -1, 'No URI given')
      await expect(resultPromise).rejects.toThrow('No URI given')
    })

    it('rejects on timeout', async () => {
      const resultPromise = protocol.call<string>('aria2.tellStatus', ['abc'])
      vi.advanceTimersByTime(5001)
      await expect(resultPromise).rejects.toThrow('timed out')
    })

    it('assigns incrementing request IDs', () => {
      protocol.call('aria2.method1', [])
      protocol.call('aria2.method2', [])
      const id1 = JSON.parse(transport.sent[0]).id
      const id2 = JSON.parse(transport.sent[1]).id
      expect(Number(id2)).toBeGreaterThan(Number(id1))
    })
  })

  describe('multicall', () => {
    it('sends system.multicall with wrapped calls', async () => {
      const resultPromise = protocol.multicall([
        { method: 'aria2.tellActive', params: [] },
        { method: 'aria2.tellWaiting', params: [0, 100] },
      ])
      expect(transport.sent).toHaveLength(1)
      const request = JSON.parse(transport.sent[0])
      expect(request.method).toBe('system.multicall')
      expect(request.params).toEqual([
        [
          { methodName: 'aria2.tellActive', params: [] },
          { methodName: 'aria2.tellWaiting', params: [0, 100] },
        ],
      ])
      transport._respondTo(request.id, [[['activeTask1']], [['waitingTask1']]])
      const result = await resultPromise
      expect(result).toEqual([['activeTask1'], ['waitingTask1']])
    })
  })

  describe('multicallSettled', () => {
    it('maps array entries to fulfilled and fault objects to rejected, in order', async () => {
      const resultPromise = protocol.multicallSettled([
        { method: 'aria2.removeDownloadResult', params: ['gid-ok'] },
        { method: 'aria2.removeDownloadResult', params: ['gid-gone'] },
        { method: 'aria2.removeDownloadResult', params: ['gid-ok-2'] },
      ])
      const request = JSON.parse(transport.sent[0])
      expect(request.method).toBe('system.multicall')
      transport._respondTo(request.id, [
        ['OK'],
        { code: 1, message: 'GID gid-gone is not found' },
        ['OK'],
      ])
      const result = await resultPromise
      expect(result).toEqual([
        { status: 'fulfilled', value: 'OK' },
        { status: 'rejected', reason: expect.any(Error) },
        { status: 'fulfilled', value: 'OK' },
      ])
      const rejected = result[1] as PromiseRejectedResult
      // Same Error shape as a single call's rejection so downstream
      // classifiers (isNotFoundError) work unchanged.
      expect((rejected.reason as Error).message).toBe(
        'GID gid-gone is not found'
      )
    })

    it('rejects the whole batch on a transport-level JSON-RPC error', async () => {
      const resultPromise = protocol.multicallSettled([
        { method: 'aria2.removeDownloadResult', params: ['gid-1'] },
      ])
      const request = JSON.parse(transport.sent[0])
      transport._respondError(request.id, 1, 'Unauthorized')
      await expect(resultPromise).rejects.toThrow('Unauthorized')
    })
  })

  describe('onNotification', () => {
    it('routes notification messages to handler', () => {
      const handler = vi.fn()
      protocol.onNotification(handler)
      transport._notify('aria2.onDownloadComplete', [{ gid: 'abc123' }])
      expect(handler).toHaveBeenCalledWith('aria2.onDownloadComplete', [
        { gid: 'abc123' },
      ])
    })

    it('does not route responses to notification handler', async () => {
      const handler = vi.fn()
      protocol.onNotification(handler)
      const resultPromise = protocol.call('aria2.getVersion', [])
      const request = JSON.parse(transport.sent[0])
      transport._respondTo(request.id, { version: '1.37.0' })
      await resultPromise
      expect(handler).not.toHaveBeenCalled()
    })
  })
})
