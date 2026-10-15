import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { makeBadgeNotify } from '@/background/badge/BadgeController'
import { NotificationsConfigStore } from '@/background/NotificationsConfigStore'
import { createNotify } from '@/background/notify'
import { extensionBrowser as browser } from '@/shared/browser'
import type { NotifyInput } from '@/shared/notifications'

vi.mock('@/shared/browserKind', () => ({ getBuildBrowser: () => 'safari' }))
vi.mock('@/shared/safariNative', () => ({
  hasPackagedSafariNativeMessaging: () => true,
}))

let stored: Record<string, unknown>
afterEach(() => vi.useRealTimers())
beforeEach(() => {
  stored = {}
  vi.mocked(browser.storage.local.get).mockImplementation(async () =>
    structuredClone(stored)
  )
  vi.mocked(browser.storage.local.set).mockImplementation(async (items) => {
    Object.assign(stored, structuredClone(items))
  })
  vi.mocked(browser.runtime.sendNativeMessage).mockImplementation(
    async (_, input) => ({
      ...input,
      authorization: 'authorized',
      delivery: 'direct',
      status: 'accepted',
    })
  )
})

it('keeps default and migrated Safari settings silent until an explicit opt-in', async () => {
  const store = new NotificationsConfigStore()
  const notify = createNotify(store)
  const input = {
    title: 'Download failed',
    message: 'See task details',
    severity: 'error' as const,
    kind: 'task.failed' as const,
  }
  notify(input)
  await notify.flush()
  stored['motrix.notificationsConfig'] = {
    master: true,
    confirm: true,
    error: true,
    reminder: true,
  }
  notify(input)
  await notify.flush()
  expect(browser.runtime.sendNativeMessage).not.toHaveBeenCalled()
  await store.set({ master: true, confirm: true, error: true, reminder: true })
  notify(input)
  await notify.flush()
  expect(browser.runtime.sendNativeMessage).toHaveBeenCalledTimes(2)
  expect(browser.notifications.create).not.toHaveBeenCalled()
  expect(browser.runtime.sendNativeMessage).toHaveBeenLastCalledWith(
    'app.motrix.bridge',
    expect.objectContaining({
      action: 'notifications.send',
      kind: 'task.failed',
      body: 'See task details',
      eventId: expect.any(String),
    })
  )
})

it('does not contact the host when the connection changes during preference lookup', async () => {
  let current = true
  const notify = createNotify({
    get: async () => {
      current = false
      return { master: true, confirm: true, error: true, reminder: true }
    },
  })
  notify({
    title: 'Complete',
    message: 'file.zip',
    severity: 'confirm',
    isCurrent: () => current,
  })
  await notify.flush()
  expect(browser.runtime.sendNativeMessage).not.toHaveBeenCalled()
})

it('delivers a later retry failure through the production badge wrapper without sending task metadata to native', async () => {
  const source = {
    endpointId: 'server',
    endpointRevision: 1,
    instanceId: 'instance',
  }
  const platform = createNotify(
    {
      get: async () => ({
        master: true,
        confirm: true,
        error: true,
        reminder: true,
      }),
    },
    () => true
  )
  const notify = makeBadgeNotify(platform, {
    markError: vi.fn(async () => {}),
    clearError: vi.fn(async () => {}),
  })
  const failure: NotifyInput = {
    title: 'Failed',
    message: 'See task details',
    severity: 'error',
    kind: 'task.failed',
    source,
    deduplicationKey: 'failed:task-a:network',
    deduplicationMs: 600_000,
    failure: {
      taskId: 'task-a',
      progress: { bytesDone: 40, phase: 'downloading' },
    },
  }
  notify(failure)
  notify(failure)
  await platform.flush()
  notify.taskProgress?.({
    source,
    taskId: 'task-a',
    bytesDone: 50,
    phase: 'downloading',
  })
  notify(failure)
  await platform.flush()
  const sent = vi
    .mocked(browser.runtime.sendNativeMessage)
    .mock.calls.map(([, request]) => request)
    .filter((request) => request.action === 'notifications.send')
  expect(sent).toHaveLength(2)
  expect(sent[0].eventId).not.toBe(sent[1].eventId)
  for (const request of sent) {
    expect(request).not.toHaveProperty('source')
    expect(request).not.toHaveProperty('failure')
    expect(JSON.stringify(request)).not.toContain('task-a')
  }
})

it('turns explicit native throttling into one later summary on a natural wakeup', async () => {
  vi.useFakeTimers()
  vi.setSystemTime(1_800_000_000_000)
  vi.mocked(browser.runtime.sendNativeMessage).mockImplementation(
    async (_, input) => ({
      ...input,
      authorization: 'authorized',
      delivery: 'direct',
      ...(input.action === 'notifications.send' && input.kind !== 'task.summary'
        ? { status: 'suppressed', reason: 'rateLimited' }
        : { status: 'accepted' }),
    })
  )
  const source = {
    endpointId: 'server',
    endpointRevision: 1,
    instanceId: 'instance',
  }
  const notify = createNotify(
    {
      get: async () => ({
        master: true,
        confirm: true,
        error: true,
        reminder: true,
      }),
    },
    () => true
  )
  for (const taskId of ['a', 'b'])
    notify({
      title: 'Complete',
      message: `private-${taskId}.zip`,
      kind: 'task.completed',
      severity: 'confirm',
      source,
      deduplicationKey: `completed:${taskId}`,
    })
  await notify.flush()
  vi.setSystemTime(Date.now() + 60_001)
  await notify.flush()
  const summaries = vi
    .mocked(browser.runtime.sendNativeMessage)
    .mock.calls.map(([, input]) => input)
    .filter(
      (input) =>
        input.action === 'notifications.send' && input.kind === 'task.summary'
    )
  expect(summaries).toHaveLength(1)
  expect(summaries[0]).toMatchObject({
    title: 'More task updates',
    body: 'Open the task list to view details.',
  })
  expect(JSON.stringify(summaries)).not.toContain('private-')
})
