import { afterEach, describe, expect, it, vi } from 'vitest'
import { WebSocketClient } from '@/background/WebSocketClient'

class FakeWebSocket extends EventTarget {
  public readyState = 0 // CONNECTING
  public sent: string[] = []
  public url: string
  public protocols: string | string[] | undefined
  constructor(url: string, protocols?: string | string[]) {
    super()
    this.url = url
    this.protocols = protocols
    setTimeout(() => {
      this.readyState = 1
      this.dispatchEvent(new Event('open'))
    }, 1)
  }
  send(d: string): void {
    this.sent.push(d)
  }
  close(): void {
    this.readyState = 3
    this.dispatchEvent(new Event('close'))
  }
}

class ErrorWebSocket extends EventTarget {
  readyState = 0
  constructor(_url: string, _protocols?: string | string[]) {
    super()
    setTimeout(() => this.dispatchEvent(new Event('error')), 1)
  }
  send(): void {}
  close(): void {}
}

/** Socket whose close event is controlled independently from close(). This
 * models the browser delivering A's queued close after B is already open. */
class DelayedCloseWebSocket extends EventTarget {
  static instances: DelayedCloseWebSocket[] = []

  public readyState = 0
  public sent: string[] = []

  constructor(
    public readonly url: string,
    public readonly protocols?: string | string[]
  ) {
    super()
    DelayedCloseWebSocket.instances.push(this)
  }

  open(): void {
    this.readyState = 1
    this.dispatchEvent(new Event('open'))
  }

  send(data: string): void {
    this.sent.push(data)
  }

  close(): void {
    this.readyState = 2
  }

  emitClose(): void {
    this.readyState = 3
    this.dispatchEvent(new Event('close'))
  }
}

afterEach(() => {
  vi.useRealTimers()
})

describe('WebSocketClient', () => {
  it('connect() returns an MdxpConnection on open', async () => {
    const client = new WebSocketClient({
      WebSocketCtor: FakeWebSocket as never,
    })
    const conn = await client.connect(
      'ws://localhost:12345/v1?token=tok',
      'motrix-bridge.v1'
    )
    expect(conn).toBeDefined()
    expect(typeof conn.sendRequest).toBe('function')
  })

  it('rejects if ws emits error before open', async () => {
    const client = new WebSocketClient({
      WebSocketCtor: ErrorWebSocket as never,
    })
    await expect(client.connect('ws://x', 'p')).rejects.toThrow()
  })

  it('times out a half-open socket, closes it, and leaves the client reusable', async () => {
    vi.useFakeTimers()
    const sockets: Array<DelayedCloseWebSocket> = []
    class ControlledWebSocket extends DelayedCloseWebSocket {
      constructor(url: string, protocols?: string | string[]) {
        super(url, protocols)
        sockets.push(this)
      }
    }
    const client = new WebSocketClient({
      WebSocketCtor: ControlledWebSocket as never,
      openTimeoutMs: 25,
    })

    const first = client.connect('ws://hung', 'p')
    const rejected = expect(first).rejects.toThrow(/open timed out after 25ms/i)
    await vi.advanceTimersByTimeAsync(25)
    await rejected
    expect(sockets[0].readyState).toBe(2)
    expect(client.getConnection()).toBeNull()

    const second = client.connect('ws://healthy', 'p')
    sockets[1].open()
    await expect(second).resolves.toBeDefined()
  })

  it('close() closes the underlying socket and fires onClose', async () => {
    const client = new WebSocketClient({
      WebSocketCtor: FakeWebSocket as never,
    })
    await client.connect('ws://x', 'p')
    const onClose = vi.fn()
    client.onClose(onClose)
    client.close()
    expect(onClose).toHaveBeenCalled()
  })

  it('throws on duplicate connect()', async () => {
    const client = new WebSocketClient({
      WebSocketCtor: FakeWebSocket as never,
    })
    await client.connect('ws://x', 'p')
    await expect(client.connect('ws://y', 'p')).rejects.toThrow(
      /already connected/i
    )
  })

  it('close() clears registered close callbacks so reconnect cycles do not leak', async () => {
    // Regression: each connect() registered a new onClose callback, and
    // close() didn't drain the array — so after N reconnect cycles a
    // single WS drop fanned out to N synchronous handleClose calls
    // (N-1 hitting the state guard and no-opping, but the array growing
    // unbounded across the SW lifetime).
    const client = new WebSocketClient({
      WebSocketCtor: FakeWebSocket as never,
    })
    await client.connect('ws://x', 'p')
    const cb1 = vi.fn()
    const cb2 = vi.fn()
    client.onClose(cb1)
    client.onClose(cb2)
    client.close()
    // First close fires both callbacks (they were registered for this socket).
    expect(cb1).toHaveBeenCalledTimes(1)
    expect(cb2).toHaveBeenCalledTimes(1)

    // After close(), reconnect with a fresh callback. The OLD cb1/cb2 must
    // NOT be carried forward — only the newly-registered cb3 should fire.
    await client.connect('ws://y', 'p')
    const cb3 = vi.fn()
    client.onClose(cb3)
    client.close()
    expect(cb1).toHaveBeenCalledTimes(1) // unchanged
    expect(cb2).toHaveBeenCalledTimes(1) // unchanged
    expect(cb3).toHaveBeenCalledTimes(1)
  })

  it('binds close callbacks to their socket when A closes after B is registered', async () => {
    DelayedCloseWebSocket.instances = []
    const client = new WebSocketClient({
      WebSocketCtor: DelayedCloseWebSocket as never,
    })

    const connectA = client.connect('ws://a', 'p')
    const socketA = DelayedCloseWebSocket.instances[0]
    socketA.open()
    await connectA
    const onCloseA = vi.fn()
    client.onClose(onCloseA)

    // Release A, but hold its browser close event until after B is live.
    client.close()
    expect(onCloseA).not.toHaveBeenCalled()

    const connectB = client.connect('ws://b', 'p')
    const socketB = DelayedCloseWebSocket.instances[1]
    socketB.open()
    const connB = await connectB
    const onCloseB = vi.fn()
    client.onClose(onCloseB)

    socketA.emitClose()
    expect(onCloseB).not.toHaveBeenCalled()
    expect(client.getConnection()).toBe(connB)

    socketB.emitClose()
    socketB.emitClose()
    expect(onCloseB).toHaveBeenCalledTimes(1)
    expect(client.getConnection()).toBeNull()
  })

  it('a connect that errors before open leaves the client reusable', async () => {
    // Regression: connect() set this.ws BEFORE awaiting 'open', and the
    // error path rejected WITHOUT clearing this.ws. A failed connect then
    // poisoned the client — every later connect() threw 'already connected'
    // and only a service-worker teardown (browser restart) cleared it. A
    // connect that never opened must leave the client reusable.
    let attempt = 0
    class FlakyWebSocket extends EventTarget {
      public readyState = 0
      public url: string
      constructor(url: string, _protocols?: string | string[]) {
        super()
        this.url = url
        const n = ++attempt
        setTimeout(() => {
          if (n === 1) {
            this.dispatchEvent(new Event('error'))
          } else {
            this.readyState = 1
            this.dispatchEvent(new Event('open'))
          }
        }, 1)
      }
      send(): void {}
      close(): void {
        this.readyState = 3
        this.dispatchEvent(new Event('close'))
      }
    }
    const client = new WebSocketClient({
      WebSocketCtor: FlakyWebSocket as never,
    })
    await expect(client.connect('ws://x', 'p')).rejects.toThrow(
      /failed to open/i
    )
    // The failed attempt must not poison the client — a fresh connect works.
    const conn = await client.connect('ws://y', 'p')
    expect(conn).toBeDefined()
    expect(typeof conn.sendRequest).toBe('function')
  })
})
