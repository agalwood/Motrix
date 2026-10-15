import { beforeEach, describe, expect, it, vi } from 'vitest'
import { MessageBus, send } from '@/background/MessageBus'

declare const browser: {
  runtime: {
    sendMessage: (message: unknown) => Promise<unknown>
    onMessage: {
      addListener: (
        fn: (
          msg: unknown,
          sender: unknown,
          sendResponse: (r: unknown) => void
        ) => boolean
      ) => void
    }
  }
}

let listener:
  | ((
      msg: unknown,
      sender: unknown,
      sendResponse: (r: unknown) => void
    ) => boolean)
  | null = null

beforeEach(() => {
  listener = null
  browser.runtime.sendMessage = vi.fn(async () => undefined)
  browser.runtime.onMessage = {
    addListener: vi.fn((fn) => {
      listener = fn
    }),
  }
})

async function fire(envelope: unknown): Promise<unknown> {
  return new Promise((resolve) => {
    if (!listener) throw new Error('listener not attached')
    listener(envelope, {}, resolve)
  })
}

describe('MessageBus', () => {
  it('routes envelopes to registered handlers', async () => {
    const bus = new MessageBus()
    bus.on('bg.getState', async () => ({
      state: 'connected' as const,
      server: {
        name: 'motrix',
        version: '2.0',
        runtime: 'electron' as const,
      },
    }))
    bus.attach()

    const res = await fire({ kind: 'bg.getState', payload: undefined })
    expect(res).toEqual({
      state: 'connected',
      server: { name: 'motrix', version: '2.0', runtime: 'electron' },
    })
  })

  it('returns error for unknown kind', async () => {
    const bus = new MessageBus()
    bus.attach()
    const res = await fire({ kind: 'unknown', payload: undefined })
    expect(res).toMatchObject({ error: expect.stringContaining('unknown') })
  })

  it('catches handler errors', async () => {
    const bus = new MessageBus()
    bus.on('bg.reconnect', async () => {
      throw new Error('boom')
    })
    bus.attach()
    const res = await fire({ kind: 'bg.reconnect', payload: undefined })
    expect(res).toMatchObject({ error: 'boom' })
  })

  it('attaches synchronously but waits for startup recovery before dispatch', async () => {
    let release = (): void => undefined
    const ready = new Promise<void>((resolve) => {
      release = resolve
    })
    const handler = vi.fn(async () => ({ ok: true }) as const)
    const bus = new MessageBus({ beforeDispatch: () => ready })
    bus.on('bg.reconnect', handler)
    bus.attach()

    const response = fire({ kind: 'bg.reconnect', payload: undefined })
    await Promise.resolve()
    expect(handler).not.toHaveBeenCalled()

    release()
    await expect(response).resolves.toEqual({ ok: true })
    expect(handler).toHaveBeenCalledOnce()
  })

  it('fails closed without calling a handler when startup recovery rejects', async () => {
    const handler = vi.fn(async () => ({ ok: true }) as const)
    const bus = new MessageBus({
      beforeDispatch: async () => {
        throw new Error('background startup unavailable')
      },
    })
    bus.on('bg.reconnect', handler)
    bus.attach()

    await expect(
      fire({ kind: 'bg.reconnect', payload: undefined })
    ).resolves.toEqual({ error: 'background startup unavailable' })
    expect(handler).not.toHaveBeenCalled()
  })

  it('does not leak a non-Error rejection through the response', async () => {
    const bus = new MessageBus({
      beforeDispatch: () => Promise.reject('secret-sentinel'),
    })
    bus.on('bg.reconnect', async () => ({ ok: true }) as const)
    bus.attach()

    await expect(
      fire({ kind: 'bg.reconnect', payload: undefined })
    ).resolves.toEqual({ error: 'handler failed' })
  })

  it('rejects malformed envelopes', async () => {
    const bus = new MessageBus()
    bus.attach()
    const res = await fire(null)
    expect(res).toMatchObject({ error: 'invalid envelope' })
  })

  it('turns a background ErrorResponse into a rejected client request', async () => {
    browser.runtime.sendMessage = vi.fn(async () => ({ error: 'save failed' }))

    await expect(send('bg.reconnect', undefined)).rejects.toThrow('save failed')
  })
})
