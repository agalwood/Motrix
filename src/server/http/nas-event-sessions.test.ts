import {
  FNOS_EVENT_PROTOCOL,
  FNOS_EVENT_TICKET_PREFIX,
  WEB_ORIGIN_HEADER,
} from '@shared/schemas/operator-auth'
import type { WebEventRenewal } from '@shared/schemas/web-event-stream'
import Fastify from 'fastify'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { NasIdentity } from '../platform/nas/identity'
import { registerNasAuth } from './nas-auth'
import { NAS_EVENT_AUTH_MS, NasEventSessions } from './nas-event-sessions'

const origin = 'https://nas.example:5001'
const owner: NasIdentity = {
  platform: 'synology',
  userId: '4',
  username: 'alice',
  administrator: true,
  accountRevision: 'epoch-a',
}
beforeEach(() =>
  vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] })
)
afterEach(() => vi.useRealTimers())

function fixture(renewable = true) {
  const sessions = new NasEventSessions(Date.now)
  const frames: WebEventRenewal[] = []
  const socket = {
    send: vi.fn((data: string, done: (err?: Error) => void) => {
      frames.push(JSON.parse(data))
      done()
    }),
    close: vi.fn(),
  }
  const bound = sessions.bind(
    socket,
    Date.now() + NAS_EVENT_AUTH_MS,
    owner,
    renewable ? origin : undefined
  )
  return { sessions, socket, bound, frames }
}

it('renews the same socket repeatedly with single-use, origin-bound challenges', () => {
  const { sessions, socket, bound, frames } = fixture()
  for (let round = 0; round < 3; round++) {
    vi.advanceTimersByTime(45_000)
    const c = frames[round].challenge
    expect(sessions.renew(c, 'https://other.example', owner)).toBe(false)
    expect(sessions.renew(c, origin, owner)).toBe(true)
    expect(sessions.renew(c, origin, owner)).toBe(false)
    expect(bound.eligible()).toBe(true)
  }
  expect(new Set(frames.map((f) => f.challenge)).size).toBe(3)
  expect(socket.close).not.toHaveBeenCalled()
  bound.dispose()
})

it.each([
  { userId: '5' },
  { username: 'bob' },
  { accountRevision: 'epoch-b' },
  { administrator: false },
])('closes on a different DSM principal: %o', (changed) => {
  const { sessions, socket, bound, frames } = fixture()
  vi.advanceTimersByTime(45_000)
  expect(
    sessions.renew(frames[0].challenge, origin, { ...owner, ...changed })
  ).toBe(false)
  expect(bound.eligible()).toBe(false)
  expect(socket.close).toHaveBeenCalledWith(4401, expect.any(String))
})

it.each(['disposed', 'expired', 'delayed timer'] as const)(
  'cannot renew a %s socket',
  (reason) => {
    const { sessions, socket, bound, frames } = fixture()
    vi.advanceTimersByTime(45_000)
    if (reason === 'disposed') bound.dispose()
    else if (reason === 'expired') vi.advanceTimersByTime(15_000)
    else vi.setSystemTime(Date.now() + 15_000)
    expect(bound.eligible()).toBe(false)
    expect(sessions.renew(frames[0].challenge, origin, owner)).toBe(false)
    expect(socket.close).toHaveBeenCalledTimes(reason === 'disposed' ? 0 : 1)
  }
)

it('leaves a gateway without renewal support on its original deadline', () => {
  const { socket, bound, frames } = fixture(false)
  vi.advanceTimersByTime(NAS_EVENT_AUTH_MS)
  expect(frames).toHaveLength(0)
  expect(bound.eligible()).toBe(false)
  expect(socket.close).toHaveBeenCalledTimes(1)
})

it('renewing one tab cannot extend the other tab’s deadline', () => {
  const { sessions, socket, bound, frames } = fixture()
  const other = { send: vi.fn(), close: vi.fn() }
  const second = sessions.bind(
    other,
    Date.now() + NAS_EVENT_AUTH_MS,
    owner,
    origin
  )
  vi.advanceTimersByTime(45_000)
  expect(sessions.renew(frames[0].challenge, origin, owner)).toBe(true)
  vi.advanceTimersByTime(15_000)
  expect(second.eligible()).toBe(false)
  expect(other.close).toHaveBeenCalledOnce()
  expect(bound.eligible()).toBe(true)
  expect(socket.close).not.toHaveBeenCalled()
  bound.dispose()
})

it('uses current HTTP credentials to renew and closes on logout or account switch', async () => {
  const app = Fastify()
  const policy = registerNasAuth(app, {
    mode: 'synologyDsm',
    isListener: () => true,
    hasIdentity: () => true,
    authenticate: (req) =>
      req.headers.cookie === 'valid'
        ? owner
        : req.headers.cookie === 'other'
          ? { ...owner, userId: '9', username: 'bob' }
          : undefined,
  })
  let frame: WebEventRenewal | undefined
  const socket = {
    close: vi.fn(),
    send: (s: string, done: (error?: Error) => void) => {
      frame = JSON.parse(s)
      done()
    },
  }
  let bound: ReturnType<typeof policy.bindSocket> | undefined
  app.get('/rpc/events', async (req) => {
    bound = policy.bindSocket(req, socket)
    return { ok: true }
  })
  const headers = { cookie: 'valid', origin, [WEB_ORIGIN_HEADER]: origin }
  const post = (cookie: string, pageOrigin = origin) =>
    app.inject({
      method: 'POST',
      url: '/rpc/auth/event-renew',
      headers: { cookie, origin: pageOrigin, [WEB_ORIGIN_HEADER]: pageOrigin },
      payload: frame,
    })
  try {
    for (const [cookie, deniedStatus] of [
      ['expired', 401],
      ['other', 403],
    ] as const) {
      const { ticket } = (
        await app.inject({
          method: 'POST',
          url: '/rpc/auth/event-ticket',
          headers,
        })
      ).json()
      expect(
        (
          await app.inject({
            url: '/rpc/events',
            headers: {
              ...headers,
              upgrade: 'websocket',
              'sec-websocket-protocol': `${FNOS_EVENT_PROTOCOL}, ${FNOS_EVENT_TICKET_PREFIX}${ticket}`,
            },
          })
        ).statusCode
      ).toBe(200)
      vi.advanceTimersByTime(45_000)
      expect(
        (await post('valid', 'https://different.example')).statusCode
      ).toBe(403)
      expect((await post('valid')).statusCode).toBe(204)
      expect((await post('valid')).statusCode).toBe(403)
      vi.advanceTimersByTime(45_000)
      expect(bound?.eligible()).toBe(true)
      expect((await post(cookie)).statusCode).toBe(deniedStatus)
      expect(bound?.eligible()).toBe(false)
      expect(socket.close).toHaveBeenCalledWith(4401, expect.any(String))
      bound?.dispose()
    }
  } finally {
    bound?.dispose()
    await app.close()
  }
})
