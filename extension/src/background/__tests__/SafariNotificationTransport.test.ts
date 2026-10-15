import { afterEach, expect, it, vi } from 'vitest'
import {
  notificationText,
  SafariNotificationTransport,
} from '@/background/SafariNotificationTransport'
import { NOTIFICATION_KINDS } from '@/shared/notifications'

const notice = {
  title: 'Completed',
  message: 'file.zip',
  severity: 'confirm' as const,
  kind: 'task.completed' as const,
}
function reply(
  request: Record<string, unknown>,
  overrides: Record<string, unknown> = {}
) {
  return {
    action: request.action,
    requestId: request.requestId,
    protocolVersion: 1,
    notificationVersion: 1,
    authorization: 'authorized',
    delivery: 'direct',
    status: 'accepted',
    ...overrides,
  }
}
afterEach(() => vi.useRealTimers())

it('reports only explicit native rate limits as eligible for a later summary', async () => {
  for (const [status, reason, expected] of [
    ['suppressed', 'rateLimited', 'rateLimited'],
    ['suppressed', undefined, 'suppressed'],
    ['accepted', 'rateLimited', 'accepted'],
  ]) {
    const native = vi.fn(async (request) => reply(request, { status, reason }))
    expect(
      await new SafariNotificationTransport(native, () => true).send(notice)
    ).toBe(expected)
    expect(native).toHaveBeenCalledTimes(2)
  }
})

it.each(NOTIFICATION_KINDS)(
  'preserves the %s business kind independently of severity',
  async (kind) => {
    const native = vi.fn(async (request) => reply(request))
    const transport = new SafariNotificationTransport(native, () => true)
    expect(
      await transport.send({ ...notice, kind, severity: 'reminder' })
    ).toBe('accepted')
    expect(native).toHaveBeenLastCalledWith(
      expect.objectContaining({
        action: 'notifications.send',
        kind,
      })
    )
  }
)

it('uses a bounded feedback kind for existing download notices', async () => {
  const native = vi.fn(async (request) => reply(request))
  await new SafariNotificationTransport(native, () => true).send({
    title: 'Download',
    message: 'Submitted',
    severity: 'confirm',
  })
  expect(native).toHaveBeenLastCalledWith(
    expect.objectContaining({ kind: 'download.feedback' })
  )
})

it('does not contact a native host for a temporary extension', async () => {
  const native = vi.fn()
  const transport = new SafariNotificationTransport(native, () => false)
  expect(await transport.send(notice)).toBe('suppressed')
  expect(native).not.toHaveBeenCalled()
})

it.each(['notDetermined', 'denied', 'unavailable'])(
  'never requests authorization or sends when permission is %s',
  async (authorization) => {
    const native = vi.fn(async (request) => reply(request, { authorization }))
    expect(
      await new SafariNotificationTransport(native, () => true).send(notice)
    ).toBe('suppressed')
    expect(native).toHaveBeenCalledTimes(1)
    expect(native.mock.calls[0]![0].action).toBe('notifications.status')
  }
)

it('keeps an older native prototype unavailable even when permission is authorized', async () => {
  const native = vi.fn(async (request) =>
    reply(request, { delivery: undefined })
  )
  expect(
    await new SafariNotificationTransport(native, () => true).capability()
  ).toEqual({ available: false, authorization: 'authorized' })
})

it('correlates replies and rejects an incompatible native version', async () => {
  for (const overrides of [
    { requestId: crypto.randomUUID() },
    { action: 'bootstrap' },
    { notificationVersion: 2 },
  ]) {
    const transport = new SafariNotificationTransport(
      async (request) => reply(request, overrides),
      () => true
    )
    expect(await transport.capability()).toEqual({
      available: false,
      authorization: 'unavailable',
    })
  }
})

it('retries a lost reply once using the same event identity and expiry', async () => {
  let attempts = 0
  const native = vi.fn(async (request) => {
    if (request.action === 'notifications.send' && ++attempts === 1)
      throw new Error('lost reply')
    return reply(request)
  })
  const transport = new SafariNotificationTransport(native, () => true)
  expect(await transport.send(notice)).toBe('accepted')
  const sends = native.mock.calls
    .map(([request]) => request)
    .filter((request) => request.action === 'notifications.send')
  expect(sends).toHaveLength(2)
  expect(sends[0]!.eventId).toBe(sends[1]!.eventId)
  expect(sends[0]!.expiresAt).toBe(sends[1]!.expiresAt)
  expect(sends[0]!.requestId).not.toBe(sends[1]!.requestId)
})

it('reports unknown after bounded delivery failures and does not throw into downloads', async () => {
  const native = vi.fn(async (request) => {
    if (request.action === 'notifications.send')
      throw new Error('private native error')
    return reply(request)
  })
  expect(
    await new SafariNotificationTransport(native, () => true).send(notice)
  ).toBe('unknown')
  expect(native).toHaveBeenCalledTimes(3)
})

it('bounds a nonresponsive native host', async () => {
  vi.useFakeTimers()
  const transport = new SafariNotificationTransport(
    () => new Promise(() => {}),
    () => true
  )
  const pending = transport.capability()
  await vi.advanceTimersByTimeAsync(3001)
  expect(await pending).toEqual({
    available: false,
    authorization: 'unavailable',
  })
})

it('strips control and direction overrides without breaking emoji or RTL text', () => {
  expect(notificationText('\u202efile\n.zip\u0000', 300)).toBe('file .zip')
  expect(notificationText('😀'.repeat(121), 120)).toBe('😀'.repeat(120))
  expect(notificationText('ملف.zip', 120)).toBe('ملف.zip')
})

it.each(['scope', 'preference', 'expiry'])(
  'rechecks %s after awaiting native capabilities',
  async (reason) => {
    let current = true
    let enabled = true
    let expire = Date.now() + 120_000
    const native = vi.fn(async (request) => {
      if (reason === 'scope') current = false
      if (reason === 'preference') enabled = false
      return reply(request)
    })
    if (reason === 'expiry') expire = Date.now() - 1
    expect(
      await new SafariNotificationTransport(native, () => true).send(
        { ...notice, isCurrent: () => current },
        crypto.randomUUID(),
        { expiresAt: expire, canSend: async () => enabled }
      )
    ).toBe('suppressed')
    expect(native).toHaveBeenCalledOnce()
    expect(native.mock.calls[0]![0].action).toBe('notifications.status')
  }
)

it('does not retry after the source changes during a lost native reply', async () => {
  let current = true
  const native = vi.fn(async (request) => {
    if (request.action === 'notifications.send') {
      current = false
      throw new Error('lost reply')
    }
    return reply(request)
  })
  expect(
    await new SafariNotificationTransport(native, () => true).send({
      ...notice,
      isCurrent: () => current,
    })
  ).toBe('suppressed')
  expect(
    native.mock.calls.filter(
      ([request]) => request.action === 'notifications.send'
    )
  ).toHaveLength(1)
})

it('uses fixed test and settings messages without accepting caller-controlled content', async () => {
  const native = vi.fn(async (request) =>
    reply(request, {
      status:
        request.action === 'notifications.openSettings' ? 'opened' : 'accepted',
    })
  )
  const transport = new SafariNotificationTransport(native, () => true)
  expect(await transport.test()).toBe('accepted')
  expect(await transport.openSettings()).toBe(true)
  for (const [request] of native.mock.calls) {
    expect(Object.keys(request).sort()).toEqual([
      'action',
      'notificationVersion',
      'protocolVersion',
      'requestId',
    ])
  }
})

it('does not retry a test when its reply is lost', async () => {
  const native = vi.fn(async (request) => {
    if (request.action === 'notifications.test') throw new Error('lost reply')
    return reply(request)
  })
  expect(await new SafariNotificationTransport(native, () => true).test()).toBe(
    'unknown'
  )
  expect(
    native.mock.calls.filter(
      ([request]) => request.action === 'notifications.test'
    )
  ).toHaveLength(1)
})

it('does not expose test or settings actions for an unverified candidate host', async () => {
  const native = vi.fn(async (request) =>
    reply(request, { delivery: undefined })
  )
  const transport = new SafariNotificationTransport(native, () => true)
  expect(await transport.test()).toBe('suppressed')
  expect(await transport.openSettings()).toBe(false)
  expect(
    native.mock.calls.every(
      ([request]) => request.action === 'notifications.status'
    )
  ).toBe(true)
})
