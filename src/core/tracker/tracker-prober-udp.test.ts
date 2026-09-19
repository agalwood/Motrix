// @vitest-environment node
import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { createSocket } = vi.hoisted(() => ({ createSocket: vi.fn() }))
vi.mock('node:dgram', () => ({ createSocket }))

import { TrackerProber } from './tracker-prober'

class FakeSocket extends EventEmitter {
  closed = false
  sendCallback: ((error: Error | null) => void) | undefined
  send = vi.fn(
    (
      _buffer: Buffer,
      _offset: number,
      _length: number,
      _port: number,
      _host: string,
      callback: (error: Error | null) => void
    ) => {
      this.sendCallback = callback
    }
  )
  close = vi.fn(() => {
    if (this.closed) {
      throw Object.assign(new Error('Not running'), {
        code: 'ERR_SOCKET_DGRAM_NOT_RUNNING',
      })
    }
    this.closed = true
    queueMicrotask(() => this.emit('close'))
  })
}

describe('TrackerProber UDP lifecycle', () => {
  let socket: FakeSocket
  let prober: TrackerProber

  beforeEach(() => {
    vi.useFakeTimers()
    socket = new FakeSocket()
    createSocket.mockReset().mockReturnValue(socket)
    prober = new TrackerProber()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  async function startProbe() {
    const result = prober.probe(['udp://tracker.example:6969/announce'], {
      timeoutMs: 100,
    })
    await vi.waitFor(() => expect(socket.send).toHaveBeenCalledOnce())
    return { result }
  }

  it('does not close twice when a send error arrives after timeout', async () => {
    const { result } = await startProbe()
    await vi.advanceTimersByTimeAsync(100)
    expect((await result)[0].status).toBe('unreachable')

    expect(() =>
      socket.sendCallback?.(new Error('network changed'))
    ).not.toThrow()
    expect(socket.close).toHaveBeenCalledOnce()
  })

  it('ignores late send success and replies after timeout', async () => {
    const { result } = await startProbe()
    await vi.advanceTimersByTimeAsync(100)
    socket.sendCallback?.(null)

    expect(() => socket.emit('message', Buffer.alloc(16))).not.toThrow()
    expect((await result)[0].status).toBe('unreachable')
    expect(socket.close).toHaveBeenCalledOnce()
    expect(socket.listenerCount('message')).toBe(0)
  })

  it('closes a successful probe once and clears its deadline', async () => {
    const { result } = await startProbe()
    socket.sendCallback?.(null)
    socket.emit('message', Buffer.alloc(16))

    expect((await result)[0].status).toBe('healthy')
    await vi.advanceTimersByTimeAsync(100)
    expect(socket.close).toHaveBeenCalledOnce()
    expect(socket.listenerCount('message')).toBe(0)
  })

  it('handles a reply before the send callback completes', async () => {
    const { result } = await startProbe()
    socket.emit('message', Buffer.alloc(16))
    expect((await result)[0].status).toBe('healthy')
    expect(() =>
      socket.sendCallback?.(new Error('late send error'))
    ).not.toThrow()
    expect(socket.close).toHaveBeenCalledOnce()
  })

  it('turns socket errors into an unreachable result and tolerates errors during close', async () => {
    const { result } = await startProbe()
    expect(() => socket.emit('error', new Error('network down'))).not.toThrow()
    expect(() => socket.emit('error', new Error('closing'))).not.toThrow()
    expect((await result)[0].status).toBe('unreachable')
    await vi.advanceTimersByTimeAsync(100)
    expect(socket.close).toHaveBeenCalledOnce()
    expect(socket.listenerCount('message')).toBe(0)
    expect(socket.listenerCount('error')).toBe(0)
  })

  it('clears the deadline after an immediate send error', async () => {
    const { result } = await startProbe()
    socket.sendCallback?.(new Error('DNS failed'))
    expect((await result)[0].status).toBe('unreachable')
    await vi.advanceTimersByTimeAsync(100)
    expect(socket.close).toHaveBeenCalledOnce()
  })

  it('settles synchronous send failures and clears the deadline', async () => {
    socket.send.mockImplementationOnce(() => {
      throw new Error('invalid port')
    })
    const { result } = await startProbe()
    expect((await result)[0].status).toBe('unreachable')
    await vi.advanceTimersByTimeAsync(100)
    expect(socket.close).toHaveBeenCalledOnce()
  })

  it('settles malformed UDP URLs without creating a socket', async () => {
    const result = await prober.probe(['udp://[invalid'], { timeoutMs: 100 })
    expect(result[0].status).toBe('unreachable')
    expect(createSocket).not.toHaveBeenCalled()
  })

  it('settles socket creation failures', async () => {
    createSocket.mockImplementationOnce(() => {
      throw new Error('no socket handles available')
    })
    const result = await prober.probe(['udp://tracker.example:6969'], {
      timeoutMs: 100,
    })
    expect(result[0].status).toBe('unreachable')
  })

  it('tolerates cleanup when the native socket has already closed', async () => {
    const { result } = await startProbe()
    socket.closed = true
    expect(() =>
      socket.sendCallback?.(new Error('network changed'))
    ).not.toThrow()
    expect((await result)[0].status).toBe('unreachable')
    await vi.advanceTimersByTimeAsync(100)
    expect(socket.close).toHaveBeenCalledOnce()
  })

  it('contains unexpected close failures within the probe result', async () => {
    const { result } = await startProbe()
    socket.close.mockImplementationOnce(() => {
      throw new Error('unexpected close failure')
    })
    expect(() => socket.emit('message', Buffer.alloc(16))).not.toThrow()
    expect((await result)[0].status).toBe('unreachable')
    await vi.advanceTimersByTimeAsync(100)
    expect(socket.close).toHaveBeenCalledOnce()
  })
})
