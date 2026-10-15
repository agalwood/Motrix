import { describe, expect, it, vi } from 'vitest'
import type { Message } from 'vscode-jsonrpc'
import {
  BrowserWebSocketMessageReader,
  BrowserWebSocketMessageWriter,
} from '@/background/BrowserWebSocketStream'

class FakeBrowserWebSocket extends EventTarget {
  public readonly sent: string[] = []
  public readyState = 1 // OPEN
  send(data: string): void {
    this.sent.push(data)
  }
  close(): void {
    this.readyState = 3 // CLOSED
    this.dispatchEvent(new Event('close'))
  }
  fireMessage(text: string): void {
    this.dispatchEvent(new MessageEvent('message', { data: text }))
  }
  fireError(): void {
    this.dispatchEvent(new Event('error'))
  }
}

describe('BrowserWebSocketMessageReader', () => {
  it('parses MessageEvent.data and forwards to listener', () => {
    const ws = new FakeBrowserWebSocket()
    const reader = new BrowserWebSocketMessageReader(ws as unknown as WebSocket)
    const received: Message[] = []
    reader.listen((m) => received.push(m))

    ws.fireMessage(
      JSON.stringify({ jsonrpc: '2.0', method: 'x', params: { y: 1 } })
    )

    expect(received).toHaveLength(1)
    expect(received[0]).toEqual({
      jsonrpc: '2.0',
      method: 'x',
      params: { y: 1 },
    })
  })

  it('emits onError for non-JSON data', () => {
    const ws = new FakeBrowserWebSocket()
    const reader = new BrowserWebSocketMessageReader(ws as unknown as WebSocket)
    const errors: Error[] = []
    reader.onError((e) => errors.push(e))
    reader.listen(() => {})

    ws.fireMessage('not json')
    expect(errors).toHaveLength(1)
  })

  it('fires onClose when socket closes', () => {
    const ws = new FakeBrowserWebSocket()
    const reader = new BrowserWebSocketMessageReader(ws as unknown as WebSocket)
    const cb = vi.fn()
    reader.onClose(cb)
    reader.listen(() => {})
    ws.close()
    expect(cb).toHaveBeenCalled()
  })

  it('dispose() removes event listeners', () => {
    const ws = new FakeBrowserWebSocket()
    const reader = new BrowserWebSocketMessageReader(ws as unknown as WebSocket)
    const cb = vi.fn()
    reader.listen(cb)
    reader.dispose()
    ws.fireMessage(JSON.stringify({ jsonrpc: '2.0', method: 'x' }))
    expect(cb).not.toHaveBeenCalled()
  })
})

describe('BrowserWebSocketMessageWriter', () => {
  it('write() serializes and sends', async () => {
    const ws = new FakeBrowserWebSocket()
    const writer = new BrowserWebSocketMessageWriter(ws as unknown as WebSocket)
    await writer.write({
      jsonrpc: '2.0',
      method: 'system/ping',
      params: { sentAt: 1 },
    } as Message)
    expect(ws.sent).toHaveLength(1)
    expect(JSON.parse(ws.sent[0] ?? '')).toEqual({
      jsonrpc: '2.0',
      method: 'system/ping',
      params: { sentAt: 1 },
    })
  })

  it('write() rejects when socket is not OPEN', async () => {
    const ws = new FakeBrowserWebSocket()
    ws.readyState = 3 // CLOSED
    const writer = new BrowserWebSocketMessageWriter(ws as unknown as WebSocket)
    await expect(
      writer.write({ jsonrpc: '2.0', method: 'x' } as Message)
    ).rejects.toThrow(/closed/i)
  })
})
