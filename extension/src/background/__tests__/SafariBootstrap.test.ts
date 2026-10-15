import { afterEach, describe, expect, it, vi } from 'vitest'
import { NativeBootstrapError } from '@/background/BootstrapProvider'
import { b64uDecode, b64uEncode } from '@/background/mbp1/canonical'
import type { BootstrapRequest } from '@/background/mbp1/ticket-bootstrap'
import {
  SafariBootstrap,
  type SafariNativeRuntime,
} from '@/background/SafariBootstrap'

const bindingPub = new Uint8Array(32).fill(7)
const reply = {
  action: 'requestPair',
  protocolVersion: 1,
  port: 16803,
  nonce: 'pair-nonce',
  nmTicket: { v: 1 },
}

function makeRuntime(response: unknown = reply) {
  return {
    getManifest: vi.fn(() => ({ permissions: ['nativeMessaging'] })),
    sendNativeMessage: vi.fn(
      async (_application: string, _message: BootstrapRequest) => response
    ),
  }
}

afterEach(() => {
  vi.useRealTimers()
})

describe('SafariBootstrap', () => {
  it('uses a single Promise message with an explicit passive bootstrap request', async () => {
    const runtime = makeRuntime()
    await expect(
      new SafariBootstrap({ runtime }).discover({ bindingPub })
    ).resolves.toEqual({
      wsPort: 16803,
      nonce: 'pair-nonce',
      nmTicket: { v: 1 },
      protocolVersion: 1,
    })
    expect(runtime.sendNativeMessage).toHaveBeenCalledExactlyOnceWith(
      'app.motrix.bridge',
      {
        action: 'bootstrap',
        protocolVersion: 1,
        bindingPub: b64uEncode(bindingPub),
        allowLaunch: false,
      }
    )
  })

  it.each([false, true])(
    'preserves explicit allowLaunch=%s',
    async (allowLaunch) => {
      const runtime = makeRuntime()
      await new SafariBootstrap({ runtime }).discover({
        bindingPub,
        allowLaunch,
      })
      expect(runtime.sendNativeMessage).toHaveBeenCalledWith(
        'app.motrix.bridge',
        expect.objectContaining({ allowLaunch })
      )
    }
  )

  it.each([false, true])(
    'uses a fresh disposable key for endpoint-only discovery with allowLaunch=%s',
    async (allowLaunch) => {
      const runtime = makeRuntime()
      const bootstrap = new SafariBootstrap({ runtime })
      const first = await bootstrap.discover({ allowLaunch })
      const second = await bootstrap.discover({ allowLaunch })
      expect(first).toEqual({
        wsPort: 16803,
        nonce: 'pair-nonce',
        nmTicket: null,
        protocolVersion: 1,
      })
      expect(second.nmTicket).toBeNull()
      const requests = runtime.sendNativeMessage.mock.calls.map(
        (call) => call[1]
      )
      for (const request of requests) {
        expect(request).toEqual({
          action: 'bootstrap',
          protocolVersion: 1,
          allowLaunch,
          bindingPub: expect.any(String),
        })
        expect(b64uDecode(request.bindingPub)).toHaveLength(32)
      }
      expect(requests[0].bindingPub).not.toEqual(requests[1].bindingPub)
    }
  )

  it.each([0, 31, 33])(
    'rejects a %s-byte binding key locally',
    async (length) => {
      const runtime = makeRuntime()
      await expect(
        new SafariBootstrap({ runtime }).discover({
          bindingPub: new Uint8Array(length),
        })
      ).rejects.toMatchObject({ code: 'invalid-binding-pub' })
      expect(runtime.sendNativeMessage).not.toHaveBeenCalled()
    }
  )

  it.each([null, 'x'.repeat(32), Array(32).fill(0)])(
    'rejects a non-byte binding key without invoking native code',
    async (invalidBinding) => {
      const runtime = makeRuntime()
      await expect(
        new SafariBootstrap({ runtime }).discover({
          bindingPub: invalidBinding as unknown as Uint8Array,
        })
      ).rejects.toMatchObject({ code: 'invalid-binding-pub' })
      expect(runtime.sendNativeMessage).not.toHaveBeenCalled()
    }
  )

  it('does not infer native availability from API presence without permission', async () => {
    const runtime = makeRuntime()
    runtime.getManifest.mockReturnValue({ permissions: ['storage'] })
    await expect(
      new SafariBootstrap({ runtime }).discover({ bindingPub })
    ).rejects.toMatchObject({ code: 'unsupported' })
    expect(runtime.sendNativeMessage).not.toHaveBeenCalled()
  })

  it('rejects a missing native API even when the manifest declares permission', async () => {
    const runtime: SafariNativeRuntime = {
      getManifest: () => ({ permissions: ['nativeMessaging'] }),
    }
    await expect(
      new SafariBootstrap({ runtime }).discover({ bindingPub })
    ).rejects.toMatchObject({ code: 'unsupported' })
  })

  it('rejects when the manifest cannot be read', async () => {
    const runtime = makeRuntime()
    runtime.getManifest.mockImplementation(() => {
      throw new Error('Extension context invalidated')
    })
    await expect(
      new SafariBootstrap({ runtime }).discover({ bindingPub })
    ).rejects.toMatchObject({ code: 'unsupported' })
    expect(runtime.sendNativeMessage).not.toHaveBeenCalled()
  })

  it('surfaces the versioned bootstrap-unavailable response as a typed host error', async () => {
    const runtime = makeRuntime({
      error: 'bootstrap-unavailable',
      protocolVersion: 1,
    })
    await expect(
      new SafariBootstrap({ runtime }).discover({ bindingPub })
    ).rejects.toEqual(
      new NativeBootstrapError(
        'bootstrap-unavailable',
        'host-error:bootstrap-unavailable'
      )
    )
  })

  it.each([
    'malformed-message',
    'message-too-large',
    'invalid-request',
    'unsupported-action',
    'unsupported-version',
    'bootstrap-timeout',
    'bootstrap-cancelled',
    'invalid-response',
    'ipc-timeout',
    'ipc-unavailable',
    'launch-denied',
  ])('surfaces a fixed native error code: %s', async (error) => {
    await expect(
      new SafariBootstrap({
        runtime: makeRuntime({ error, protocolVersion: 1 }),
      }).discover({ bindingPub })
    ).rejects.toMatchObject({ code: `host-error:${error}`, message: error })
  })

  it.each([
    'Unexpected native diagnostics: secret=do-not-expose',
    'x'.repeat(1_024),
    'bootstrap-unavailable\ninjected diagnostic',
    '__proto__',
    'toString',
    'constructor',
  ])('does not expose an unknown native error', async (error) => {
    await expect(
      new SafariBootstrap({
        runtime: makeRuntime({ error, protocolVersion: 1 }),
      }).discover({ bindingPub })
    ).rejects.toEqual(
      new NativeBootstrapError('malformed NM response', 'malformed')
    )
  })

  it.each([
    { error: 'bootstrap-unavailable' },
    { error: 'bootstrap-unavailable', protocolVersion: 0 },
    { error: 'bootstrap-unavailable', protocolVersion: 2 },
    { error: 'bootstrap-unavailable', protocolVersion: '1' },
    { error: 'bootstrap-unavailable', protocolVersion: true },
    { error: '', protocolVersion: 1 },
    { error: {}, protocolVersion: 1 },
    { error: null, protocolVersion: 1 },
    { error: true, protocolVersion: 1 },
    { error: ['bootstrap-unavailable'], protocolVersion: 1 },
  ])(
    'rejects malformed or incompatible error envelopes: %j',
    async (response) => {
      await expect(
        new SafariBootstrap({ runtime: makeRuntime(response) }).discover({
          bindingPub,
        })
      ).rejects.toMatchObject({ code: 'malformed' })
    }
  )

  it.each([
    null,
    undefined,
    [],
    '',
    true,
    1,
    {},
    { ...reply, action: 'pong' },
    { ...reply, port: 0 },
    { ...reply, port: 65_536 },
    { ...reply, port: 1.5 },
    { ...reply, nonce: '' },
    { ...reply, nonce: 'x'.repeat(513) },
    { ...reply, nonce: 42 },
    { ...reply, protocolVersion: undefined },
    { ...reply, protocolVersion: -1 },
    { ...reply, protocolVersion: 0 },
    { ...reply, protocolVersion: 2 },
    { ...reply, protocolVersion: 1.5 },
    { ...reply, protocolVersion: true },
    { ...reply, protocolVersion: '1' },
    { ...reply, nmTicket: [] },
    { ...reply, nmTicket: 'ticket' },
  ])('rejects empty or malformed replies: %j', async (response) => {
    const runtime = makeRuntime()
    runtime.sendNativeMessage.mockResolvedValue(response)
    await expect(
      new SafariBootstrap({ runtime }).discover({ bindingPub })
    ).rejects.toMatchObject({ code: 'malformed' })
  })

  it('retains shared ticketless response semantics', async () => {
    const runtime = makeRuntime({
      action: 'requestPair',
      port: 65_535,
      protocolVersion: 1,
    })
    await expect(
      new SafariBootstrap({ runtime }).discover({ bindingPub })
    ).resolves.toEqual({
      wsPort: 65_535,
      nonce: null,
      nmTicket: null,
      protocolVersion: 1,
    })
  })

  it.each(['throw', 'reject'])(
    'normalizes native transport failure: %s',
    async (mode) => {
      const runtime = makeRuntime()
      runtime.sendNativeMessage.mockImplementation(() => {
        if (mode === 'throw') throw new Error('Native helper is unavailable')
        return Promise.reject(new Error('Native helper is unavailable'))
      })
      await expect(
        new SafariBootstrap({ runtime }).discover({ bindingPub })
      ).rejects.toEqual(
        new NativeBootstrapError(
          'Safari native app is unavailable',
          'native-unavailable'
        )
      )
    }
  )

  it('uses a 20-second default deadline and does not retry or launch', async () => {
    vi.useFakeTimers()
    const runtime = makeRuntime()
    runtime.sendNativeMessage.mockReturnValue(new Promise(() => {}))
    const pending = new SafariBootstrap({ runtime }).discover({ bindingPub })
    const rejected = expect(pending).rejects.toMatchObject({ code: 'timeout' })
    await vi.advanceTimersByTimeAsync(19_999)
    expect(vi.getTimerCount()).toBe(1)
    await vi.advanceTimersByTimeAsync(1)
    await rejected
    expect(runtime.sendNativeMessage).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(0)
  })

  it.each(['resolve', 'reject'])(
    'ignores a late native %s after timeout',
    async (outcome) => {
      vi.useFakeTimers()
      let resolveNative!: (value: unknown) => void
      let rejectNative!: (reason: Error) => void
      const runtime = makeRuntime()
      runtime.sendNativeMessage.mockReturnValue(
        new Promise((resolve, reject) => {
          resolveNative = resolve
          rejectNative = reject
        })
      )
      const pending = new SafariBootstrap({ runtime, timeoutMs: 50 }).discover({
        bindingPub,
      })
      const observed = pending.then(
        () => 'success',
        (error: NativeBootstrapError) => error.code
      )
      await vi.advanceTimersByTimeAsync(50)
      await expect(observed).resolves.toBe('timeout')
      if (outcome === 'resolve') resolveNative(reply)
      else rejectNative(new Error('Native response arrived too late'))
      await vi.runAllTimersAsync()
      await expect(observed).resolves.toBe('timeout')
      expect(runtime.sendNativeMessage).toHaveBeenCalledTimes(1)
    }
  )

  it('clears the deadline after an immediate reply', async () => {
    vi.useFakeTimers()
    await new SafariBootstrap({ runtime: makeRuntime() }).discover({
      bindingPub,
    })
    expect(vi.getTimerCount()).toBe(0)
  })
})
