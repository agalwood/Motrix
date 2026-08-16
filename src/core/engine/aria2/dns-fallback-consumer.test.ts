import { DownloadErrorCode } from '@shared/errors'
import type { DnsResolutionMode } from '@shared/types/settings'
import { TaskStatus } from '@shared/types/task'
import type { TaskTerminalOccurrence } from '@shared/types/task-occurrence'
import { describe, expect, it, vi } from 'vitest'
import { createDnsFallbackConsumer } from './dns-fallback'

const DNS_MESSAGE =
  'CUID#11 - Name resolution for mikanani.me failed:Could not contact DNS servers'

function makeOccurrence(
  overrides?: Partial<TaskTerminalOccurrence>
): TaskTerminalOccurrence {
  return {
    occurrenceId: 'task-1:error:1000',
    type: 'terminal',
    taskId: 'task-1',
    fromStatus: TaskStatus.Downloading,
    toStatus: TaskStatus.Error,
    cause: 'engine',
    errorGroup: {
      errorCode: DownloadErrorCode.NetworkError,
      errorMessage: DNS_MESSAGE,
      errorDetailKey: null,
      errorDetailParams: null,
    },
    createdAt: 2000,
    ...overrides,
  }
}

function makeHarness(overrides?: {
  dnsMode?: DnsResolutionMode
  taskStatus?: TaskStatus | null
  startedAt?: number
}) {
  const applyAsyncDns = vi.fn().mockResolvedValue(undefined)
  const reAddTask = vi.fn().mockResolvedValue(undefined)
  const notify = vi.fn()
  const log = { info: vi.fn(), warn: vi.fn() }
  const consumer = createDnsFallbackConsumer({
    getDnsMode: () => overrides?.dnsMode ?? 'auto',
    getTaskStatus: () =>
      overrides?.taskStatus === undefined
        ? TaskStatus.Error
        : overrides.taskStatus,
    getTaskName: () => 'My Download',
    applyAsyncDns,
    reAddTask,
    notify,
    log,
    now: () => overrides?.startedAt ?? 1000,
  })
  return { consumer, applyAsyncDns, reAddTask, notify, log }
}

describe('createDnsFallbackConsumer', () => {
  it('falls back to the system resolver and retries the task once', async () => {
    const { consumer, applyAsyncDns, reAddTask, notify } = makeHarness()

    await consumer.consume(makeOccurrence())

    expect(applyAsyncDns).toHaveBeenCalledExactlyOnceWith(false)
    expect(reAddTask).toHaveBeenCalledExactlyOnceWith('task-1')
    expect(notify).toHaveBeenCalledOnce()
    expect(notify.mock.calls[0][0]).toMatchObject({
      sourceKey: 'dns-fallback:task-1:error:1000',
      kind: 'dns-fallback',
      taskId: 'task-1',
      titleParams: { name: 'My Download' },
    })
  })

  it('flips async-dns only once across different failing tasks', async () => {
    const { consumer, applyAsyncDns, reAddTask } = makeHarness()

    await consumer.consume(makeOccurrence())
    await consumer.consume(
      makeOccurrence({ occurrenceId: 'task-2:error:1001', taskId: 'task-2' })
    )

    expect(applyAsyncDns).toHaveBeenCalledTimes(1)
    expect(reAddTask).toHaveBeenCalledTimes(2)
  })

  it('never retries the same task twice', async () => {
    const { consumer, reAddTask } = makeHarness()

    await consumer.consume(makeOccurrence())
    await consumer.consume(
      makeOccurrence({ occurrenceId: 'task-1:error:3000', createdAt: 3000 })
    )

    expect(reAddTask).toHaveBeenCalledTimes(1)
  })

  it.each([
    ['system', 'system'],
    ['engine', 'engine'],
  ] as const)('does nothing when dnsMode is %s', async (_label, dnsMode) => {
    const { consumer, applyAsyncDns, reAddTask } = makeHarness({ dnsMode })

    await consumer.consume(makeOccurrence())

    expect(applyAsyncDns).not.toHaveBeenCalled()
    expect(reAddTask).not.toHaveBeenCalled()
  })

  it('ignores non-DNS network errors', async () => {
    const { consumer, reAddTask } = makeHarness()

    await consumer.consume(
      makeOccurrence({
        errorGroup: {
          errorCode: DownloadErrorCode.NetworkError,
          errorMessage: 'Connection reset by peer',
          errorDetailKey: null,
          errorDetailParams: null,
        },
      })
    )

    expect(reAddTask).not.toHaveBeenCalled()
  })

  it('ignores occurrences created before the consumer started', async () => {
    const { consumer, reAddTask } = makeHarness({ startedAt: 5000 })

    await consumer.consume(makeOccurrence({ createdAt: 2000 }))

    expect(reAddTask).not.toHaveBeenCalled()
  })

  it('ignores user cancellations, completions, and diagnosis occurrences', async () => {
    const { consumer, reAddTask } = makeHarness()

    await consumer.consume(makeOccurrence({ cause: 'user-cancel' }))
    await consumer.consume(
      makeOccurrence({ toStatus: TaskStatus.Completed, errorGroup: null })
    )
    await consumer.consume({
      occurrenceId: 'task-1:diag:1',
      type: 'diagnosis',
      taskId: 'task-1',
      terminalOccurrenceId: 'task-1:error:1000',
      revision: 1,
      diagnosis: {
        errorCode: DownloadErrorCode.NetworkError,
        errorMessage: DNS_MESSAGE,
        errorDetailKey: null,
        errorDetailParams: null,
      },
      createdAt: 2000,
    })

    expect(reAddTask).not.toHaveBeenCalled()
  })

  it('skips a task that is no longer in Error (already re-added or removed)', async () => {
    const { consumer, reAddTask } = makeHarness({ taskStatus: null })

    await consumer.consume(makeOccurrence())

    expect(reAddTask).not.toHaveBeenCalled()
  })

  it('swallows retry failures without throwing back to the dispatcher', async () => {
    const { consumer, reAddTask, log } = makeHarness()
    reAddTask.mockRejectedValueOnce(new Error('engine gone'))

    await expect(consumer.consume(makeOccurrence())).resolves.toBeUndefined()
    expect(log.warn).toHaveBeenCalled()
  })

  it('reset() re-arms the latch and per-task guard', async () => {
    const { consumer, applyAsyncDns, reAddTask } = makeHarness()

    await consumer.consume(makeOccurrence())
    consumer.reset()
    await consumer.consume(
      makeOccurrence({ occurrenceId: 'task-1:error:4000', createdAt: 4000 })
    )

    expect(applyAsyncDns).toHaveBeenCalledTimes(2)
    expect(reAddTask).toHaveBeenCalledTimes(2)
  })
})
