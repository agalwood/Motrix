import { AsyncLocalStorage } from 'node:async_hooks'
import { EventEmitter } from 'node:events'
import { afterEach, expect, it, vi } from 'vitest'
import { AuthorizedEnvelopeStream } from './authorized-envelope-stream'
import type {
  AuthenticatedBridgeClient,
  BridgeClientAuthorization,
} from './client-authorization'
import type { EnvelopeStream } from './mbp1/envelope-message-stream'

class Stream extends EventEmitter implements EnvelopeStream {
  readyState = 1
  usage = { frames: 0, blocks: 0 }
  readonly sent: (string | Uint8Array)[] = []
  readonly closeCodes: (number | undefined)[] = []
  send(data: string | Uint8Array) {
    this.sent.push(data)
    this.usage.frames++
  }
  close(code?: number) {
    this.closeCodes.push(code)
    this.readyState = 3
    this.emit('close')
  }
}
const client: AuthenticatedBridgeClient = {
  identity: {
    kind: 'extension',
    browser: 'chromium',
    extensionId: 'extension',
  },
  credential: {
    kind: 'extension',
    credentialId: 'credential',
    authorizationEpoch: 'epoch',
  },
}
const disposers: (() => void)[] = []
afterEach(() => {
  for (const dispose of disposers.splice(0)) dispose()
  vi.useRealTimers()
})
function fixture(lookup: () => Promise<void> = async () => {}) {
  const stream = new Stream()
  const scope = new AsyncLocalStorage<string>()
  const calls: AuthenticatedBridgeClient[] = []
  const authorization: BridgeClientAuthorization = {
    async run(reference, operation) {
      calls.push(reference)
      await lookup()
      return scope.run('account', operation)
    },
  }
  let current = true
  const denied = vi.fn()
  const gated = new AuthorizedEnvelopeStream(
    stream,
    client,
    authorization,
    () => current,
    denied
  )
  disposers.push(gated.dispose)
  return {
    stream,
    gated,
    scope,
    calls,
    denied,
    revoke: () => {
      current = false
    },
  }
}
function barrier() {
  let release!: () => void
  const pending = new Promise<void>((resolve) => {
    release = resolve
  })
  return { pending, release }
}

it('preserves frame order and account context in both directions', async () => {
  const wait = barrier()
  const f = fixture(() => wait.pending)
  const incoming: string[] = []
  f.gated.on('message', (value) => {
    expect(f.scope.getStore()).toBe('account')
    incoming.push(String(value))
  })
  f.stream.emit('message', 'first', true)
  f.stream.emit('message', 'second', true)
  const outgoing = Promise.all([f.gated.send('one'), f.gated.send('two')])
  await vi.waitFor(() => expect(f.calls).toHaveLength(2))
  expect(f.stream.sent).toEqual([])
  expect(incoming).toEqual([])
  wait.release()
  await outgoing
  await vi.waitFor(() => expect(incoming).toEqual(['first', 'second']))
  expect(f.stream.sent).toEqual(['one', 'two'])
  expect(f.calls.every((reference) => reference === client)).toBe(true)
  expect(f.scope.getStore()).toBeUndefined()
})

it('drops waiting inbound and outbound data when the exact credential is revoked during lookup', async () => {
  const wait = barrier()
  const f = fixture(() => wait.pending)
  const receive = vi.fn()
  f.gated.on('message', receive)
  f.stream.emit('message', 'private response', true)
  const assertion = expect(f.gated.send('private event')).rejects.toThrow(
    'authorization'
  )
  await vi.waitFor(() => expect(f.calls).toHaveLength(2))
  f.revoke()
  wait.release()
  await assertion
  expect(receive).not.toHaveBeenCalled()
  expect(f.stream.sent).toEqual([])
  expect(f.stream.usage.frames).toBe(0)
  expect(f.stream.closeCodes).toEqual([1008])
  expect(f.denied).toHaveBeenCalledOnce()
})

it('bounds queued frames behind a stalled authority and releases writers on closure', async () => {
  const wait = barrier()
  const f = fixture(() => wait.pending)
  const first = f.gated.send('first')
  const firstResult = Promise.allSettled([first])
  await vi.waitFor(() => expect(f.calls).toHaveLength(1))
  const rest = Promise.allSettled(
    Array.from({ length: 32 }, () => f.gated.send('queued'))
  )
  expect((await firstResult)[0].status).toBe('rejected')
  expect((await rest).every((entry) => entry.status === 'rejected')).toBe(true)
  wait.release()
  await Promise.resolve()
  expect(f.stream.sent).toEqual([])
  expect(f.denied).toHaveBeenCalledOnce()
})

it('bounds total queued bytes independently of the number of frames', async () => {
  const f = fixture()
  await expect(
    f.gated.send(new Uint8Array(2 * 1024 * 1024 + 1))
  ).rejects.toThrow('authorization')
  expect(f.calls).toHaveLength(0)
  expect(f.stream.sent).toEqual([])
  expect(f.stream.closeCodes).toEqual([1008])
})

it('does not impose an account-lookup deadline on an admitted long-running operation or close for a business error', async () => {
  vi.useFakeTimers()
  const f = fixture()
  const wait = barrier()
  const entered = vi.fn()
  const operation = f.gated.run(async () => {
    entered()
    await wait.pending
    return 'done'
  })
  await vi.advanceTimersByTimeAsync(0)
  expect(entered).toHaveBeenCalledOnce()
  await vi.advanceTimersByTimeAsync(6000)
  expect(f.stream.readyState).toBe(1)
  wait.release()
  expect(await operation).toBe('done')
  await expect(
    f.gated.run(async () => {
      throw new Error('directory denied')
    })
  ).rejects.toThrow('directory denied')
  expect(f.denied).not.toHaveBeenCalled()
  expect(f.stream.readyState).toBe(1)
})

it('closes on lookup timeout even if the authority ignores cancellation', async () => {
  vi.useFakeTimers()
  const f = fixture(() => new Promise(() => {}))
  const pending = expect(f.gated.send('private')).rejects.toThrow(
    'authorization'
  )
  await vi.advanceTimersByTimeAsync(5001)
  await pending
  expect(f.stream.sent).toEqual([])
  expect(f.stream.closeCodes).toEqual([1008])
  expect(vi.getTimerCount()).toBe(0)
})

it('revalidates an idle connection and removes the heartbeat after account denial', async () => {
  vi.useFakeTimers()
  let allowed = true
  const f = fixture(async () => {
    if (!allowed) throw new Error('account disabled')
  })
  f.gated.start()
  await vi.advanceTimersByTimeAsync(0)
  expect(f.calls).toHaveLength(1)
  allowed = false
  await vi.advanceTimersByTimeAsync(10_000)
  expect(f.stream.closeCodes).toEqual([1008])
  expect(vi.getTimerCount()).toBe(0)
})

it('cancels a stalled writer immediately on normal connection closure', async () => {
  const wait = barrier()
  const f = fixture(() => wait.pending)
  const pending = expect(f.gated.send('private')).rejects.toThrow(
    'authorization'
  )
  await vi.waitFor(() => expect(f.calls).toHaveLength(1))
  f.stream.close(1000)
  await pending
  wait.release()
  expect(f.stream.sent).toEqual([])
  expect(f.denied).not.toHaveBeenCalled()
})

it('handles a synchronous authority failure without leaving an unobserved deadline rejection', async () => {
  const stream = new Stream()
  const denied = vi.fn()
  const gated = new AuthorizedEnvelopeStream(
    stream,
    client,
    {
      run() {
        throw new Error('authority unavailable')
      },
    },
    () => true,
    denied
  )
  disposers.push(gated.dispose)
  await expect(gated.send('private')).rejects.toThrow('authority unavailable')
  expect(stream.sent).toEqual([])
  expect(stream.closeCodes).toEqual([1008])
  expect(denied).toHaveBeenCalledOnce()
})
