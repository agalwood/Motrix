import { describe, expect, it } from 'vitest'
import { MBP1_SUBPROTOCOL } from '@/background/mbp1/frames'
import { WebSocketFrameChannel } from '@/background/WebSocketFrameChannel'

const OPEN = 1
const CLOSED = 3

class FakeWebSocket extends EventTarget {
  static lastInstance: FakeWebSocket | null = null
  readonly sent: Array<string | Uint8Array> = []
  readyState = 0
  binaryType = 'blob'

  constructor(
    public readonly url: string,
    public readonly protocols?: string | string[]
  ) {
    super()
    FakeWebSocket.lastInstance = this
  }

  send(data: string | Uint8Array): void {
    if (this.readyState !== OPEN) {
      throw new Error('cannot send: not open')
    }
    this.sent.push(data)
  }

  close(): void {
    if (this.readyState === CLOSED) return
    this.readyState = CLOSED
    this.dispatchEvent(new Event('close'))
  }

  fireOpen(): void {
    this.readyState = OPEN
    this.dispatchEvent(new Event('open'))
  }

  fireError(): void {
    this.dispatchEvent(new Event('error'))
  }

  fireText(text: string): void {
    this.dispatchEvent(new MessageEvent('message', { data: text }))
  }

  fireBinary(bytes: Uint8Array): void {
    const buf = bytes.buffer.slice(
      bytes.byteOffset,
      bytes.byteOffset + bytes.byteLength
    )
    this.dispatchEvent(new MessageEvent('message', { data: buf }))
  }
}

async function makeOpenChannel(): Promise<{
  channel: WebSocketFrameChannel
  ws: FakeWebSocket
}> {
  const channel = new WebSocketFrameChannel({
    WebSocketCtor: FakeWebSocket as unknown as typeof WebSocket,
  })
  const openPromise = channel.open('ws://127.0.0.1:16803/pair?nonce=n')
  const ws = FakeWebSocket.lastInstance
  if (ws === null) throw new Error('WebSocket not constructed')
  ws.fireOpen()
  // `open()`'s post-await continuation (assigning `this.ws` and attaching
  // the steady-state listeners) runs as a microtask after `fireOpen()`
  // resolves the inner promise — awaiting here is what makes the channel
  // actually usable by the time this helper returns.
  await openPromise
  return { channel, ws }
}

describe('WebSocketFrameChannel.open', () => {
  it('requests the motrix-bridge.v1 subprotocol', async () => {
    const channel = new WebSocketFrameChannel({
      WebSocketCtor: FakeWebSocket as unknown as typeof WebSocket,
    })
    const p = channel.open('ws://127.0.0.1:16803/pair?nonce=n')
    FakeWebSocket.lastInstance?.fireOpen()
    await p
    expect(FakeWebSocket.lastInstance?.protocols).toBe(MBP1_SUBPROTOCOL)
  })

  it('forces binaryType to arraybuffer', async () => {
    const channel = new WebSocketFrameChannel({
      WebSocketCtor: FakeWebSocket as unknown as typeof WebSocket,
    })
    const p = channel.open('ws://127.0.0.1:16803/pair?nonce=n')
    FakeWebSocket.lastInstance?.fireOpen()
    await p
    expect(FakeWebSocket.lastInstance?.binaryType).toBe('arraybuffer')
  })

  it('records the opened URL', async () => {
    const { channel } = await makeOpenChannel()
    expect(channel.openedUrl).toBe('ws://127.0.0.1:16803/pair?nonce=n')
  })

  it('rejects when the socket errors before opening', async () => {
    const channel = new WebSocketFrameChannel({
      WebSocketCtor: FakeWebSocket as unknown as typeof WebSocket,
    })
    const p = channel.open('ws://127.0.0.1:16803/pair?nonce=n')
    FakeWebSocket.lastInstance?.fireError()
    await expect(p).rejects.toThrow(/failed to open/i)
  })

  it('rejects when the socket closes before opening', async () => {
    const channel = new WebSocketFrameChannel({
      WebSocketCtor: FakeWebSocket as unknown as typeof WebSocket,
    })
    const p = channel.open('ws://127.0.0.1:16803/pair?nonce=n')
    FakeWebSocket.lastInstance?.close()
    await expect(p).rejects.toThrow(/closed before opening/i)
  })

  it('rejects after the open timeout elapses', async () => {
    const channel = new WebSocketFrameChannel({
      WebSocketCtor: FakeWebSocket as unknown as typeof WebSocket,
      openTimeoutMs: 5,
    })
    await expect(
      channel.open('ws://127.0.0.1:16803/pair?nonce=n')
    ).rejects.toThrow(/timed out/i)
  })
})

describe('WebSocketFrameChannel send/receive', () => {
  it('sendText JSON-stringifies and sends as a text frame', async () => {
    const { channel, ws } = await makeOpenChannel()
    await channel.sendText({ type: 'pairHello', browser: 'chromium' })
    expect(ws.sent).toEqual([
      JSON.stringify({ type: 'pairHello', browser: 'chromium' }),
    ])
  })

  it('sendBinary sends the raw bytes', async () => {
    const { channel, ws } = await makeOpenChannel()
    const bytes = new Uint8Array([1, 2, 3])
    await channel.sendBinary(bytes)
    expect(ws.sent).toEqual([bytes])
  })

  it('receiveText resolves a frame already queued before it was asked for', async () => {
    const { channel, ws } = await makeOpenChannel()
    ws.fireText('{"type":"pairAccept"}')
    await expect(channel.receiveText(1_000)).resolves.toBe(
      '{"type":"pairAccept"}'
    )
  })

  it('receiveText resolves a frame that arrives after the call is made', async () => {
    const { channel, ws } = await makeOpenChannel()
    const p = channel.receiveText(1_000)
    ws.fireText('{"type":"pairAccept"}')
    await expect(p).resolves.toBe('{"type":"pairAccept"}')
  })

  it('receiveBinary resolves the raw bytes of a binary frame', async () => {
    const { channel, ws } = await makeOpenChannel()
    const bytes = new Uint8Array([9, 8, 7])
    const p = channel.receiveBinary(1_000)
    ws.fireBinary(bytes)
    await expect(p).resolves.toEqual(bytes)
  })

  it('queues frames FIFO across multiple receives', async () => {
    const { channel, ws } = await makeOpenChannel()
    ws.fireText('first')
    ws.fireText('second')
    await expect(channel.receiveText(1_000)).resolves.toBe('first')
    await expect(channel.receiveText(1_000)).resolves.toBe('second')
  })

  it('rejects receiveText with a §6.1 violation when a binary frame is queued', async () => {
    const { channel, ws } = await makeOpenChannel()
    ws.fireBinary(new Uint8Array([1]))
    await expect(channel.receiveText(1_000)).rejects.toThrow(
      /expected a text frame/i
    )
  })

  it('rejects receiveBinary with a §6.1 violation when a text frame is queued', async () => {
    const { channel, ws } = await makeOpenChannel()
    ws.fireText('{}')
    await expect(channel.receiveBinary(1_000)).rejects.toThrow(
      /expected a binary frame/i
    )
  })

  it('rejects a second concurrent receive rather than losing the first', async () => {
    const { channel } = await makeOpenChannel()
    const first = channel.receiveText(1_000)
    await expect(channel.receiveText(1_000)).rejects.toThrow(/already pending/i)
    // The first call is still alive and not corrupted by the second attempt.
    void first.catch(() => {})
  })

  it('rejects a pending receive when the timeout elapses', async () => {
    const { channel } = await makeOpenChannel()
    await expect(channel.receiveText(5)).rejects.toThrow(/timed out/i)
  })

  it('rejects receiveText immediately when the socket is already closed with nothing pending', async () => {
    const { channel, ws } = await makeOpenChannel()
    ws.close()
    await expect(channel.receiveText(1_000)).rejects.toThrow(/closed/i)
  })

  it('rejects a pending receive when the socket closes while waiting', async () => {
    const { channel, ws } = await makeOpenChannel()
    const p = channel.receiveText(1_000)
    ws.close()
    await expect(p).rejects.toThrow(/closed/i)
  })

  it('delivers a frame that was already queued even after the socket later closes', async () => {
    // A close must not retroactively discard a frame that arrived first.
    const { channel, ws } = await makeOpenChannel()
    ws.fireText('queued-before-close')
    ws.close()
    await expect(channel.receiveText(1_000)).resolves.toBe(
      'queued-before-close'
    )
  })
})

describe('WebSocketFrameChannel.close', () => {
  it('closes and immediately rejects an in-progress open without exposing its URL', async () => {
    const channel = new WebSocketFrameChannel({
      WebSocketCtor: FakeWebSocket as unknown as typeof WebSocket,
      openTimeoutMs: 60_000,
    })
    const opening = channel.open(
      'ws://127.0.0.1:16803/pair?nonce=must-not-appear-in-errors'
    )
    const ws = FakeWebSocket.lastInstance
    if (ws === null) throw new Error('WebSocket not constructed')

    channel.close()

    expect(ws.readyState).toBe(CLOSED)
    const error = await opening.catch((reason: unknown) => reason)
    expect(error).toEqual(expect.any(Error))
    expect((error as Error).message).toBe('WebSocketFrameChannel closed')
    expect((error as Error).message).not.toContain('nonce=')
    expect(() => channel.close()).not.toThrow()
  })

  it('immediately rejects a pending receive with a fixed owner-close error', async () => {
    const { channel, ws } = await makeOpenChannel()
    const receiving = channel.receiveText(60_000)

    channel.close()

    expect(ws.readyState).toBe(CLOSED)
    await expect(receiving).rejects.toThrow(/^WebSocketFrameChannel closed$/)
  })

  it('closes the underlying socket', async () => {
    const { channel, ws } = await makeOpenChannel()
    channel.close()
    expect(ws.readyState).toBe(CLOSED)
  })

  it('is idempotent on an already-closed socket', async () => {
    const { channel, ws } = await makeOpenChannel()
    ws.close()
    expect(() => channel.close()).not.toThrow()
  })

  it('is safe to call before open()', () => {
    const channel = new WebSocketFrameChannel({
      WebSocketCtor: FakeWebSocket as unknown as typeof WebSocket,
    })
    expect(() => channel.close()).not.toThrow()
  })
})

describe('WebSocketFrameChannel.release', () => {
  it('returns the live socket and detaches this channel from it', async () => {
    const { channel, ws } = await makeOpenChannel()
    const { socket, queuedFrames } = channel.release()
    expect(socket).toBe(ws)
    expect(queuedFrames).toEqual([])

    // Frames arriving after release must not be captured by this channel —
    // a second transport layer (the envelope reader) owns the socket now.
    ws.fireText('post-release')
    expect(ws.readyState).not.toBe(CLOSED) // release() must not close it
  })

  it('hands over binary frames that arrived after the last receive() but before release()', async () => {
    const { channel, ws } = await makeOpenChannel()
    // Nothing is awaiting a receive*() right now, so these land in the
    // channel's own queue instead of being delivered anywhere.
    const first = new Uint8Array([1, 2, 3])
    const second = new Uint8Array([4, 5, 6])
    ws.fireBinary(first)
    ws.fireBinary(second)

    const { queuedFrames } = channel.release()

    expect(queuedFrames).toEqual([first, second])
  })

  it('throws rather than silently dropping a queued text frame', async () => {
    const { channel, ws } = await makeOpenChannel()
    // A text frame arriving after the channel should already be binary-only
    // is a §6.1 violation in its own right — never a value to hand over.
    ws.fireText('should not still be here')

    expect(() => channel.release()).toThrow(/text frame/i)
  })

  it('does not close the socket', async () => {
    const { channel, ws } = await makeOpenChannel()
    channel.release()
    expect(ws.readyState).toBe(OPEN)
  })

  it('makes a later close() a no-op on the released socket', async () => {
    const { channel, ws } = await makeOpenChannel()
    channel.release()
    channel.close()
    expect(ws.readyState).toBe(OPEN)
  })

  it('throws if called before open()', () => {
    const channel = new WebSocketFrameChannel({
      WebSocketCtor: FakeWebSocket as unknown as typeof WebSocket,
    })
    expect(() => channel.release()).toThrow(/before open/i)
  })

  it('throws if called twice', async () => {
    const { channel } = await makeOpenChannel()
    channel.release()
    expect(() => channel.release()).toThrow(/already released/i)
  })
})
