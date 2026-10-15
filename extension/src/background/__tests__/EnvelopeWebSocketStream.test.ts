import { describe, expect, it, vi } from 'vitest'
import type { Message } from 'vscode-jsonrpc'
import {
  EnvelopeMessageReader,
  EnvelopeMessageWriter,
} from '@/background/EnvelopeWebSocketStream'
import { MBP1_VECTORS } from '@/background/mbp1/__fixtures__/vectors'
import { EnvelopeCodec, EnvelopeViolation } from '@/background/mbp1/envelope'

const H = (s: string) => Uint8Array.from(Buffer.from(s, 'hex'))
const { inputs } = MBP1_VECTORS.envelope

const OPEN = 1
const CLOSED = 3

class FakeWebSocket extends EventTarget {
  readonly sent: Uint8Array[] = []
  readyState = OPEN
  /** The close code of the first close() call, mirroring what hits the wire. */
  closeCode: number | undefined

  send(data: Uint8Array): void {
    if (this.readyState !== OPEN) throw new Error('cannot send: not open')
    this.sent.push(data)
  }

  close(code?: number): void {
    // Mirror the browser's own guard: a code outside 1000/3000–4999 throws
    // before anything is sent, so a production regression to 1002/1011 fails
    // loudly here instead of only in a real browser.
    if (code !== undefined && code !== 1000 && (code < 3000 || code > 4999)) {
      throw new DOMException('invalid close code', 'InvalidAccessError')
    }
    if (this.readyState === CLOSED) return
    this.readyState = CLOSED
    this.closeCode = code
    this.dispatchEvent(new Event('close'))
  }

  fireBinary(bytes: Uint8Array): void {
    const buf = bytes.buffer.slice(
      bytes.byteOffset,
      bytes.byteOffset + bytes.byteLength
    )
    this.dispatchEvent(new MessageEvent('message', { data: buf }))
  }

  fireText(text: string): void {
    this.dispatchEvent(new MessageEvent('message', { data: text }))
  }
}

async function makeCodecPair(): Promise<{
  client: EnvelopeCodec
  server: EnvelopeCodec
}> {
  const keyC2S = H(inputs.keyC2S)
  const keyS2C = H(inputs.keyS2C)
  return {
    client: await EnvelopeCodec.create(keyC2S, keyS2C, 'client'),
    server: await EnvelopeCodec.create(keyC2S, keyS2C, 'server'),
  }
}

describe('EnvelopeMessageWriter', () => {
  it('seals and sends a message a matching server codec can open', async () => {
    const { client, server } = await makeCodecPair()
    const ws = new FakeWebSocket()
    const writer = new EnvelopeMessageWriter(ws as unknown as WebSocket, client)

    const msg = {
      jsonrpc: '2.0',
      method: 'motrix/initialize',
      id: 1,
    } as Message
    await writer.write(msg)

    expect(ws.sent).toHaveLength(1)
    const opened = await server.open(ws.sent[0] as Uint8Array)
    expect(JSON.parse(new TextDecoder().decode(opened))).toEqual(msg)
  })

  it('rejects when the socket is not open', async () => {
    const { client } = await makeCodecPair()
    const ws = new FakeWebSocket()
    ws.readyState = CLOSED
    const writer = new EnvelopeMessageWriter(ws as unknown as WebSocket, client)

    await expect(
      writer.write({ jsonrpc: '2.0', method: 'x' } as Message)
    ).rejects.toThrow(/closed/i)
  })

  it('serializes concurrent writes so the sequence never corrupts', async () => {
    // The correctness property this whole module exists for: seal() reads
    // its seq counter, awaits WebCrypto, THEN increments — two overlapping
    // calls would both read seq 0 and produce two frames claiming it. Firing
    // writes without awaiting between them is exactly the race that would
    // expose that bug if the operation queue were removed.
    const { client, server } = await makeCodecPair()
    const ws = new FakeWebSocket()
    const writer = new EnvelopeMessageWriter(ws as unknown as WebSocket, client)

    const messages = Array.from({ length: 8 }, (_, i) => ({
      jsonrpc: '2.0' as const,
      method: `m${i}`,
      id: i,
    }))
    await Promise.all(messages.map((m) => writer.write(m as Message)))

    expect(ws.sent).toHaveLength(8)
    // Opening in send order must succeed for every frame — a corrupted
    // sequence would throw `sequenceMismatch` partway through.
    for (let i = 0; i < 8; i++) {
      const opened = await server.open(ws.sent[i] as Uint8Array)
      expect(JSON.parse(new TextDecoder().decode(opened))).toEqual(messages[i])
    }
  })

  it('fires onError and closes the socket on a seal-side EnvelopeViolation', async () => {
    const { client } = await makeCodecPair()
    const ws = new FakeWebSocket()
    const writer = new EnvelopeMessageWriter(ws as unknown as WebSocket, client)
    const errors: unknown[] = []
    writer.onError((e) => errors.push(e))

    // Force an oversizePlaintext EnvelopeViolation: the params string alone
    // exceeds the 1 MiB cap once JSON-stringified.
    const oversized = 'x'.repeat(2 * 1024 * 1024)
    await expect(
      writer.write({
        jsonrpc: '2.0',
        method: 'x',
        params: { oversized },
      } as unknown as Message)
    ).rejects.toThrow()

    expect(errors).toHaveLength(1)
    expect(ws.readyState).toBe(CLOSED)
    // Its own fault (would be §11's 1011), but a browser cannot send 1011.
    expect(ws.closeCode).toBeUndefined()
  })

  it('closes with 4001 when its own outbound key reaches the §10 usage bound', async () => {
    const exhausted = {
      seal: async () => {
        throw new EnvelopeViolation('usageBoundExceeded', 'outbound bound')
      },
    } as unknown as EnvelopeCodec
    const ws = new FakeWebSocket()
    const writer = new EnvelopeMessageWriter(
      ws as unknown as WebSocket,
      exhausted
    )

    await expect(
      writer.write({ jsonrpc: '2.0', method: 'x' } as Message)
    ).rejects.toThrow()

    expect(ws.readyState).toBe(CLOSED)
    expect(ws.closeCode).toBe(4001)
  })

  it('dispose() removes the close listener', () => {
    const client = {} as EnvelopeCodec
    const ws = new FakeWebSocket()
    const writer = new EnvelopeMessageWriter(ws as unknown as WebSocket, client)
    const cb = vi.fn()
    writer.onClose(cb)
    writer.dispose()
    ws.close()
    expect(cb).not.toHaveBeenCalled()
  })
})

describe('EnvelopeMessageReader', () => {
  it('opens a binary frame and delivers the parsed message', async () => {
    const { client, server } = await makeCodecPair()
    const ws = new FakeWebSocket()
    const reader = new EnvelopeMessageReader(ws as unknown as WebSocket, client)
    const received: Message[] = []
    reader.listen((m) => received.push(m))

    const msg = { jsonrpc: '2.0', method: 'motrix/initialized' } as Message
    const sealed = await server.seal(
      new TextEncoder().encode(JSON.stringify(msg))
    )
    ws.fireBinary(sealed)
    // The open() happens inside an internally-enqueued microtask chain.
    await vi.waitFor(() => expect(received).toHaveLength(1))
    expect(received[0]).toEqual(msg)
  })

  it('delivers frames in order even when they arrive back to back', async () => {
    const { client, server } = await makeCodecPair()
    const ws = new FakeWebSocket()
    const reader = new EnvelopeMessageReader(ws as unknown as WebSocket, client)
    const received: Message[] = []
    reader.listen((m) => received.push(m))

    const messages = Array.from({ length: 6 }, (_, i) => ({
      jsonrpc: '2.0' as const,
      method: `m${i}`,
    }))
    for (const m of messages) {
      const sealed = await server.seal(
        new TextEncoder().encode(JSON.stringify(m))
      )
      ws.fireBinary(sealed)
    }

    await vi.waitFor(() => expect(received).toHaveLength(6))
    expect(received).toEqual(messages)
  })

  it('fires onError and closes the socket on a gcm auth failure', async () => {
    const { client, server } = await makeCodecPair()
    const ws = new FakeWebSocket()
    const reader = new EnvelopeMessageReader(ws as unknown as WebSocket, client)
    reader.listen(() => {})
    const errors: Error[] = []
    reader.onError((e) => errors.push(e))

    const sealed = await server.seal(new TextEncoder().encode('{}'))
    sealed[sealed.length - 1] = (sealed[sealed.length - 1] ?? 0) ^ 0xff // corrupt the GCM tag
    ws.fireBinary(sealed)

    await vi.waitFor(() => expect(errors).toHaveLength(1))
    expect(errors[0]?.message).toMatch(/envelope open failed/i)
    expect(ws.readyState).toBe(CLOSED)
    // A browser cannot send §11's 1002 — the WebSocket API only allows
    // 1000/3000–4999 — so a peer violation closes bare.
    expect(ws.closeCode).toBeUndefined()
  })

  it('fires onError and closes the socket on a non-binary (text) frame', async () => {
    const client = {} as EnvelopeCodec
    const ws = new FakeWebSocket()
    const reader = new EnvelopeMessageReader(ws as unknown as WebSocket, client)
    reader.listen(() => {})
    const errors: Error[] = []
    reader.onError((e) => errors.push(e))

    ws.fireText('not binary')

    expect(errors).toHaveLength(1)
    expect(errors[0]?.message).toMatch(/unsupported/i)
    // §10: a text frame after channel activation is a protocol violation and
    // MUST close the connection — bare, since a browser cannot send 1002.
    expect(ws.readyState).toBe(CLOSED)
    expect(ws.closeCode).toBeUndefined()
  })

  it('closes with 4001 when the inbound key reaches its §10 usage bound', async () => {
    const exhausted = {
      open: async () => {
        throw new EnvelopeViolation('usageBoundExceeded', 'inbound bound')
      },
    } as unknown as EnvelopeCodec
    const ws = new FakeWebSocket()
    const reader = new EnvelopeMessageReader(
      ws as unknown as WebSocket,
      exhausted
    )
    reader.listen(() => {})
    const errors: Error[] = []
    reader.onError((e) => errors.push(e))

    ws.fireBinary(new Uint8Array(16))

    await vi.waitFor(() => expect(errors).toHaveLength(1))
    expect(ws.readyState).toBe(CLOSED)
    // 4001 is the one §11 code inside the range a browser may send: a §10
    // usage bound, nobody's fault, remedy is a §8 reconnect with fresh keys.
    expect(ws.closeCode).toBe(4001)
  })

  it('fires onClose when the socket closes', () => {
    const client = {} as EnvelopeCodec
    const ws = new FakeWebSocket()
    const reader = new EnvelopeMessageReader(ws as unknown as WebSocket, client)
    const cb = vi.fn()
    reader.onClose(cb)
    reader.listen(() => {})
    ws.close()
    expect(cb).toHaveBeenCalled()
  })

  it('dispose() removes event listeners', async () => {
    const { client, server } = await makeCodecPair()
    const ws = new FakeWebSocket()
    const reader = new EnvelopeMessageReader(ws as unknown as WebSocket, client)
    const cb = vi.fn()
    reader.listen(cb)
    reader.dispose()

    const sealed = await server.seal(new TextEncoder().encode('{}'))
    ws.fireBinary(sealed)
    await new Promise((r) => setTimeout(r, 10))
    expect(cb).not.toHaveBeenCalled()
  })

  it('drains preQueuedFrames, in order, before any new inbound frame', async () => {
    // Simulates WebSocketFrameChannel.release()'s handover: frames that
    // arrived before this reader ever attached its own listener.
    const { client, server } = await makeCodecPair()
    const ws = new FakeWebSocket()
    // Sealed one at a time, not via Promise.all — EnvelopeCodec.seal()'s own
    // sequence counter isn't self-serializing (see this module's doc on why
    // that's the reader/writer's job), so concurrent calls would race on it.
    const queued: Uint8Array[] = []
    for (const method of ['queued-0', 'queued-1']) {
      queued.push(
        await server.seal(
          new TextEncoder().encode(JSON.stringify({ jsonrpc: '2.0', method }))
        )
      )
    }
    const reader = new EnvelopeMessageReader(
      ws as unknown as WebSocket,
      client,
      queued
    )
    const received: Message[] = []
    reader.listen((m) => received.push(m))

    // A "live" frame arrives right after listen() — must land after both
    // queued ones, not desync the sequence counter by skipping ahead of them.
    const live = await server.seal(
      new TextEncoder().encode(
        JSON.stringify({ jsonrpc: '2.0', method: 'live' })
      )
    )
    ws.fireBinary(live)

    await vi.waitFor(() => expect(received).toHaveLength(3))
    expect(received.map((m) => (m as { method: string }).method)).toEqual([
      'queued-0',
      'queued-1',
      'live',
    ])
  })

  it('opens and buffers a frame that arrives before listen(), delivering it in order once listen() runs', async () => {
    // The exact gap ConnectionManager's `gate.pausePending()` (a real
    // storage.local.set) sits inside on the first-pair path: the reader
    // already exists (constructed at the top of `finishMbp1Connection`) but
    // `listen()` has not run yet (it runs from inside `doInitialize`).
    const { client, server } = await makeCodecPair()
    const ws = new FakeWebSocket()
    const reader = new EnvelopeMessageReader(ws as unknown as WebSocket, client)

    const early = await server.seal(
      new TextEncoder().encode(
        JSON.stringify({ jsonrpc: '2.0', method: 'early' })
      )
    )
    ws.fireBinary(early)
    // Prove opening does not wait for listen() either — otherwise the §10
    // sequence counter would desync the moment a later frame ran ahead of
    // this one still sitting unopened on the wire.
    await new Promise((r) => setTimeout(r, 10))

    const received: Message[] = []
    reader.listen((m) => received.push(m))

    const live = await server.seal(
      new TextEncoder().encode(
        JSON.stringify({ jsonrpc: '2.0', method: 'live' })
      )
    )
    ws.fireBinary(live)

    await vi.waitFor(() => expect(received).toHaveLength(2))
    expect(received.map((m) => (m as { method: string }).method)).toEqual([
      'early',
      'live',
    ])
  })

  it('throws if listen() is called twice', () => {
    const client = {} as EnvelopeCodec
    const ws = new FakeWebSocket()
    const reader = new EnvelopeMessageReader(ws as unknown as WebSocket, client)
    reader.listen(() => {})
    expect(() => reader.listen(() => {})).toThrow(/already listening/i)
  })
})
