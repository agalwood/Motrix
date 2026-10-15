import { beforeEach, describe, expect, it, vi } from 'vitest'
import { b64uEncode } from '@/background/mbp1/canonical'
import { generateBindingKeypair } from '@/background/mbp1/ticket-bootstrap'
import {
  NativeBootstrap,
  NativeBootstrapError,
} from '@/background/NativeBootstrap'

declare const browser: {
  runtime: {
    connectNative?: (...args: unknown[]) => unknown
    lastError: undefined | { message: string }
  }
}

interface FakePort {
  postMessage: ReturnType<typeof vi.fn>
  disconnect: ReturnType<typeof vi.fn>
  onMessage: { addListener: (fn: (m: unknown) => void) => void }
  onDisconnect: { addListener: (fn: () => void) => void }
  __fireMessage: (m: unknown) => void
  __fireDisconnect: () => void
}

function makeFakePort(): FakePort {
  const messageListeners: Array<(m: unknown) => void> = []
  const disconnectListeners: Array<() => void> = []
  return {
    postMessage: vi.fn(),
    disconnect: vi.fn(),
    onMessage: {
      addListener: (fn) => {
        messageListeners.push(fn)
      },
    },
    onDisconnect: {
      addListener: (fn) => {
        disconnectListeners.push(fn)
      },
    },
    __fireMessage: (m) => {
      for (const l of messageListeners) l(m)
    },
    __fireDisconnect: () => {
      for (const l of disconnectListeners) l()
    },
  }
}

beforeEach(() => {
  browser.runtime.lastError = undefined
})

describe('NativeBootstrap', () => {
  it('rejects cleanly when the browser has no Native Messaging API', async () => {
    const connectNative = browser.runtime.connectNative
    browser.runtime.connectNative = undefined

    try {
      await expect(new NativeBootstrap().discover()).rejects.toMatchObject({
        code: 'unsupported',
      })
    } finally {
      browser.runtime.connectNative = connectNative
    }
  })

  it('returns WS port + nonce on requestPair (Plan 02 contract)', async () => {
    const port = makeFakePort()
    browser.runtime.connectNative = vi.fn(() => port)

    const bootstrap = new NativeBootstrap()
    const promise = bootstrap.discover()
    setTimeout(
      () =>
        port.__fireMessage({
          action: 'requestPair',
          protocolVersion: 1,
          port: 12345,
          nonce: 'n-abc',
        }),
      5
    )

    const result = await promise
    expect(result.wsPort).toBe(12345)
    expect(result.nonce).toBe('n-abc')
    expect(port.disconnect).toHaveBeenCalled()
  })

  it('accepts nonce=null when host failed to fetch /nonce', async () => {
    // The native host writes nonce:null if its /nonce fetch failed.
    // ext bootstrap MUST still surface the WS port — caller decides
    // whether to attempt /pair (impossible without nonce) or an
    // authenticated reconnect using a stored MBP1 credential.
    const port = makeFakePort()
    browser.runtime.connectNative = vi.fn(() => port)

    const bootstrap = new NativeBootstrap()
    const promise = bootstrap.discover()
    setTimeout(
      () =>
        port.__fireMessage({
          action: 'requestPair',
          protocolVersion: 1,
          port: 12345,
          nonce: null,
        }),
      5
    )

    const result = await promise
    expect(result.wsPort).toBe(12345)
    expect(result.nonce).toBeNull()
  })

  it('treats missing nonce field as nonce=null (forward-compat)', async () => {
    const port = makeFakePort()
    browser.runtime.connectNative = vi.fn(() => port)

    const bootstrap = new NativeBootstrap()
    const promise = bootstrap.discover()
    setTimeout(
      () =>
        port.__fireMessage({
          action: 'requestPair',
          protocolVersion: 1,
          port: 12345,
        }),
      5
    )

    const result = await promise
    expect(result.nonce).toBeNull()
  })

  it('throws if host responds with error', async () => {
    const port = makeFakePort()
    browser.runtime.connectNative = vi.fn(() => port)

    const bootstrap = new NativeBootstrap()
    const promise = bootstrap.discover()
    setTimeout(() => port.__fireMessage({ error: 'motrix-not-installed' }), 5)

    await expect(promise).rejects.toThrowError(NativeBootstrapError)
  })

  it('throws if host disconnects without responding', async () => {
    const port = makeFakePort()
    browser.runtime.connectNative = vi.fn(() => port)

    const bootstrap = new NativeBootstrap()
    const promise = bootstrap.discover()
    setTimeout(() => port.__fireDisconnect(), 5)

    await expect(promise).rejects.toThrow(/disconnect/i)
  })

  it('times out after configured ms', async () => {
    const port = makeFakePort()
    browser.runtime.connectNative = vi.fn(() => port)

    const bootstrap = new NativeBootstrap({ timeoutMs: 50 })
    await expect(bootstrap.discover()).rejects.toThrow(/timeout/i)
  })

  it('postMessage is sent with action:start', async () => {
    const port = makeFakePort()
    browser.runtime.connectNative = vi.fn(() => port)

    const bootstrap = new NativeBootstrap()
    const promise = bootstrap.discover()
    setTimeout(
      () =>
        port.__fireMessage({
          action: 'requestPair',
          protocolVersion: 1,
          port: 12345,
          nonce: 'n-1',
        }),
      5
    )
    await promise

    expect(port.postMessage).toHaveBeenCalledWith({
      action: 'start',
      allowLaunch: false,
    })
  })

  it('rejects malformed responses', async () => {
    const port = makeFakePort()
    browser.runtime.connectNative = vi.fn(() => port)

    const bootstrap = new NativeBootstrap()
    const promise = bootstrap.discover()
    setTimeout(() => port.__fireMessage({ random: 'shape' }), 5)

    await expect(promise).rejects.toThrow(/malformed/i)
  })

  it.each([null, undefined, [], 'reply', 1, true])(
    'rejects non-object replies without throwing from the message listener: %j',
    async (reply) => {
      const port = makeFakePort()
      browser.runtime.connectNative = vi.fn(() => port)
      const promise = new NativeBootstrap().discover()

      expect(() => port.__fireMessage(reply)).not.toThrow()
      await expect(promise).rejects.toMatchObject({ code: 'malformed' })
      expect(port.disconnect).toHaveBeenCalledExactlyOnceWith()
    }
  )

  it.each([
    { nonce: '' },
    { nonce: 'x'.repeat(513) },
    { nonce: 1 },
    { protocolVersion: -1 },
    { protocolVersion: 1.5 },
    { nmTicket: [] },
  ])('rejects invalid handoff fields: %j', async (fields) => {
    const port = makeFakePort()
    browser.runtime.connectNative = vi.fn(() => port)
    const promise = new NativeBootstrap().discover()
    port.__fireMessage({
      action: 'requestPair',
      protocolVersion: 1,
      port: 12345,
      nonce: 'n-1',
      ...fields,
    })

    await expect(promise).rejects.toMatchObject({ code: 'malformed' })
  })

  it('preserves legacy protocol version 0, boundary values and opaque ticket objects', async () => {
    const port = makeFakePort()
    browser.runtime.connectNative = vi.fn(() => port)
    const promise = new NativeBootstrap().discover()
    port.__fireMessage({
      action: 'requestPair',
      protocolVersion: 0,
      port: 65_535,
      nonce: 'x'.repeat(512),
      nmTicket: {},
    })

    await expect(promise).resolves.toEqual({
      wsPort: 65_535,
      nonce: 'x'.repeat(512),
      nmTicket: {},
      protocolVersion: 0,
    })
  })

  it.each([0, 65_536, 1.5, Number.NaN])(
    'rejects invalid native host port %s',
    async (invalidPort) => {
      const port = makeFakePort()
      browser.runtime.connectNative = vi.fn(() => port)

      const promise = new NativeBootstrap().discover()
      port.__fireMessage({
        action: 'requestPair',
        protocolVersion: 1,
        port: invalidPort,
        nonce: 'n-1',
      })

      await expect(promise).rejects.toMatchObject({ code: 'malformed' })
    }
  )

  it('disconnects immediately when the native start message throws', async () => {
    const port = makeFakePort()
    port.postMessage.mockImplementation(() => {
      throw new Error('native channel closed')
    })
    browser.runtime.connectNative = vi.fn(() => port)

    await expect(new NativeBootstrap().discover()).rejects.toMatchObject({
      code: 'disconnect',
      message: expect.stringContaining('native channel closed'),
    })
    expect(port.disconnect).toHaveBeenCalledTimes(1)
  })

  it('sends allowLaunch:true in the start message', async () => {
    const port = makeFakePort()
    browser.runtime.connectNative = vi.fn(() => port)
    const bootstrap = new NativeBootstrap()
    const promise = bootstrap.discover({ allowLaunch: true })
    setTimeout(
      () =>
        port.__fireMessage({
          action: 'requestPair',
          protocolVersion: 1,
          port: 1,
          nonce: 'n',
        }),
      5
    )
    await promise
    expect(port.postMessage).toHaveBeenCalledWith({
      action: 'start',
      allowLaunch: true,
    })
  })

  it('defaults allowLaunch to false when omitted', async () => {
    const port = makeFakePort()
    browser.runtime.connectNative = vi.fn(() => port)
    const bootstrap = new NativeBootstrap()
    const promise = bootstrap.discover()
    setTimeout(
      () =>
        port.__fireMessage({
          action: 'requestPair',
          protocolVersion: 1,
          port: 1,
          nonce: 'n',
        }),
      5
    )
    await promise
    expect(port.postMessage).toHaveBeenCalledWith({
      action: 'start',
      allowLaunch: false,
    })
  })

  it('rejects with code not-running on motrix-not-running', async () => {
    const port = makeFakePort()
    browser.runtime.connectNative = vi.fn(() => port)
    const bootstrap = new NativeBootstrap()
    const promise = bootstrap.discover({ allowLaunch: false })
    setTimeout(() => port.__fireMessage({ error: 'motrix-not-running' }), 5)
    await expect(promise).rejects.toMatchObject({
      code: 'host-error:motrix-not-running',
    })
  })
})

describe('NativeBootstrap §9.1 attestation bootstrap', () => {
  // A real 32-byte Ed25519 public key, not the brief's `'AAAA'` fixture: the
  // host's `parse_host_request` requires `bindingPub` to base64url-decode to
  // exactly 32 bytes and never falls back to v1 semantics on a bad one
  // (`packages/native-host/src/lib.rs`) — a fixture that cannot exist on the
  // wire would prove nothing about this path.
  const { pub: bindingPub } = generateBindingKeypair()

  it('sends a bootstrap action carrying bindingPub and parses nmTicket', async () => {
    const port = makeFakePort()
    browser.runtime.connectNative = vi.fn(() => port)

    const bootstrap = new NativeBootstrap()
    const promise = bootstrap.discover({ allowLaunch: false, bindingPub })
    setTimeout(
      () =>
        port.__fireMessage({
          action: 'requestPair',
          protocolVersion: 1,
          port: 16803,
          nonce: 'n',
          nmTicket: { v: 1 },
        }),
      5
    )

    expect(port.postMessage).toHaveBeenCalledWith({
      action: 'bootstrap',
      protocolVersion: 1,
      bindingPub: b64uEncode(bindingPub),
      allowLaunch: false,
    })

    await expect(promise).resolves.toMatchObject({
      wsPort: 16803,
      nonce: 'n',
      nmTicket: { v: 1 },
      protocolVersion: 1,
    })
  })

  it('passes allowLaunch through to the bootstrap request unchanged', async () => {
    const port = makeFakePort()
    browser.runtime.connectNative = vi.fn(() => port)

    const bootstrap = new NativeBootstrap()
    const promise = bootstrap.discover({ allowLaunch: true, bindingPub })
    setTimeout(
      () =>
        port.__fireMessage({
          action: 'requestPair',
          protocolVersion: 1,
          port: 16803,
          nonce: 'n',
        }),
      5
    )
    await promise

    expect(port.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'bootstrap', allowLaunch: true })
    )
  })

  it('resolves nmTicket to null when the host degrades to ticketless', async () => {
    // §9.1/§9.2: the host omits `nmTicket` entirely (never `null`) when it
    // cannot mint one — an absent caller identity, endpoint.json failing its
    // permission check, etc. — and this is a normal, expected outcome, not
    // an error.
    const port = makeFakePort()
    browser.runtime.connectNative = vi.fn(() => port)

    const bootstrap = new NativeBootstrap()
    const promise = bootstrap.discover({ bindingPub })
    setTimeout(
      () =>
        port.__fireMessage({
          action: 'requestPair',
          protocolVersion: 1,
          port: 16803,
          nonce: 'n',
        }),
      5
    )

    await expect(promise).resolves.toMatchObject({ nmTicket: null })
  })

  it('rejects locally, without ever calling connectNative, on a wrong-length bindingPub', async () => {
    // The host's answer to a malformed `bindingPub` is silence (parse fails,
    // process exits, no reply) — indistinguishable from "nothing is
    // installed" if this side ever let it reach the wire. Catch it first.
    const connectNative = vi.fn()
    browser.runtime.connectNative = connectNative

    const bootstrap = new NativeBootstrap()
    await expect(
      bootstrap.discover({ bindingPub: new Uint8Array(3) })
    ).rejects.toMatchObject({ code: 'invalid-binding-pub' })

    expect(connectNative).not.toHaveBeenCalled()
  })

  it.each([31, 33, 0])('rejects a bindingPub of %d bytes', async (length) => {
    const bootstrap = new NativeBootstrap()
    await expect(
      bootstrap.discover({ bindingPub: new Uint8Array(length) })
    ).rejects.toMatchObject({ code: 'invalid-binding-pub' })
  })

  it('rejects a requestPair reply with no protocolVersion', async () => {
    const port = makeFakePort()
    browser.runtime.connectNative = vi.fn(() => port)

    const bootstrap = new NativeBootstrap()
    const promise = bootstrap.discover({ bindingPub })
    setTimeout(
      () => port.__fireMessage({ action: 'requestPair', port: 1, nonce: 'n' }),
      5
    )

    await expect(promise).rejects.toMatchObject({ code: 'malformed' })
  })

  it('rejects a requestPair reply whose protocolVersion is not an integer', async () => {
    const port = makeFakePort()
    browser.runtime.connectNative = vi.fn(() => port)

    const bootstrap = new NativeBootstrap()
    const promise = bootstrap.discover({ bindingPub })
    setTimeout(
      () =>
        port.__fireMessage({
          action: 'requestPair',
          protocolVersion: '1',
          port: 1,
          nonce: 'n',
        }),
      5
    )

    await expect(promise).rejects.toMatchObject({ code: 'malformed' })
  })

  it('rejects a requestPair reply whose nmTicket is neither an object nor absent', async () => {
    const port = makeFakePort()
    browser.runtime.connectNative = vi.fn(() => port)

    const bootstrap = new NativeBootstrap()
    const promise = bootstrap.discover({ bindingPub })
    setTimeout(
      () =>
        port.__fireMessage({
          action: 'requestPair',
          protocolVersion: 1,
          port: 1,
          nonce: 'n',
          nmTicket: 'not-an-object',
        }),
      5
    )

    await expect(promise).rejects.toMatchObject({ code: 'malformed' })
  })
})
