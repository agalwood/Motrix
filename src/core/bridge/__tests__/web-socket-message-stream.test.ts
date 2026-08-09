import { EventEmitter } from 'node:events'
import {
  type WebSocketLike,
  WebSocketMessageReader,
  WebSocketMessageWriter,
} from '@core/bridge/web-socket-message-stream'
import { describe, expect, it, vi } from 'vitest'
import type { Message } from 'vscode-jsonrpc'

// Minimal ws.WebSocket stub.
class FakeWebSocket extends EventEmitter {
  public readonly sent: string[] = []
  public readyState: number = 1 // OPEN
  send(data: string): void {
    this.sent.push(data)
  }
  close(): void {
    this.readyState = 3 // CLOSED
    this.emit('close')
  }
  // ws.WebSocket constants
  static readonly OPEN = 1
  static readonly CLOSED = 3
}

describe('WebSocketMessageReader', () => {
  it('delivers parsed JSON messages to listener', () => {
    const ws = new FakeWebSocket()
    const reader = new WebSocketMessageReader(ws as unknown as WebSocketLike)
    const received: Message[] = []
    reader.listen((m) => {
      received.push(m)
    })

    const frame = {
      jsonrpc: '2.0',
      method: 'system/ping',
      params: { sentAt: 1 },
      id: 'req-1',
    }
    ws.emit('message', Buffer.from(JSON.stringify(frame)))

    expect(received).toHaveLength(1)
    expect(received[0]).toEqual(frame)
  })

  it('reports parse errors via onError', () => {
    const ws = new FakeWebSocket()
    const reader = new WebSocketMessageReader(ws as unknown as WebSocketLike)
    reader.listen(() => {})
    const errors: Error[] = []
    reader.onError((e) => {
      errors.push(e)
    })

    ws.emit('message', Buffer.from('not json {'))

    expect(errors).toHaveLength(1)
    expect(errors[0]?.message).toMatch(/parse/i)
  })

  it('fires onClose when socket closes', () => {
    const ws = new FakeWebSocket()
    const reader = new WebSocketMessageReader(ws as unknown as WebSocketLike)
    reader.listen(() => {})
    const onClose = vi.fn()
    reader.onClose(onClose)

    ws.close()

    expect(onClose).toHaveBeenCalled()
  })

  it('dispose removes listeners and detaches from socket', () => {
    const ws = new FakeWebSocket()
    const reader = new WebSocketMessageReader(ws as unknown as WebSocketLike)
    const onMessage = vi.fn()
    reader.listen(onMessage)

    reader.dispose()
    ws.emit(
      'message',
      Buffer.from(JSON.stringify({ jsonrpc: '2.0', method: 'x' }))
    )

    expect(onMessage).not.toHaveBeenCalled()
  })
})

describe('WebSocketMessageWriter', () => {
  it('serializes Message to JSON and sends over socket', async () => {
    const ws = new FakeWebSocket()
    const writer = new WebSocketMessageWriter(ws as unknown as WebSocketLike)

    await writer.write({
      jsonrpc: '2.0',
      method: 'system/ping',
      params: { sentAt: 1 },
      id: 'req-1',
    } as Message)

    expect(ws.sent).toHaveLength(1)
    const parsed = JSON.parse(ws.sent[0] ?? '{}')
    expect(parsed.method).toBe('system/ping')
    expect(parsed.id).toBe('req-1')
  })

  it('rejects write when socket is not OPEN', async () => {
    const ws = new FakeWebSocket()
    ws.readyState = 3 // CLOSED
    const writer = new WebSocketMessageWriter(ws as unknown as WebSocketLike)

    await expect(
      writer.write({ jsonrpc: '2.0', method: 'x' } as Message)
    ).rejects.toThrow(/closed/i)
  })

  it('end() closes the socket', () => {
    const ws = new FakeWebSocket()
    const writer = new WebSocketMessageWriter(ws as unknown as WebSocketLike)
    writer.end()
    expect(ws.readyState).toBe(3)
  })
})
