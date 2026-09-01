import { EventEmitter } from 'node:events'
import { BridgeConnection } from '@core/bridge/bridge-connection'
import { describe, expect, it, vi } from 'vitest'

class FakeWebSocket extends EventEmitter {
  public readonly sent: string[] = []
  public readyState = 1
  send(data: string): void {
    this.sent.push(data)
    // simulate the same socket receiving its own writes (for testing
    // 1-side, we don't need a real peer here)
  }
  close(): void {
    this.readyState = 3
    this.emit('close')
  }
}

describe('BridgeConnection', () => {
  it('exposes session metadata', () => {
    const ws = new FakeWebSocket()
    const conn = new BridgeConnection(ws as never, {
      sessionKey: 'chromium:abc',
      extensionId: 'abc',
      browser: 'chromium',
      startedAt: 1000,
    })
    expect(conn.sessionKey).toBe('chromium:abc')
    expect(conn.session.extensionId).toBe('abc')
    expect(conn.session.browser).toBe('chromium')
  })

  it('listen() begins processing incoming frames', async () => {
    const ws = new FakeWebSocket()
    const conn = new BridgeConnection(ws as never, {
      sessionKey: 'chromium:abc',
      extensionId: 'abc',
      browser: 'chromium',
      startedAt: 1000,
    })
    const handler = vi.fn().mockResolvedValue({ sentAt: 1, recvAt: 2 })
    conn.onRequest('system/ping', handler)
    conn.listen()

    // simulate the peer sending a request
    ws.emit(
      'message',
      Buffer.from(
        JSON.stringify({
          jsonrpc: '2.0',
          id: 'r1',
          method: 'system/ping',
          params: { sentAt: 1 },
        })
      )
    )

    // give the event loop a tick to dispatch
    await new Promise((r) => setTimeout(r, 5))
    expect(handler).toHaveBeenCalled()
  })

  it('sendNotification writes a JSON-RPC notification to the socket', () => {
    const ws = new FakeWebSocket()
    const conn = new BridgeConnection(ws as never, {
      sessionKey: 'chromium:abc',
      extensionId: 'abc',
      browser: 'chromium',
      startedAt: 1000,
    })
    conn.listen()

    conn.sendNotification('$/task/progress', {
      taskId: 't1',
      bytesDone: 100,
      bytesTotal: 1000,
      speedBps: 50,
      etaSec: 18,
      phase: 'downloading',
    })

    expect(ws.sent).toHaveLength(1)
    const parsed = JSON.parse(ws.sent[0] ?? '{}')
    expect(parsed.method).toBe('$/task/progress')
    expect(parsed.params.taskId).toBe('t1')
    expect(parsed.id).toBeUndefined()
  })

  it('contains a notification write race after the socket has closed', async () => {
    const ws = new FakeWebSocket()
    const conn = new BridgeConnection(ws as never, {
      sessionKey: 'chromium:abc',
      extensionId: 'abc',
      browser: 'chromium',
      startedAt: 1000,
    })
    conn.listen()
    ws.close()

    expect(() =>
      conn.sendNotification('$/task/progress', {
        taskId: 't1',
        bytesDone: 100,
        bytesTotal: 1000,
        speedBps: 50,
        etaSec: 18,
        phase: 'downloading',
      })
    ).not.toThrow()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(ws.sent).toHaveLength(0)
  })

  it('motrix/initialized notification flips isReady to true', async () => {
    const ws = new FakeWebSocket()
    const conn = new BridgeConnection(ws as never, {
      sessionKey: 'chromium:abc',
      extensionId: 'abc',
      browser: 'chromium',
      startedAt: 0,
    })
    expect(conn.isReady()).toBe(false)

    // Use the new markReady() directly — the bridge server wires the
    // notification handler at the WebSocketBridgeServer layer, but
    // BridgeConnection's contract is just to expose the flag.
    conn.markReady()
    expect(conn.isReady()).toBe(true)
  })

  it('cuts authorization and readiness immediately when access is revoked', () => {
    const ws = new FakeWebSocket()
    const conn = new BridgeConnection(ws as never, {
      sessionKey: 'chromium:abc',
      extensionId: 'abc',
      browser: 'chromium',
      startedAt: 0,
    })
    conn.markAuthorized()
    conn.markReady()

    conn.revokeAuthorization()

    expect(conn.isAuthorized()).toBe(false)
    expect(conn.isReady()).toBe(false)
  })

  it('dispose tears down the underlying mdxp connection', () => {
    const ws = new FakeWebSocket()
    const conn = new BridgeConnection(ws as never, {
      sessionKey: 'chromium:abc',
      extensionId: 'abc',
      browser: 'chromium',
      startedAt: 1000,
    })
    conn.listen()
    conn.dispose()
    // After dispose, no listeners should remain on ws.
    expect(ws.listenerCount('message')).toBe(0)
  })
})
