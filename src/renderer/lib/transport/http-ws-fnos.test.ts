import { useOperatorSession } from '@renderer/lib/operator-auth'
import { Commands } from '@shared/protocol/commands'
import { Events } from '@shared/protocol/events'
import {
  FNOS_EVENT_PROTOCOL,
  FNOS_EVENT_TICKET_PREFIX,
  WEB_ORIGIN_HEADER,
} from '@shared/schemas/operator-auth'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
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
}
beforeEach(() => {
  Socket.opened = []
  useOperatorSession.setState({
    state: 'authenticated',
    status: { authed: true, mode: 'fnosGateway', canLogout: false },
  })
})
afterEach(() => {
  useOperatorSession.setState({ state: 'locked' })
  vi.unstubAllGlobals()
})

it('marks fnOS HTTP calls with their actual browser origin', async () => {
  const fetch = vi.fn().mockResolvedValue(new Response('{}'))
  const transport = new HttpWsTransport('http://nas.local:5666/app/motrix', {
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
  const transport = new HttpWsTransport('http://nas.local:5666/app/motrix', {
    fetch,
    WebSocketCtor: Socket as unknown as typeof WebSocket,
  })
  const callback = vi.fn()
  transport.on(Events.TaskUpdated, callback)
  transport.on(Events.EngineStateChanged, callback)
  await vi.waitFor(() => expect(Socket.opened).toHaveLength(1))
  expect(fetch).toHaveBeenCalledOnce()
  expect(fetch.mock.calls[0][0]).toBe(
    'http://nas.local:5666/app/motrix/rpc/auth/event-ticket'
  )
  expect(Socket.opened[0].url).toBe('ws://nas.local:5666/app/motrix/rpc/events')
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
  const transport = new HttpWsTransport('http://nas.local:5666/app/motrix', {
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
