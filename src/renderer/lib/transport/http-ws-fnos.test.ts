import { useOperatorSession } from '@renderer/lib/operator-auth'
import { Commands } from '@shared/protocol/commands'
import { Events } from '@shared/protocol/events'
import {
  FNOS_EVENT_PROTOCOL,
  FNOS_EVENT_TICKET_PREFIX,
  WEB_ORIGIN_HEADER,
} from '@shared/schemas/operator-auth'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { HttpWsTransport } from './http-ws'

class Socket {
  static opened: Socket[] = []
  listeners = new Map<string, ((event: Event) => void)[]>()
  constructor(
    readonly url: string,
    readonly protocols?: string[]
  ) {
    Socket.opened.push(this)
  }
  addEventListener(name: string, listener: (event: Event) => void) {
    this.listeners.set(name, [...(this.listeners.get(name) ?? []), listener])
  }
  close() {
    for (const listener of this.listeners.get('close') ?? [])
      listener(new Event('close'))
  }
  receive(data: unknown) {
    for (const listener of this.listeners.get('message') ?? [])
      listener(new MessageEvent('message', { data: JSON.stringify(data) }))
  }
}
describe.each(['fnosGateway', 'synologyDsm'] as const)(
  '%s transport',
  (mode) => {
    const base =
      mode === 'fnosGateway'
        ? 'http://nas.local:5666/app/motrix'
        : 'http://nas.local:5000/motrix'
    beforeEach(() => {
      Socket.opened = []
      useOperatorSession.setState({
        state: 'authenticated',
        status: { authed: true, mode, canLogout: false },
      })
    })
    afterEach(() => {
      useOperatorSession.setState({ state: 'locked' })
      vi.unstubAllGlobals()
    })

    it('marks NAS HTTP calls with their actual browser origin', async () => {
      const fetch = vi.fn().mockResolvedValue(new Response('{}'))
      const transport = new HttpWsTransport(base, {
        fetch,
      })
      await transport.invoke(Commands.PauseTask, 'task')
      expect(fetch.mock.calls[0][1].headers[WEB_ORIGIN_HEADER]).toBe(
        location.origin
      )
    })
    it('gets one fresh ticket before connecting and never includes it in the URL', async () => {
      const ticket = 'a'.repeat(32)
      const fetch = vi
        .fn()
        .mockResolvedValue(new Response(JSON.stringify({ ticket })))
      const transport = new HttpWsTransport(base, {
        fetch,
        WebSocketCtor: Socket as unknown as typeof WebSocket,
      })
      const callback = vi.fn()
      transport.on(Events.TaskUpdated, callback)
      transport.on(Events.EngineStateChanged, callback)
      await vi.waitFor(() => expect(Socket.opened).toHaveLength(1))
      expect(fetch).toHaveBeenCalledOnce()
      expect(fetch.mock.calls[0][0]).toBe(`${base}/rpc/auth/event-ticket`)
      expect(Socket.opened[0].url).toBe(
        `${base.replace('http:', 'ws:')}/rpc/events`
      )
      expect(Socket.opened[0].protocols).toEqual([
        FNOS_EVENT_PROTOCOL,
        `${FNOS_EVENT_TICKET_PREFIX}${ticket}`,
      ])
      transport.off(Events.TaskUpdated, callback)
      transport.off(Events.EngineStateChanged, callback)
    })
    it('discards late tickets after the last listener unsubscribes', async () => {
      let complete!: (response: Response) => void
      const fetch = vi.fn().mockImplementation(
        () =>
          new Promise<Response>((resolve) => {
            complete = resolve
          })
      )
      const transport = new HttpWsTransport(base, {
        fetch,
        WebSocketCtor: Socket as unknown as typeof WebSocket,
      })
      const callback = vi.fn()
      transport.on(Events.TaskUpdated, callback)
      transport.off(Events.TaskUpdated, callback)
      expect(fetch.mock.calls[0][1].signal.aborted).toBe(true)
      complete(new Response(JSON.stringify({ ticket: 'b'.repeat(32) })))
      await new Promise((resolve) => setTimeout(resolve, 0))
      expect(Socket.opened).toHaveLength(0)
    })
    it('renews DSM authority on the existing connection and still delivers events', async () => {
      const fetch = vi
        .fn()
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ ticket: 'a'.repeat(32) }))
        )
        .mockResolvedValueOnce(new Response(null, { status: 204 }))
      const transport = new HttpWsTransport(base, {
        fetch,
        WebSocketCtor: Socket as unknown as typeof WebSocket,
      })
      const task = vi.fn()
      transport.on(Events.TaskUpdated, task)
      await vi.waitFor(() => expect(Socket.opened).toHaveLength(1))
      const socket = Socket.opened[0]
      for (const listener of socket.listeners.get('open') ?? [])
        listener(new Event('open'))
      const renewal = {
        type: 'session-renewal',
        version: 1,
        challenge: 'b'.repeat(32),
      }
      socket.receive(renewal)
      if (mode === 'synologyDsm') {
        await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(2))
        expect(fetch.mock.calls[1]).toEqual([
          `${base}/rpc/auth/event-renew`,
          expect.objectContaining({
            method: 'POST',
            credentials: 'same-origin',
            headers: expect.objectContaining({
              [WEB_ORIGIN_HEADER]: location.origin,
            }),
            body: JSON.stringify(renewal),
          }),
        ])
      } else expect(fetch).toHaveBeenCalledTimes(1)
      socket.receive({ channel: Events.TaskUpdated, args: ['after renewal'] })
      expect(task).toHaveBeenCalledWith('after renewal')
      expect(transport.getConnectionState()).toBe('connected')
      expect(Socket.opened).toEqual([socket])
      transport.off(Events.TaskUpdated, task)
    })
  }
)
