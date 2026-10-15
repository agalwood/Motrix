import { expect, it, vi } from 'vitest'
import { NotificationOutbox } from '@/background/NotificationOutbox'
import type { SafariNotificationTransport } from '@/background/SafariNotificationTransport'
import type { NotificationsConfig, NotifyInput } from '@/shared/notifications'

const key = 'motrix.notificationOutbox.v1'
const source = {
  endpointId: 'server-a',
  endpointRevision: 3,
  instanceId: 'instance-a',
}
const event: NotifyInput = {
  title: 'Download complete',
  message: 'file.zip',
  severity: 'confirm',
  kind: 'task.completed',
  source,
  deduplicationKey: 'completed:task-a',
}
function fixture() {
  let clock = 1_800_000_000_000
  let data: { [key: string]: unknown } = {}
  const cfg: NotificationsConfig = {
    master: true,
    confirm: true,
    error: true,
    reminder: true,
  }
  const storage = {
    get: vi.fn(async () => structuredClone(data)),
    set: vi.fn(async (value: { [key: string]: unknown }) => {
      data = structuredClone(value)
    }),
  }
  const send = vi.fn<SafariNotificationTransport['send']>(
    async () => 'accepted'
  )
  const isCurrentSource = vi.fn(() => true)
  const deps = {
    storage,
    preferences: { get: async () => cfg },
    transport: { send },
    isCurrentSource,
    now: () => clock,
  }
  return {
    outbox: new NotificationOutbox(deps),
    restart: () => new NotificationOutbox(deps),
    storage,
    send,
    cfg,
    isCurrentSource,
    advance: (ms: number) => {
      clock += ms
    },
    state: () =>
      data[key] as {
        pending: Array<{
          id: string
          expiresAt: number
          kind: string
          notBefore?: number
          source?: typeof source
          severity: string
        }>
        receipts: Array<{ key: string; until: number }>
        failures: Array<{ key: string; until: number }>
      },
    seed: (value: unknown) => {
      data = { [key]: value }
    },
    now: () => clock,
  }
}

const failedTask: NotifyInput = {
  ...event,
  kind: 'task.failed',
  severity: 'error',
  deduplicationKey: 'failed:task-a:network',
  deduplicationMs: 600_000,
  failure: {
    taskId: 'task-a',
    progress: { bytesDone: 50, phase: 'downloading' },
  },
}
const taskProgress = {
  source,
  taskId: 'task-a',
  bytesDone: 60,
  phase: 'downloading' as const,
}

it('merges a throttled burst into one durable summary without extending its deadline', async () => {
  const f = fixture()
  f.send.mockResolvedValue('rateLimited')
  await f.outbox.enqueue(event)
  const summary = f.state().pending[0]!
  expect(summary.kind).toBe('task.summary')
  f.advance(1000)
  await f.outbox.enqueue({ ...event, deduplicationKey: 'completed:task-b' })
  expect(f.state().pending).toHaveLength(1)
  expect(f.state().pending[0]).toEqual(summary)
  expect(f.send).toHaveBeenCalledTimes(2)
  await f.restart().flush()
  expect(f.send).toHaveBeenCalledTimes(2)
  f.advance(60_001)
  f.send.mockResolvedValue('accepted')
  await f.restart().flush()
  expect(f.send).toHaveBeenCalledTimes(3)
  expect(f.send.mock.calls[2]![0]).toMatchObject({
    kind: 'task.summary',
    severity: 'confirm',
    title: 'More task updates',
    message: 'Open the task list to view details.',
  })
  expect(f.send.mock.calls[2]![1]).toBe(summary.id)
  expect(f.send.mock.calls[2]![2]?.expiresAt).toBe(summary.expiresAt)
  expect(f.state().pending).toEqual([])
})

it('keeps summaries separate by backend identity and notification category', async () => {
  const f = fixture()
  f.send.mockResolvedValue('rateLimited')
  for (const input of [
    event,
    failedTask,
    { ...event, source: { ...source, endpointId: 'server-b' } },
    { ...event, source: { ...source, endpointRevision: 4 } },
    { ...event, source: { ...source, instanceId: 'instance-b' } },
  ])
    await f.outbox.enqueue(input)
  expect(f.state().pending).toHaveLength(5)
  expect(
    new Set(
      f
        .state()
        .pending.map((record) =>
          JSON.stringify([record.source, record.severity])
        )
    ).size
  ).toBe(5)
})

it.each(['switched', 'disabled', 'expired'])(
  'drops a %s summary instead of bypassing its original delivery guards',
  async (reason) => {
    const f = fixture()
    f.send.mockResolvedValue('rateLimited')
    await f.outbox.enqueue(event)
    f.advance(reason === 'expired' ? 120_001 : 60_001)
    if (reason === 'switched') f.isCurrentSource.mockReturnValue(false)
    if (reason === 'disabled') f.cfg.confirm = false
    f.send.mockResolvedValue('accepted')
    await f.restart().flush()
    expect(f.send).toHaveBeenCalledOnce()
    expect(f.state().pending).toEqual([])
  }
)

it.each(['suppressed', 'failed', 'unknown'] as const)(
  'does not turn a %s result into a summary retry',
  async (status) => {
    const f = fixture()
    f.send.mockResolvedValue(status)
    await f.outbox.enqueue(event)
    expect(f.state().pending).toEqual([])
  }
)

it('rechecks preference changes during a rate-limit response before creating a summary', async () => {
  const f = fixture()
  f.send.mockImplementation(async () => {
    f.cfg.master = false
    return 'rateLimited'
  })
  await f.outbox.enqueue(event)
  expect(f.state().pending).toEqual([])
})

it('does not summarize unscoped task events or immediate download feedback', async () => {
  const f = fixture()
  f.send.mockResolvedValue('rateLimited')
  await f.outbox.enqueue({ ...event, source: undefined })
  await f.outbox.enqueue({
    ...event,
    kind: 'download.feedback',
    deduplicationKey: 'feedback',
  })
  expect(f.state().pending).toEqual([])
})

it('retains a summary identity through a second rate limit and expires it without an endless retry', async () => {
  const f = fixture()
  f.send.mockResolvedValue('rateLimited')
  await f.outbox.enqueue(event)
  const summary = f.state().pending[0]!
  f.advance(60_001)
  await f.restart().flush()
  expect(f.send).toHaveBeenCalledTimes(2)
  expect(f.state().pending[0]!.id).toBe(summary.id)
  expect(f.state().pending[0]!.expiresAt).toBe(summary.expiresAt)
  f.advance(60_001)
  await f.restart().flush()
  expect(f.send).toHaveBeenCalledTimes(2)
  expect(f.state().pending).toEqual([])
})

it('reuses an accepted summary identity when the JS receipt write is lost', async () => {
  const f = fixture()
  f.send.mockResolvedValue('rateLimited')
  await f.outbox.enqueue(event)
  const summary = f.state().pending[0]!
  f.advance(60_001)
  f.send.mockResolvedValue('accepted')
  f.storage.set.mockRejectedValueOnce(new Error('background stopped'))
  await expect(f.outbox.flush()).rejects.toThrow()
  f.send.mockResolvedValue('duplicate')
  await f.restart().flush()
  expect(f.send.mock.calls.slice(1).map(([, id]) => id)).toEqual([
    summary.id,
    summary.id,
  ])
  expect(f.state().pending).toEqual([])
})

it('reserves summary capacity without evicting receipts or exceeding the limit', async () => {
  const f = fixture()
  f.seed({
    pending: [],
    receipts: Array.from({ length: 4095 }, (_, index) => ({
      key: `existing-${index}`,
      until: f.now() + 600_000,
    })),
  })
  f.send.mockResolvedValue('rateLimited')
  await f.outbox.enqueue(event)
  expect(f.state().receipts).toHaveLength(4096)
  expect(f.state().pending).toEqual([])
})

it('rearms a new failed execution without clearing completion receipts or repeating the new error', async () => {
  const f = fixture()
  await f.outbox.enqueue(event)
  await f.outbox.enqueue(failedTask)
  await f.outbox.enqueue(failedTask)
  await f.outbox.observeTaskProgress({ ...taskProgress, bytesDone: 50 })
  await f.outbox.enqueue(failedTask)
  expect(f.send).toHaveBeenCalledTimes(2)
  await f.outbox.observeTaskProgress(taskProgress)
  const next = {
    ...failedTask,
    failure: {
      taskId: 'task-a',
      progress: { bytesDone: 60, phase: 'downloading' as const },
    },
  }
  await f.outbox.enqueue(next)
  await f.outbox.observeTaskProgress(taskProgress)
  await f.outbox.enqueue(next)
  await f.outbox.enqueue(event)
  expect(f.send).toHaveBeenCalledTimes(3)
  expect(f.send.mock.calls[1]![1]).not.toBe(f.send.mock.calls[2]![1])
  expect(JSON.stringify(f.state())).not.toContain('task-a')
})

it('restores the failure progress baseline across background restarts', async () => {
  const f = fixture()
  await f.outbox.enqueue(failedTask)
  await f.restart().observeTaskProgress({
    ...taskProgress,
    source: {
      instanceId: source.instanceId,
      endpointRevision: source.endpointRevision,
      endpointId: source.endpointId,
    },
  })
  await f.restart().enqueue(failedTask)
  expect(f.send).toHaveBeenCalledTimes(2)
})

it('does not rearm on queued or unchanged ticks, but recognizes work after restarting from zero', async () => {
  const f = fixture()
  await f.outbox.enqueue(failedTask)
  await f.outbox.observeTaskProgress({
    ...taskProgress,
    bytesDone: 0,
    phase: 'queued',
  })
  await f.outbox.observeTaskProgress({ ...taskProgress, bytesDone: 0 })
  await f.outbox.enqueue(failedTask)
  expect(f.send).toHaveBeenCalledOnce()
  await f.outbox.observeTaskProgress({ ...taskProgress, bytesDone: 1 })
  await f.outbox.enqueue(failedTask)
  expect(f.send).toHaveBeenCalledTimes(2)
})

it('requires observed advancement when an earlier failure had no progress snapshot', async () => {
  const f = fixture()
  const input = { ...failedTask, failure: { taskId: 'task-a' } }
  await f.outbox.enqueue(input)
  await f.outbox.observeTaskProgress(taskProgress)
  await f.outbox.enqueue(input)
  expect(f.send).toHaveBeenCalledOnce()
  await f.outbox.observeTaskProgress({ ...taskProgress, bytesDone: 61 })
  await f.outbox.enqueue(input)
  expect(f.send).toHaveBeenCalledTimes(2)
})

it('recognizes forward muxing/finalizing stages without treating a repeated stage as another run', async () => {
  const f = fixture()
  await f.outbox.enqueue(failedTask)
  await f.outbox.observeTaskProgress({
    ...taskProgress,
    bytesDone: 50,
    phase: 'muxing',
  })
  const input = {
    ...failedTask,
    failure: {
      taskId: 'task-a',
      progress: { bytesDone: 50, phase: 'muxing' as const },
    },
  }
  await f.outbox.enqueue(input)
  await f.outbox.observeTaskProgress({
    ...taskProgress,
    bytesDone: 50,
    phase: 'muxing',
  })
  await f.outbox.enqueue(input)
  expect(f.send).toHaveBeenCalledTimes(2)
})

it.each(['task', 'endpoint', 'revision', 'instance', 'stale', 'untrusted'])(
  'does not let %s progress clear another failure cooldown',
  async (reason) => {
    const f = fixture()
    await f.outbox.enqueue(failedTask)
    await f.outbox.observeTaskProgress({
      ...taskProgress,
      taskId: reason === 'task' ? 'task-b' : 'task-a',
      source: {
        ...source,
        ...(reason === 'endpoint' ? { endpointId: 'server-b' } : {}),
        ...(reason === 'revision' ? { endpointRevision: 4 } : {}),
        ...(reason === 'instance' ? { instanceId: 'instance-b' } : {}),
        ...(reason === 'untrusted' ? { instanceId: null } : {}),
      },
      isCurrent: () => reason !== 'stale',
    })
    await f.outbox.enqueue(failedTask)
    expect(f.send).toHaveBeenCalledOnce()
  }
)

it('rechecks the source after reading persisted failure state', async () => {
  const f = fixture()
  await f.outbox.enqueue(failedTask)
  const get = f.storage.get.getMockImplementation()!
  f.storage.get.mockImplementationOnce(async () => {
    f.isCurrentSource.mockReturnValue(false)
    return get()
  })
  await f.restart().observeTaskProgress(taskProgress)
  f.isCurrentSource.mockReturnValue(true)
  await f.outbox.enqueue(failedTask)
  expect(f.send).toHaveBeenCalledOnce()
})

it('keeps suppression durable when saving a cooldown reset fails', async () => {
  const f = fixture()
  await f.outbox.enqueue(failedTask)
  f.storage.set.mockRejectedValueOnce(new Error('storage unavailable'))
  await expect(f.outbox.observeTaskProgress(taskProgress)).rejects.toThrow()
  await f.restart().enqueue(failedTask)
  expect(f.send).toHaveBeenCalledOnce()
  await f.outbox.observeTaskProgress(taskProgress)
  await f.outbox.enqueue(failedTask)
  expect(f.send).toHaveBeenCalledTimes(2)
})

it('does not read or write storage on every unrelated progress tick', async () => {
  const f = fixture()
  await f.outbox.observeTaskProgress(taskProgress)
  expect(f.storage.get).toHaveBeenCalledOnce()
  for (let index = 0; index < 20; index++) {
    await f.outbox.observeTaskProgress({ ...taskProgress, bytesDone: index })
  }
  expect(f.storage.get).toHaveBeenCalledOnce()
  expect(f.storage.set).not.toHaveBeenCalled()
})

it('drops an obsolete pending failure after real progress instead of replaying it', async () => {
  const f = fixture()
  f.send.mockRejectedValueOnce(new Error('background stopped'))
  await expect(f.outbox.enqueue(failedTask)).rejects.toThrow()
  const previousId = f.state().pending[0]!.id
  const restored = f.restart()
  await restored.observeTaskProgress(taskProgress)
  await restored.flush()
  expect(f.state().pending).toEqual([])
  expect(f.send).toHaveBeenCalledOnce()
  await restored.enqueue(failedTask)
  expect(f.send).toHaveBeenCalledTimes(2)
  expect(f.send.mock.calls[1]![1]).not.toBe(previousId)
})

it('bounds the durable failure index without evicting other cooldowns', async () => {
  const f = fixture()
  f.seed({
    pending: [],
    receipts: [],
    failures: Array.from({ length: 4096 }, (_, index) => ({
      key: `existing-${index}`,
      progress: null,
      until: f.now() + 600_000,
    })),
  })
  await f.outbox.enqueue(failedTask)
  expect(f.state().failures).toHaveLength(4096)
  expect(f.send).toHaveBeenCalledOnce()
})

it('persists before native delivery and deduplicates by source and logical event', async () => {
  const f = fixture()
  f.send.mockImplementation(async (_, id) => {
    expect(f.state().pending.some((record) => record.id === id)).toBe(true)
    return 'accepted'
  })
  await f.outbox.enqueue(event)
  await f.outbox.enqueue(event)
  await f.outbox.enqueue({
    ...event,
    source: { ...source, endpointId: 'server-b' },
  })
  await f.outbox.enqueue({
    ...event,
    source: { ...source, endpointRevision: 4 },
  })
  await f.outbox.enqueue({
    ...event,
    source: { ...source, instanceId: 'instance-b' },
  })
  expect(f.send).toHaveBeenCalledTimes(4)
  expect(f.state().pending).toEqual([])
  expect(JSON.stringify(f.state())).not.toContain('task-a')
})

it('replays the durable event ID and original expiry after native acceptance but a lost JS receipt write', async () => {
  const f = fixture()
  const write = f.storage.set.getMockImplementation()!
  f.storage.set
    .mockImplementationOnce(write)
    .mockRejectedValueOnce(new Error('background stopped'))
  await expect(f.outbox.enqueue(event)).rejects.toThrow('background stopped')
  const persisted = f.state().pending[0]!
  f.advance(30_000)
  f.send.mockResolvedValue('duplicate')
  await f.restart().flush()
  expect(f.send).toHaveBeenCalledTimes(2)
  for (const [input, id, options] of f.send.mock.calls) {
    expect(input.kind).toBe('task.completed')
    expect(id).toBe(persisted.id)
    expect(options?.expiresAt).toBe(persisted.expiresAt)
  }
  expect(f.state().pending).toEqual([])
  await f.restart().enqueue(event)
  expect(f.send).toHaveBeenCalledTimes(2)
})

it('does not send when the durable write fails', async () => {
  const f = fixture()
  f.storage.set.mockRejectedValueOnce(new Error('storage unavailable'))
  await expect(f.outbox.enqueue(event)).rejects.toThrow()
  expect(f.send).not.toHaveBeenCalled()
  await f.outbox.enqueue(event)
  expect(f.send).toHaveBeenCalledOnce()
})

it.each(['switched', 'disabled', 'expired', 'unscoped'])(
  'drops a restored %s event without delivering or extending its lifetime',
  async (reason) => {
    const f = fixture()
    f.send.mockRejectedValueOnce(new Error('background stopped'))
    await expect(
      f.outbox.enqueue(
        reason === 'unscoped' ? { ...event, source: undefined } : event
      )
    ).rejects.toThrow()
    if (reason === 'switched') f.isCurrentSource.mockReturnValue(false)
    if (reason === 'disabled') f.cfg.master = false
    if (reason === 'expired') f.advance(120_001)
    await f.restart().flush()
    expect(f.send).toHaveBeenCalledOnce()
    expect(f.state().pending).toEqual([])
    f.cfg.master = true
    f.isCurrentSource.mockReturnValue(true)
    if (reason !== 'unscoped') await f.restart().enqueue(event)
    expect(f.send).toHaveBeenCalledOnce()
  }
)

it('rechecks live source and preferences when transport finishes capability negotiation', async () => {
  const f = fixture()
  let current = true
  f.send.mockImplementation(async (_, __, options) => {
    expect(await options?.canSend?.()).toBe(true)
    f.cfg.confirm = false
    expect(await options?.canSend?.()).toBe(false)
    f.cfg.confirm = true
    current = false
    expect(await options?.canSend?.()).toBe(false)
    return 'suppressed'
  })
  await f.outbox.enqueue({ ...event, isCurrent: () => current })
  expect(f.send).toHaveBeenCalledOnce()
})

it('does not retry an unknown terminal result indefinitely', async () => {
  const f = fixture()
  f.send.mockResolvedValue('unknown')
  await f.outbox.enqueue(event)
  await f.outbox.flush()
  await f.restart().enqueue(event)
  expect(f.send).toHaveBeenCalledOnce()
})

it('expires the error deduplication window without suppressing later independent failures', async () => {
  const f = fixture()
  const error: NotifyInput = {
    ...event,
    severity: 'error',
    deduplicationMs: 600_000,
  }
  await f.outbox.enqueue(error)
  f.advance(599_999)
  await f.outbox.enqueue(error)
  expect(f.send).toHaveBeenCalledOnce()
  f.advance(2)
  await f.outbox.enqueue(error)
  expect(f.send).toHaveBeenCalledTimes(2)
})

it('bounds pending work when delivery keeps failing', async () => {
  const f = fixture()
  f.send.mockRejectedValue(new Error('transport stopped'))
  for (let index = 0; index < 70; index++) {
    await f.outbox
      .enqueue({ ...event, deduplicationKey: `task-${index}` })
      .catch(() => {})
  }
  expect(f.state().pending).toHaveLength(64)
})

it('bounds in-memory admissions while the first storage read is stalled', async () => {
  const f = fixture()
  let resume!: () => void
  f.storage.get.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        resume = () => resolve({})
      })
  )
  const requests = Array.from({ length: 70 }, (_, index) =>
    f.outbox.enqueue({
      ...event,
      deduplicationKey: `task-${index}`,
    })
  )
  await vi.waitFor(() => expect(resume).toBeDefined())
  resume()
  await Promise.all(requests)
  expect(f.send).toHaveBeenCalledTimes(64)
  await f.outbox.enqueue({ ...event, deduplicationKey: 'new-task' })
  expect(f.send).toHaveBeenCalledTimes(65)
})

it('reserves receipt capacity without evicting recent receipts to admit new events', async () => {
  const f = fixture()
  f.seed({
    pending: [],
    receipts: Array.from({ length: 4095 }, (_, i) => ({
      key: `old-${i}`,
      until: f.now() + 1000,
    })),
  })
  await f.outbox.enqueue(event)
  await f.outbox.enqueue({ ...event, deduplicationKey: 'another-task' })
  expect(f.state().receipts).toHaveLength(4096)
  expect(f.send).toHaveBeenCalledOnce()
  f.advance(1001)
  await f.outbox.enqueue({ ...event, deduplicationKey: 'another-task' })
  expect(f.send).toHaveBeenCalledTimes(2)
})

it('serializes concurrent duplicate events and bounds sanitized text before persistence', async () => {
  const f = fixture()
  const input = {
    ...event,
    title: `\u202e${'😀'.repeat(150)}`,
    message: 'ملف\u0000.zip',
  }
  await Promise.all(Array.from({ length: 10 }, () => f.outbox.enqueue(input)))
  expect(f.send).toHaveBeenCalledOnce()
  expect(f.send.mock.calls[0]![0]).toMatchObject({
    title: '😀'.repeat(120),
    message: 'ملف .zip',
  })
})
