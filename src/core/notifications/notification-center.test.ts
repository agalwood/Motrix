import { EventBus } from '@core/events/event-bus'
import { MotrixDatabase } from '@core/session/motrix-database'
import { Events } from '@shared/protocol/events'
import type { AppNotification } from '@shared/types/notification'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NotificationCenter, type NotifyInput } from './notification-center'
import { makeDiagnosisOccurrence, makeLog } from './notification-test-fixtures'

let db: MotrixDatabase

beforeEach(() => {
  db = new MotrixDatabase(':memory:')
  db.init()
})

afterEach(() => {
  db.close()
})

function makeInput(overrides: Partial<NotifyInput> = {}): NotifyInput {
  return {
    sourceKey: 'src-1',
    kind: 'task-error',
    severity: 'error',
    titleKey: 'notification.title',
    ...overrides,
  }
}

describe('NotificationCenter.notify', () => {
  it('emits NotificationAdded then NotificationsChanged, in order, for a fresh row', () => {
    const calls: unknown[] = []
    const emit = vi.fn((channel: string, payload?: unknown) => {
      calls.push([channel, payload])
    })
    const center = new NotificationCenter({
      store: db,
      emit,
      log: makeLog(),
      now: () => 1000,
    })

    const result = center.notify(makeInput())

    expect(result).toEqual({ fresh: true })
    expect(calls).toHaveLength(2)
    expect((calls[0] as [string, unknown])[0]).toBe(Events.NotificationAdded)
    expect((calls[1] as [string, unknown])[0]).toBe(Events.NotificationsChanged)
    const addedPayload = (calls[0] as [string, AppNotification])[1]
    expect(addedPayload.sourceKey).toBe('src-1')
    expect(center.list()).toHaveLength(1)
  })

  it('a duplicate sourceKey returns {fresh:false} and never emits again — one display row ever, one broadcast ever', () => {
    const calls: unknown[] = []
    const emit = vi.fn((channel: string) => {
      calls.push(channel)
    })
    const center = new NotificationCenter({ store: db, emit, log: makeLog() })

    const first = center.notify(makeInput())
    expect(first).toEqual({ fresh: true })
    expect(calls).toHaveLength(2)

    const second = center.notify(
      makeInput({ titleKey: 'different.title', bodyKey: 'different.body' })
    )
    expect(second).toEqual({ fresh: false })
    // No further emits from the duplicate call.
    expect(calls).toHaveLength(2)
    expect(center.list()).toHaveLength(1)
  })

  it('stamps the row with an explicit createdAt instead of delivery time', () => {
    const emit = vi.fn()
    const center = new NotificationCenter({
      store: db,
      emit,
      log: makeLog(),
      now: () => 9999,
    })

    center.notify(makeInput({ createdAt: 1111 }))

    const [row] = center.list()
    expect(row?.createdAt).toBe(1111)
  })

  it('falls back to now() when createdAt is omitted', () => {
    const emit = vi.fn()
    const center = new NotificationCenter({
      store: db,
      emit,
      log: makeLog(),
      now: () => 4242,
    })

    center.notify(makeInput())

    const [row] = center.list()
    expect(row?.createdAt).toBe(4242)
  })

  it('a throwing NotificationAdded subscriber does not unwind notify(), does not suppress NotificationsChanged, and is isolated by the real EventBus', () => {
    const onListenerError = vi.fn()
    const bus = new EventBus({ onListenerError })
    const changedCalls: string[] = []
    bus.on(Events.NotificationAdded, () => {
      throw new Error('boom: subscriber blew up')
    })
    bus.on(Events.NotificationsChanged, () => {
      changedCalls.push('changed')
    })
    const center = new NotificationCenter({
      store: db,
      emit: bus.emit.bind(bus),
      log: makeLog(),
    })

    let result: { fresh: boolean } | undefined
    expect(() => {
      result = center.notify(makeInput())
    }).not.toThrow()

    expect(result).toEqual({ fresh: true })
    expect(center.list()).toHaveLength(1)
    expect(changedCalls).toEqual(['changed'])
    expect(onListenerError).toHaveBeenCalledTimes(1)
    expect(onListenerError).toHaveBeenCalledWith(
      Events.NotificationAdded,
      expect.any(Error)
    )
  })
})

describe('NotificationCenter.applyDiagnosisUpgrade', () => {
  it('patches the matching row by terminalOccurrenceId and emits only NotificationsChanged', () => {
    const emit = vi.fn()
    const center = new NotificationCenter({ store: db, emit, log: makeLog() })
    center.notify(makeInput({ sourceKey: 'occ-term-1' }))
    emit.mockClear()

    const changed = center.applyDiagnosisUpgrade(
      makeDiagnosisOccurrence({ terminalOccurrenceId: 'occ-term-1' })
    )

    expect(changed).toBe(true)
    expect(emit).toHaveBeenCalledTimes(1)
    expect(emit).toHaveBeenCalledWith(Events.NotificationsChanged)
    const [row] = center.list()
    expect(row?.bodyKey).toBe('task.error.reason.diskFull')
    expect(row?.bodyParams).toBeNull()
  })

  it('never inserts a new row and never emits NotificationAdded', () => {
    const emit = vi.fn()
    const center = new NotificationCenter({ store: db, emit, log: makeLog() })
    center.notify(makeInput({ sourceKey: 'occ-term-1' }))
    emit.mockClear()

    center.applyDiagnosisUpgrade(
      makeDiagnosisOccurrence({ terminalOccurrenceId: 'occ-term-1' })
    )

    expect(center.list()).toHaveLength(1)
    expect(emit).not.toHaveBeenCalledWith(
      Events.NotificationAdded,
      expect.anything()
    )
  })

  it('returns false and emits nothing for a deleted/unknown row', () => {
    const emit = vi.fn()
    const center = new NotificationCenter({ store: db, emit, log: makeLog() })
    center.notify(makeInput({ sourceKey: 'occ-term-1' }))
    emit.mockClear()

    const changed = center.applyDiagnosisUpgrade(
      makeDiagnosisOccurrence({ terminalOccurrenceId: 'occ-term-unknown' })
    )

    expect(changed).toBe(false)
    expect(emit).not.toHaveBeenCalled()
  })

  it('a retried task with two different terminal occurrence ids only touches the matching row', () => {
    const emit = vi.fn()
    const center = new NotificationCenter({ store: db, emit, log: makeLog() })
    center.notify(makeInput({ sourceKey: 'occ-A', taskId: 'm-1' }))
    center.notify(makeInput({ sourceKey: 'occ-B', taskId: 'm-1' }))
    emit.mockClear()

    const changed = center.applyDiagnosisUpgrade(
      makeDiagnosisOccurrence({ terminalOccurrenceId: 'occ-B', taskId: 'm-1' })
    )

    expect(changed).toBe(true)
    const rows = center.list()
    const rowA = rows.find((r) => r.sourceKey === 'occ-A')
    const rowB = rows.find((r) => r.sourceKey === 'occ-B')
    expect(rowA?.bodyKey).toBeNull()
    expect(rowB?.bodyKey).toBe('task.error.reason.diskFull')
  })
})

describe('NotificationCenter mark/delete/clear — emit on change only', () => {
  it('markRead emits on a real change and stays silent for an unknown id', () => {
    const emit = vi.fn()
    const center = new NotificationCenter({ store: db, emit, log: makeLog() })
    center.notify(makeInput({ sourceKey: 'mark-1' }))
    const [row] = center.list()
    emit.mockClear()

    expect(center.markRead((row as AppNotification).id)).toBe(true)
    expect(emit).toHaveBeenCalledTimes(1)
    expect(emit).toHaveBeenCalledWith(Events.NotificationsChanged)

    emit.mockClear()
    expect(center.markRead('unknown-id')).toBe(false)
    expect(emit).not.toHaveBeenCalled()
  })

  it('markAllRead emits only when at least one row was affected', () => {
    const emit = vi.fn()
    const center = new NotificationCenter({ store: db, emit, log: makeLog() })
    center.notify(makeInput({ sourceKey: 'all-a' }))
    center.notify(makeInput({ sourceKey: 'all-b' }))
    emit.mockClear()

    expect(center.markAllRead()).toBe(2)
    expect(emit).toHaveBeenCalledTimes(1)
    expect(emit).toHaveBeenCalledWith(Events.NotificationsChanged)

    emit.mockClear()
    expect(center.markAllRead()).toBe(0)
    expect(emit).not.toHaveBeenCalled()
  })

  it('delete emits on a real change and stays silent for an unknown id', () => {
    const emit = vi.fn()
    const center = new NotificationCenter({ store: db, emit, log: makeLog() })
    center.notify(makeInput({ sourceKey: 'del-1' }))
    const [row] = center.list()
    emit.mockClear()

    expect(center.delete((row as AppNotification).id)).toBe(true)
    expect(emit).toHaveBeenCalledTimes(1)
    expect(emit).toHaveBeenCalledWith(Events.NotificationsChanged)

    emit.mockClear()
    expect(center.delete('unknown-id')).toBe(false)
    expect(emit).not.toHaveBeenCalled()
  })

  it('clear emits only when at least one row was removed', () => {
    const emit = vi.fn()
    const center = new NotificationCenter({ store: db, emit, log: makeLog() })
    center.notify(makeInput({ sourceKey: 'clear-a' }))
    emit.mockClear()

    expect(center.clear()).toBe(1)
    expect(emit).toHaveBeenCalledTimes(1)
    expect(emit).toHaveBeenCalledWith(Events.NotificationsChanged)

    emit.mockClear()
    expect(center.clear()).toBe(0)
    expect(emit).not.toHaveBeenCalled()
  })
})

describe('NotificationCenter read-only passthroughs', () => {
  it('list() and unreadCount() reflect store state', () => {
    const emit = vi.fn()
    const center = new NotificationCenter({ store: db, emit, log: makeLog() })
    center.notify(makeInput({ sourceKey: 'ro-1' }))
    center.notify(makeInput({ sourceKey: 'ro-2' }))

    expect(center.unreadCount()).toBe(2)
    expect(center.list()).toHaveLength(2)
    expect(center.list(1)).toHaveLength(1)
  })
})
