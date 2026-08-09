import { ErrorCode } from '@shared/errors'
import { Commands } from '@shared/protocol/commands'
import {
  makeProtocolFailure,
  makeProtocolSuccess,
  ProtocolEnvelopeError,
  TransportError,
} from '@shared/protocol/errors'
import { Events } from '@shared/protocol/events'
import { Queries } from '@shared/protocol/queries'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { HttpWsTransport } from './http-ws'

class FakeWebSocket {
  static instances: FakeWebSocket[] = []

  readonly listeners = new Map<string, Set<(event: Event) => void>>()
  readonly close = vi.fn(() => {
    this.dispatch('close')
  })

  constructor(readonly url: string) {
    FakeWebSocket.instances.push(this)
  }

  addEventListener(type: string, listener: EventListener): void {
    const set = this.listeners.get(type) ?? new Set()
    set.add(listener as (event: Event) => void)
    this.listeners.set(type, set)
  }

  dispatch(type: string, event: Event = new Event(type)): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event)
  }

  message(frame: unknown): void {
    this.dispatch(
      'message',
      new MessageEvent('message', { data: JSON.stringify(frame) })
    )
  }
}

function socketCtor(): typeof WebSocket {
  return FakeWebSocket as unknown as typeof WebSocket
}

afterEach(() => {
  vi.useRealTimers()
  FakeWebSocket.instances = []
})

describe('HttpWsTransport', () => {
  it('POSTs args to /rpc/command/<channel>', async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ ok: true, gid: 'g1' }), { status: 200 })
    )
    const t = new HttpWsTransport('http://example.test', { fetch: fetchMock })
    const res = await t.invoke(Commands.PauseTask, 't1')
    expect(res).toEqual({ ok: true, gid: 'g1' })
    expect(fetchMock).toHaveBeenCalledWith(
      `http://example.test/rpc/command/${encodeURIComponent(Commands.PauseTask)}`,
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          'content-type': 'application/json',
        }),
        body: JSON.stringify({ args: ['t1'] }),
      })
    )
  })

  it('unwraps inspector success and typed failures', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify(makeProtocolSuccess({ revision: 4 })), {
          status: 200,
        })
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify(
            makeProtocolFailure({
              code: ErrorCode.TaskNotFound,
              message: 'missing',
            })
          ),
          { status: 200 }
        )
      )
    const t = new HttpWsTransport('http://example.test', { fetch: fetchMock })

    await expect(
      t.invoke(Queries.GetTaskInspectorActivity, { taskId: 'task-1' })
    ).resolves.toEqual({ revision: 4 })
    await expect(
      t.invoke(Queries.GetTaskInspectorActivity, { taskId: 'missing' })
    ).rejects.toBeInstanceOf(TransportError)
  })

  it('rejects a malformed inspector envelope', async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ ok: true, revision: 4 }), { status: 200 })
    )
    const t = new HttpWsTransport('http://example.test', { fetch: fetchMock })

    await expect(
      t.invoke(Queries.GetTaskInspectorActivity, { taskId: 'task-1' })
    ).rejects.toBeInstanceOf(ProtocolEnvelopeError)
  })

  it('maps an inspector HTTP failure without exposing its response body', async () => {
    const frameworkBody = `<html>${'secret-framework-detail'.repeat(200)}</html>`
    const fetchMock = vi.fn(
      async () => new Response(frameworkBody, { status: 500 })
    )
    const t = new HttpWsTransport('http://example.test', { fetch: fetchMock })

    const failure = t.invoke(Queries.GetTaskInspectorActivity, {
      taskId: 'task-1',
    })
    await expect(failure).rejects.toMatchObject({
      code: ErrorCode.EngineProtocolError,
      message: 'Request failed',
    })
    await expect(failure).rejects.not.toThrow(frameworkBody)
  })

  it('maps invalid inspector JSON to a bounded protocol error', async () => {
    const fetchMock = vi.fn(
      async () => new Response('<html>not json</html>', { status: 200 })
    )
    const t = new HttpWsTransport('http://example.test', { fetch: fetchMock })

    await expect(
      t.invoke(Queries.GetTaskInspectorActivity, { taskId: 'task-1' })
    ).rejects.toBeInstanceOf(ProtocolEnvelopeError)
  })

  it('keeps channel listeners across a bounded reconnect', () => {
    vi.useFakeTimers()
    const t = new HttpWsTransport('http://example.test', {
      WebSocketCtor: socketCtor(),
      reconnectDelaysMs: [10, 20],
    })
    const eventListener = vi.fn()
    const connectionListener = vi.fn()
    t.onConnectionChange(connectionListener)
    t.on(Events.TaskUpdated, eventListener)

    const first = FakeWebSocket.instances[0]
    expect(first?.url).toBe('ws://example.test/rpc/events')
    first?.dispatch('open')
    first?.message({ channel: Events.TaskUpdated, args: [['first']] })
    expect(eventListener).toHaveBeenCalledWith(['first'])
    expect(connectionListener).toHaveBeenLastCalledWith({
      state: 'connected',
    })

    first?.dispatch('close')
    expect(FakeWebSocket.instances).toHaveLength(1)
    vi.advanceTimersByTime(10)
    expect(FakeWebSocket.instances).toHaveLength(2)

    const second = FakeWebSocket.instances[1]
    second?.dispatch('open')
    second?.message({ channel: Events.TaskUpdated, args: [['second']] })
    expect(eventListener).toHaveBeenLastCalledWith(['second'])
    expect(connectionListener).toHaveBeenLastCalledWith({
      state: 'connected',
    })
  })

  it('caps reconnect delay at the final configured backoff', () => {
    vi.useFakeTimers()
    const t = new HttpWsTransport('http://example.test', {
      WebSocketCtor: socketCtor(),
      reconnectDelaysMs: [5, 10],
    })
    t.on(Events.TaskUpdated, vi.fn())

    FakeWebSocket.instances[0]?.dispatch('close')
    vi.advanceTimersByTime(5)
    FakeWebSocket.instances[1]?.dispatch('close')
    vi.advanceTimersByTime(9)
    expect(FakeWebSocket.instances).toHaveLength(2)
    vi.advanceTimersByTime(1)
    FakeWebSocket.instances[2]?.dispatch('close')
    vi.advanceTimersByTime(9)
    expect(FakeWebSocket.instances).toHaveLength(3)
    vi.advanceTimersByTime(1)
    expect(FakeWebSocket.instances).toHaveLength(4)
  })

  it('cancels reconnect and closes the socket after the final listener leaves', () => {
    vi.useFakeTimers()
    const t = new HttpWsTransport('http://example.test', {
      WebSocketCtor: socketCtor(),
      reconnectDelaysMs: [10],
    })
    const listener = vi.fn()
    t.on(Events.TaskUpdated, listener)
    const first = FakeWebSocket.instances[0]
    first?.dispatch('close')

    t.off(Events.TaskUpdated, listener)
    vi.advanceTimersByTime(100)
    expect(FakeWebSocket.instances).toHaveLength(1)

    t.on(Events.TaskUpdated, listener)
    const second = FakeWebSocket.instances[1]
    expect(second).toBeDefined()
    t.off(Events.TaskUpdated, listener)
    expect(second?.close).toHaveBeenCalledOnce()
    vi.advanceTimersByTime(100)
    expect(FakeWebSocket.instances).toHaveLength(2)
  })

  it('isolates connection lifecycle listener failures', () => {
    const t = new HttpWsTransport('http://example.test', {
      WebSocketCtor: socketCtor(),
    })
    const healthy = vi.fn()
    t.onConnectionChange(() => {
      throw new Error('listener failed')
    })
    t.onConnectionChange(healthy)

    expect(() => {
      t.on(Events.TaskUpdated, vi.fn())
      FakeWebSocket.instances[0]?.dispatch('open')
    }).not.toThrow()
    expect(healthy).toHaveBeenLastCalledWith({
      state: 'connected',
    })
  })
})
