import { Buffer } from 'node:buffer'
import { EventEmitter } from 'node:events'
import { describe, expect, it, type Mock, vi } from 'vitest'
import type { WebSocketLike } from '../web-socket-message-stream'
import {
  WebSocketMessageReader,
  WebSocketMessageWriter,
} from '../web-socket-message-stream'
import { ProtocolViolationError } from './canonical'
import {
  DIR_C2S,
  DIR_S2C,
  EnvelopeLimitError,
  EnvelopeOpener,
  EnvelopeSealer,
  EnvelopeViolationError,
} from './envelope'
import {
  type EnvelopeStreamFault,
  wrapWithEnvelope,
} from './envelope-message-stream'

const KEY_C2S = new Uint8Array(32).fill(7)
const KEY_S2C = new Uint8Array(32).fill(9)

/**
 * A `ws`-shaped double that carries the `isBinary` flag the real socket
 * supplies. It deliberately emits a `Buffer` for BOTH text and binary frames,
 * exactly as `ws` does in its default `binaryType: 'nodebuffer'` mode — a
 * double that emitted a `string` for text frames would let a wrapper that
 * discriminates on `typeof data` pass while production stays open (§10).
 */
class FakeSocket extends EventEmitter {
  readonly sent: Uint8Array[] = []
  readyState = 1
  closedWith: Array<[number | undefined, string | undefined]> = []

  send(data: string | Uint8Array): void {
    this.sent.push(
      typeof data === 'string' ? Buffer.from(data, 'utf8') : data.slice()
    )
  }

  close(code?: number, reason?: string): void {
    this.closedWith.push([code, reason])
    this.readyState = 3
  }

  /** Deliver a frame the way `ws` does: `(data, isBinary)`. */
  deliverBinary(frame: Uint8Array): void {
    this.emit('message', Buffer.from(frame), true)
  }

  deliverText(text: string): void {
    this.emit('message', Buffer.from(text, 'utf8'), false)
  }

  asLike(): WebSocketLike {
    return this as unknown as WebSocketLike
  }
}

/** The first fault reported, or a loud failure if none was. */
function firstFault(onViolation: Mock): EnvelopeStreamFault {
  const fault = onViolation.mock.calls[0]?.[0]
  if (!fault) {
    throw new Error('onViolation was never called')
  }
  return fault as EnvelopeStreamFault
}

/** The peer's half of the same channel, so a test can seal and open for real. */
function makePeer(startSeqC2S = 0, startSeqS2C = 0) {
  return {
    /** Seals what the client sends to the server. */
    sealer: new EnvelopeSealer(KEY_C2S, DIR_C2S, startSeqC2S),
    /** Opens what the server sends to the client. */
    opener: new EnvelopeOpener(KEY_S2C, DIR_S2C, startSeqS2C),
  }
}

/** The server's half. */
function makeServerChannel(startSeqS2C = 0, startSeqC2S = 0) {
  return {
    sealer: new EnvelopeSealer(KEY_S2C, DIR_S2C, startSeqS2C),
    opener: new EnvelopeOpener(KEY_C2S, DIR_C2S, startSeqC2S),
  }
}

describe('wrapWithEnvelope — inbound', () => {
  it('opens a sealed binary frame and delivers the plaintext to every listener', () => {
    const ws = new FakeSocket()
    const peer = makePeer()
    const wrapped = wrapWithEnvelope(ws.asLike(), makeServerChannel(), vi.fn())

    const first: string[] = []
    const second: string[] = []
    wrapped.on('message', (data) => {
      first.push(data.toString('utf8'))
    })
    wrapped.on('message', (data) => {
      second.push(data.toString('utf8'))
    })

    ws.deliverBinary(peer.sealer.seal(Buffer.from('{"a":1}', 'utf8')))

    expect(first).toEqual(['{"a":1}'])
    expect(second).toEqual(['{"a":1}'])
  })

  it('delivers a value whose toString("utf8") is the plaintext, not comma-joined digits', () => {
    // `WebSocketMessageReader.messageListener` calls `data.toString('utf8')`.
    // A bare `Uint8Array` would answer "123,34,97..." and die at JSON.parse.
    const ws = new FakeSocket()
    const peer = makePeer()
    const wrapped = wrapWithEnvelope(ws.asLike(), makeServerChannel(), vi.fn())
    const reader = new WebSocketMessageReader(wrapped)
    const received: unknown[] = []
    reader.listen((m) => {
      received.push(m)
    })
    const errors: Error[] = []
    reader.onError((e) => {
      errors.push(e)
    })

    ws.deliverBinary(
      peer.sealer.seal(
        Buffer.from(JSON.stringify({ jsonrpc: '2.0', method: 'x' }), 'utf8')
      )
    )

    expect(errors).toEqual([])
    expect(received).toEqual([{ jsonrpc: '2.0', method: 'x' }])
  })

  it('treats a text frame after channel activation as a peer violation and delivers nothing', () => {
    const ws = new FakeSocket()
    const onViolation = vi.fn()
    const wrapped = wrapWithEnvelope(
      ws.asLike(),
      makeServerChannel(),
      onViolation
    )
    const delivered = vi.fn()
    wrapped.on('message', delivered)

    ws.deliverText('{"jsonrpc":"2.0","method":"x"}')

    expect(delivered).not.toHaveBeenCalled()
    expect(onViolation).toHaveBeenCalledTimes(1)
    const fault = firstFault(onViolation)
    expect(fault.kind).toBe('peer-violation')
    expect(fault.cause).toBeInstanceOf(EnvelopeViolationError)
  })

  it('refuses a well-formed envelope that arrives flagged as text', () => {
    // The sharp form of the case above, and the one that survives a wrapper
    // discriminating on `typeof data`: the payload WOULD open cleanly, so only
    // reading `isBinary` can refuse it. Under `binaryType: 'nodebuffer'` a real
    // `ws` hands both frame types over as a `Buffer`, so a `typeof` check would
    // accept injected plaintext as an authenticated envelope (§10).
    const ws = new FakeSocket()
    const peer = makePeer()
    const onViolation = vi.fn()
    const wrapped = wrapWithEnvelope(
      ws.asLike(),
      makeServerChannel(),
      onViolation
    )
    const delivered = vi.fn()
    wrapped.on('message', delivered)

    const sealed = peer.sealer.seal(Buffer.from('{"a":1}', 'utf8'))
    ws.emit('message', Buffer.from(sealed), false)

    expect(delivered).not.toHaveBeenCalled()
    expect(onViolation).toHaveBeenCalledTimes(1)
    expect(firstFault(onViolation).cause.message).toMatch(/text frame/)
  })

  it('refuses a frame that arrives with no binary flag at all', () => {
    const ws = new FakeSocket()
    const peer = makePeer()
    const onViolation = vi.fn()
    const wrapped = wrapWithEnvelope(
      ws.asLike(),
      makeServerChannel(),
      onViolation
    )
    const delivered = vi.fn()
    wrapped.on('message', delivered)

    ws.emit('message', Buffer.from(peer.sealer.seal(Buffer.from('x', 'utf8'))))

    expect(delivered).not.toHaveBeenCalled()
    expect(onViolation).toHaveBeenCalledTimes(1)
  })

  it('treats a tampered frame as a peer violation and delivers nothing', () => {
    const ws = new FakeSocket()
    const peer = makePeer()
    const onViolation = vi.fn()
    const wrapped = wrapWithEnvelope(
      ws.asLike(),
      makeServerChannel(),
      onViolation
    )
    const delivered = vi.fn()
    wrapped.on('message', delivered)

    const frame = peer.sealer.seal(Buffer.from('{"a":1}', 'utf8'))
    frame[frame.length - 1] ^= 0xff

    ws.deliverBinary(frame)

    expect(delivered).not.toHaveBeenCalled()
    expect(onViolation).toHaveBeenCalledTimes(1)
    expect(firstFault(onViolation).kind).toBe('peer-violation')
  })

  it('treats a replayed frame as a violation (strict sequence, no window)', () => {
    const ws = new FakeSocket()
    const peer = makePeer()
    const onViolation = vi.fn()
    const wrapped = wrapWithEnvelope(
      ws.asLike(),
      makeServerChannel(),
      onViolation
    )
    const delivered = vi.fn()
    wrapped.on('message', delivered)

    const frame = peer.sealer.seal(Buffer.from('{"a":1}', 'utf8'))
    ws.deliverBinary(frame)
    ws.deliverBinary(frame)

    expect(delivered).toHaveBeenCalledTimes(1)
    expect(onViolation).toHaveBeenCalledTimes(1)
  })

  it('resumes from constructor-injected sequence state rather than a test back door', () => {
    const ws = new FakeSocket()
    // Both halves resume at c2s seq 5 — the shape a handover mid-stream has.
    const peer = makePeer(5)
    const onViolation = vi.fn()
    const wrapped = wrapWithEnvelope(
      ws.asLike(),
      makeServerChannel(0, 5),
      onViolation
    )
    const received: string[] = []
    wrapped.on('message', (data) => {
      received.push(data.toString('utf8'))
    })

    ws.deliverBinary(peer.sealer.seal(Buffer.from('resumed', 'utf8')))

    expect(onViolation).not.toHaveBeenCalled()
    expect(received).toEqual(['resumed'])
  })

  it('reports an internal opener fault as NOT the peer, with the original cause attached', () => {
    // The bug class this guards: an implementation TypeError reported as "GCM
    // authentication failed", which reads as a wire attack during debugging.
    const ws = new FakeSocket()
    const boom = new TypeError('opener is broken')
    const brokenOpener = {
      open(): Uint8Array {
        throw boom
      },
    } as unknown as EnvelopeOpener
    const onViolation = vi.fn()
    const wrapped = wrapWithEnvelope(
      ws.asLike(),
      { sealer: new EnvelopeSealer(KEY_S2C, DIR_S2C), opener: brokenOpener },
      onViolation
    )
    const delivered = vi.fn()
    wrapped.on('message', delivered)

    ws.deliverBinary(new Uint8Array(32))

    expect(delivered).not.toHaveBeenCalled()
    const fault = firstFault(onViolation)
    expect(fault.kind).toBe('internal')
    expect(fault.cause.cause).toBe(boom)
  })

  it('reports a ProtocolViolationError from the opener as a peer violation', () => {
    const ws = new FakeSocket()
    const brokenOpener = {
      open(): Uint8Array {
        throw new ProtocolViolationError('non-canonical')
      },
    } as unknown as EnvelopeOpener
    const onViolation = vi.fn()
    const wrapped = wrapWithEnvelope(
      ws.asLike(),
      { sealer: new EnvelopeSealer(KEY_S2C, DIR_S2C), opener: brokenOpener },
      onViolation
    )
    wrapped.on('message', vi.fn())

    ws.deliverBinary(new Uint8Array(32))

    expect(firstFault(onViolation).kind).toBe('peer-violation')
  })

  it('reports an inbound EnvelopeLimitError as a usage-limit closure, not a peer violation or internal fault', () => {
    // The opener's frame-count check reads only its own counter, before the
    // frame is even parsed, so an arbitrary length-valid buffer trips it
    // without needing real encryption (mirrors envelope.test.ts).
    const ws = new FakeSocket()
    const onViolation = vi.fn()
    const wrapped = wrapWithEnvelope(
      ws.asLike(),
      {
        sealer: new EnvelopeSealer(KEY_S2C, DIR_S2C),
        opener: new EnvelopeOpener(KEY_C2S, DIR_C2S, 2 ** 24),
      },
      onViolation
    )
    const delivered = vi.fn()
    wrapped.on('message', delivered)

    ws.deliverBinary(new Uint8Array(8 + 16))

    expect(delivered).not.toHaveBeenCalled()
    expect(onViolation).toHaveBeenCalledTimes(1)
    const fault = firstFault(onViolation)
    expect(fault.kind).toBe('usage-limit')
    expect(fault.cause).toBeInstanceOf(EnvelopeLimitError)
  })
})

describe('wrapWithEnvelope — outbound', () => {
  it('seals a written string into a binary frame the peer opener round-trips', () => {
    const ws = new FakeSocket()
    const peer = makePeer()
    const wrapped = wrapWithEnvelope(ws.asLike(), makeServerChannel(), vi.fn())

    wrapped.send('{"a":1}')

    expect(ws.sent).toHaveLength(1)
    const frame = ws.sent[0]
    if (!frame) throw new Error('no frame sent')
    expect(Buffer.from(peer.opener.open(frame)).toString('utf8')).toBe(
      '{"a":1}'
    )
  })

  it('carries the handed-over sealer, so the first post-handover frame continues its sequence', () => {
    // Pair hands over a sealer that already sent `credentialCommitted`: the
    // next server frame must be seq 1, not a fresh 0 (§10).
    const ws = new FakeSocket()
    const peer = makePeer(0, 1)
    const wrapped = wrapWithEnvelope(ws.asLike(), makeServerChannel(1), vi.fn())

    wrapped.send('post-handover')

    const frame = ws.sent[0]
    if (!frame) throw new Error('no frame sent')
    expect(Buffer.from(frame.subarray(0, 8)).toString('hex')).toBe(
      '0000000000000001'
    )
    expect(Buffer.from(peer.opener.open(frame)).toString('utf8')).toBe(
      'post-handover'
    )
  })

  it('exposes the §10 outbound usage counters', () => {
    const ws = new FakeSocket()
    const wrapped = wrapWithEnvelope(ws.asLike(), makeServerChannel(), vi.fn())

    expect(wrapped.usage).toEqual({ frames: 0, blocks: 0 })
    wrapped.send('0123456789abcdef0123')
    expect(wrapped.usage).toEqual({ frames: 1, blocks: 2 })
  })

  it('reports an outbound EnvelopeLimitError as a usage-limit closure, and still throws to the caller', () => {
    // A sealer already AT the frame-count bound: the very next seal() throws.
    const ws = new FakeSocket()
    const onViolation = vi.fn()
    const channel = {
      sealer: new EnvelopeSealer(KEY_S2C, DIR_S2C, 2 ** 24),
      opener: new EnvelopeOpener(KEY_C2S, DIR_C2S),
    }
    const wrapped = wrapWithEnvelope(ws.asLike(), channel, onViolation)

    expect(() => wrapped.send('{"a":1}')).toThrow(EnvelopeLimitError)

    expect(ws.sent).toHaveLength(0)
    expect(onViolation).toHaveBeenCalledTimes(1)
    const fault = firstFault(onViolation)
    expect(fault.kind).toBe('usage-limit')
    expect(fault.cause).toBeInstanceOf(EnvelopeLimitError)
  })

  it('reports an oversized outbound plaintext as an internal fault', () => {
    // `EnvelopeViolationError` from outbound `seal()` is this process's own
    // §10 mistake, never the peer's. Leaving the socket alive after refusing
    // an application frame can desynchronize higher-level request state, so
    // the transport fails closed and lets the server map this to 1011.
    const ws = new FakeSocket()
    const onViolation = vi.fn()
    const wrapped = wrapWithEnvelope(
      ws.asLike(),
      makeServerChannel(),
      onViolation
    )

    expect(() => wrapped.send(new Uint8Array(1024 * 1024 + 1))).toThrow(
      EnvelopeViolationError
    )

    expect(ws.sent).toHaveLength(0)
    expect(onViolation).toHaveBeenCalledTimes(1)
    const fault = firstFault(onViolation)
    expect(fault.kind).toBe('internal')
    expect(fault.cause).toBeInstanceOf(EnvelopeViolationError)
  })

  it('does not advance channel counters before reporting an oversized write', () => {
    const ws = new FakeSocket()
    const wrapped = wrapWithEnvelope(ws.asLike(), makeServerChannel(), vi.fn())

    expect(() => wrapped.send(new Uint8Array(1024 * 1024 + 1))).toThrow(
      EnvelopeViolationError
    )

    expect(wrapped.usage).toEqual({ frames: 0, blocks: 0 })
    expect(ws.sent).toHaveLength(0)
  })

  it('reports an unexpected broken sealer as an internal fault', () => {
    const ws = new FakeSocket()
    const boom = new TypeError('sealer is broken')
    const brokenSealer = {
      seal(): Uint8Array {
        throw boom
      },
    } as unknown as EnvelopeSealer
    const onViolation = vi.fn()
    const wrapped = wrapWithEnvelope(
      ws.asLike(),
      { sealer: brokenSealer, opener: new EnvelopeOpener(KEY_C2S, DIR_C2S) },
      onViolation
    )

    expect(() => wrapped.send('{"a":1}')).toThrow(boom)

    expect(ws.sent).toHaveLength(0)
    expect(onViolation).toHaveBeenCalledTimes(1)
    expect(firstFault(onViolation)).toEqual({ kind: 'internal', cause: boom })
  })
})

describe('wrapWithEnvelope — socket surface', () => {
  it('reads readyState live rather than copying it at wrap time', () => {
    const ws = new FakeSocket()
    const wrapped = wrapWithEnvelope(ws.asLike(), makeServerChannel(), vi.fn())

    expect(wrapped.readyState).toBe(1)
    ws.readyState = 3
    expect(wrapped.readyState).toBe(3)
  })

  it('closes with no arguments, as MessageWriter.end() calls it', () => {
    const ws = new FakeSocket()
    const wrapped = wrapWithEnvelope(ws.asLike(), makeServerChannel(), vi.fn())
    const writer = new WebSocketMessageWriter(wrapped)

    writer.end()

    expect(ws.closedWith).toEqual([[undefined, undefined]])
  })

  it('removes a message listener by identity and leaves the others attached', () => {
    const ws = new FakeSocket()
    const peer = makePeer()
    const wrapped = wrapWithEnvelope(ws.asLike(), makeServerChannel(), vi.fn())
    const kept = vi.fn()
    const removed = vi.fn()
    wrapped.on('message', kept)
    wrapped.on('message', removed)

    wrapped.off('message', removed)
    ws.deliverBinary(peer.sealer.seal(Buffer.from('x', 'utf8')))

    expect(kept).toHaveBeenCalledTimes(1)
    expect(removed).not.toHaveBeenCalled()
  })

  it('detaches from the raw socket once its last message listener is removed', () => {
    const ws = new FakeSocket()
    const wrapped = wrapWithEnvelope(ws.asLike(), makeServerChannel(), vi.fn())
    const listener = vi.fn()

    wrapped.on('message', listener)
    expect(ws.listenerCount('message')).toBe(1)
    wrapped.off('message', listener)
    expect(ws.listenerCount('message')).toBe(0)
  })

  it('supports the two close listeners the reader and writer each register', () => {
    const ws = new FakeSocket()
    const wrapped = wrapWithEnvelope(ws.asLike(), makeServerChannel(), vi.fn())
    const reader = new WebSocketMessageReader(wrapped)
    const writer = new WebSocketMessageWriter(wrapped)
    const readerClosed = vi.fn()
    const writerClosed = vi.fn()
    reader.listen(vi.fn())
    reader.onClose(readerClosed)
    writer.onClose(writerClosed)

    ws.emit('close')

    expect(readerClosed).toHaveBeenCalledTimes(1)
    expect(writerClosed).toHaveBeenCalledTimes(1)

    reader.dispose()
    writer.dispose()
    ws.emit('close')
    expect(readerClosed).toHaveBeenCalledTimes(1)
    expect(writerClosed).toHaveBeenCalledTimes(1)
  })

  it('passes error events through to their listener', () => {
    const ws = new FakeSocket()
    // EventEmitter rethrows an 'error' with no listener, which would mask the
    // assertion below once `off` has removed ours.
    ws.on('error', () => {})
    const wrapped = wrapWithEnvelope(ws.asLike(), makeServerChannel(), vi.fn())
    const onError = vi.fn()
    wrapped.on('error', onError)

    const err = new Error('socket blew up')
    ws.emit('error', err)

    expect(onError).toHaveBeenCalledWith(err)
    wrapped.off('error', onError)
    ws.emit('error', err)
    expect(onError).toHaveBeenCalledTimes(1)
  })
})
