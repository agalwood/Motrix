import { MotrixDatabase } from '@core/session/motrix-database'
import { GENERIC_REASON_KEY } from '@shared/task-error/descriptor'
import { NotificationKinds } from '@shared/types/notification'
import { TaskStatus } from '@shared/types/task'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NotificationCenter } from './notification-center'
import {
  makeDiagnosisOccurrence,
  makeLog,
  makeTerminalOccurrence,
} from './notification-test-fixtures'
import { createNotificationOccurrenceConsumer } from './occurrence-consumer'

let db: MotrixDatabase
let center: NotificationCenter
let emit: ReturnType<typeof makeEmit>

function makeEmit() {
  return vi.fn((_channel: string, _payload?: unknown) => {})
}

beforeEach(() => {
  db = new MotrixDatabase(':memory:')
  db.init()
  emit = makeEmit()
  center = new NotificationCenter({
    store: db,
    emit,
    log: makeLog(),
  })
})

afterEach(() => {
  db.close()
})

describe('createNotificationOccurrenceConsumer', () => {
  it('has the expected consumer name', () => {
    const consumer = createNotificationOccurrenceConsumer({
      center,
      getTaskName: () => null,
    })
    expect(consumer.name).toBe('notification-center')
  })

  it('terminal Error (non-user-cancel) notifies task-error with the first descriptor reason candidate', async () => {
    const consumer = createNotificationOccurrenceConsumer({
      center,
      getTaskName: (id) => (id === 'task-1' ? 'My File.zip' : null),
    })
    const occ = makeTerminalOccurrence()

    await consumer.consume(occ)

    const [row] = center.list()
    expect(row?.sourceKey).toBe(occ.occurrenceId)
    expect(row?.kind).toBe(NotificationKinds.TaskError)
    expect(row?.severity).toBe('error')
    expect(row?.titleKey).toBe('notification.taskError.title')
    expect(row?.titleParams).toEqual({ name: 'My File.zip' })
    expect(row?.bodyKey).toBe('task.error.reason.networkError')
    expect(row?.bodyParams).toBeNull()
    expect(row?.taskId).toBe('task-1')
  })

  it('stamps the row with the occurrence createdAt, not delivery time, for a terminal Error', async () => {
    const consumer = createNotificationOccurrenceConsumer({
      center,
      getTaskName: () => 'My File.zip',
    })
    const occ = makeTerminalOccurrence({ createdAt: 2222 })

    await consumer.consume(occ)

    const [row] = center.list()
    expect(row?.createdAt).toBe(2222)
  })

  it('stamps the row with the occurrence createdAt, not delivery time, for a terminal Completed', async () => {
    const consumer = createNotificationOccurrenceConsumer({
      center,
      getTaskName: () => 'Movie.mp4',
    })
    const occ = makeTerminalOccurrence({
      toStatus: TaskStatus.Completed,
      cause: 'finalize',
      errorGroup: null,
      createdAt: 2222,
    })

    await consumer.consume(occ)

    const [row] = center.list()
    expect(row?.createdAt).toBe(2222)
  })

  it('errorGroup null falls back to the generic reason key', async () => {
    const consumer = createNotificationOccurrenceConsumer({
      center,
      getTaskName: () => 'My File.zip',
    })
    const occ = makeTerminalOccurrence({ errorGroup: null })

    await consumer.consume(occ)

    const [row] = center.list()
    expect(row?.bodyKey).toBe(GENERIC_REASON_KEY)
    expect(row?.bodyParams).toBeNull()
  })

  it('terminal Completed notifies task-complete info with no body', async () => {
    const consumer = createNotificationOccurrenceConsumer({
      center,
      getTaskName: () => 'Movie.mp4',
    })
    const occ = makeTerminalOccurrence({
      toStatus: TaskStatus.Completed,
      cause: 'finalize',
      errorGroup: null,
    })

    await consumer.consume(occ)

    const [row] = center.list()
    expect(row?.sourceKey).toBe(occ.occurrenceId)
    expect(row?.kind).toBe(NotificationKinds.TaskComplete)
    expect(row?.severity).toBe('info')
    expect(row?.titleKey).toBe('notification.taskComplete.title')
    expect(row?.titleParams).toEqual({ name: 'Movie.mp4' })
    expect(row?.bodyKey).toBeNull()
    expect(row?.taskId).toBe('task-1')
  })

  it('user-cancel terminal notifies nothing', async () => {
    const consumer = createNotificationOccurrenceConsumer({
      center,
      getTaskName: () => 'My File.zip',
    })
    const occ = makeTerminalOccurrence({ cause: 'user-cancel' })

    await consumer.consume(occ)

    expect(center.list()).toHaveLength(0)
    expect(emit).not.toHaveBeenCalled()
  })

  it('diagnosis occurrence calls center.applyDiagnosisUpgrade with the occurrence', async () => {
    const consumer = createNotificationOccurrenceConsumer({
      center,
      getTaskName: () => 'My File.zip',
    })
    center.notify({
      sourceKey: 'occ-1',
      kind: NotificationKinds.TaskError,
      severity: 'error',
      titleKey: 'notification.taskError.title',
      titleParams: { name: 'My File.zip' },
      taskId: 'task-1',
    })
    const spy = vi.spyOn(center, 'applyDiagnosisUpgrade')
    const occ = makeDiagnosisOccurrence({ terminalOccurrenceId: 'occ-1' })

    await consumer.consume(occ)

    expect(spy).toHaveBeenCalledExactlyOnceWith(occ)
    const [row] = center.list()
    expect(row?.bodyKey).toBe('task.error.reason.diskFull')
  })

  it('replay of the same occurrence is a complete no-op the second time', async () => {
    const consumer = createNotificationOccurrenceConsumer({
      center,
      getTaskName: () => 'My File.zip',
    })
    const occ = makeTerminalOccurrence()

    await consumer.consume(occ)
    expect(center.list()).toHaveLength(1)
    emit.mockClear()

    const notifySpy = vi.spyOn(center, 'notify')
    await consumer.consume(occ)

    expect(notifySpy).toHaveReturnedWith({ fresh: false })
    expect(center.list()).toHaveLength(1)
    expect(emit).not.toHaveBeenCalled()
  })

  it('unknown task id falls back titleParams.name to the task id', async () => {
    const consumer = createNotificationOccurrenceConsumer({
      center,
      getTaskName: () => null,
    })
    const occ = makeTerminalOccurrence({ taskId: 'task-unknown' })

    await consumer.consume(occ)

    const [row] = center.list()
    expect(row?.titleParams).toEqual({ name: 'task-unknown' })
  })
})
