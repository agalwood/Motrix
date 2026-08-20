import { EventBus } from '@core/events/event-bus'
import { MotrixDatabase } from '@core/session/motrix-database'
import { Events } from '@shared/protocol/events'
import type { EngineFailurePayload } from '@shared/types/engine'
import {
  EngineFailureReason,
  EngineState,
  engineFailureReasonKey,
} from '@shared/types/engine'
import { NotificationKinds } from '@shared/types/notification'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { registerEngineFailureSubscriber } from './engine-failure-subscriber'
import { NotificationCenter } from './notification-center'

function makeLog() {
  return { warn: vi.fn(), error: vi.fn() }
}

function makePayload(
  overrides: Partial<EngineFailurePayload> = {}
): EngineFailurePayload {
  return {
    incidentId: 'engine:1000:0',
    reason: EngineFailureReason.SpawnFailed,
    occurredAt: 1000,
    technicalMessage: 'boom',
    ...overrides,
  }
}

describe('engineFailureReasonKey', () => {
  it('mirrors the renderer diagnostics reason key format', () => {
    expect(engineFailureReasonKey(EngineFailureReason.SpawnFailed)).toBe(
      'panel.dashboard.engine.diagnostics.reason.spawn_failed'
    )
    expect(engineFailureReasonKey(EngineFailureReason.PortInUse)).toBe(
      'panel.dashboard.engine.diagnostics.reason.port_in_use'
    )
  })
})

describe('registerEngineFailureSubscriber', () => {
  it('runs the grace cleanup before subscribing', () => {
    const order: string[] = []
    const motrixDb = {
      deleteEngineNotificationLedgerBefore: vi.fn(() => {
        order.push('cleanup')
        return 0
      }),
    } as unknown as MotrixDatabase
    const eventBus = {
      on: vi.fn(() => {
        order.push('subscribe')
      }),
    } as unknown as EventBus
    const notificationCenter = { notify: vi.fn() }

    registerEngineFailureSubscriber({
      motrixDb,
      eventBus,
      notificationCenter,
      now: () => 5000,
      log: makeLog(),
    })

    expect(order).toEqual(['cleanup', 'subscribe', 'subscribe'])
    expect(motrixDb.deleteEngineNotificationLedgerBefore).toHaveBeenCalledWith(
      5000
    )
  })

  it('maps a payload onto the exact notify() shape from the brief', () => {
    const motrixDb = {
      deleteEngineNotificationLedgerBefore: vi.fn(() => 0),
    } as unknown as MotrixDatabase
    const eventBus = new EventBus()
    const notify = vi.fn()

    registerEngineFailureSubscriber({
      motrixDb,
      eventBus,
      notificationCenter: { notify },
      log: makeLog(),
    })

    const payload = makePayload({ incidentId: 'engine:2000:3' })
    eventBus.emit(Events.EngineFailureOccurred, payload)

    expect(notify).toHaveBeenCalledOnce()
    expect(notify).toHaveBeenCalledWith({
      sourceKey: 'engine:2000:3',
      kind: NotificationKinds.EngineFailure,
      severity: 'error',
      titleKey: 'notification.engineFailure.title',
      bodyKey: 'panel.dashboard.engine.diagnostics.reason.spawn_failed',
      createdAt: payload.occurredAt,
    })
  })

  it('discards a transient unexpected-exit incident after automatic recovery', () => {
    const motrixDb = {
      deleteEngineNotificationLedgerBefore: vi.fn(() => 0),
    } as unknown as MotrixDatabase
    const eventBus = new EventBus()
    const notify = vi.fn()

    registerEngineFailureSubscriber({
      motrixDb,
      eventBus,
      notificationCenter: { notify },
      log: makeLog(),
    })

    eventBus.emit(
      Events.EngineFailureOccurred,
      makePayload({ reason: EngineFailureReason.UnexpectedExit })
    )
    eventBus.emit(Events.EngineStateChanged, EngineState.Restarting)
    expect(notify).not.toHaveBeenCalled()

    eventBus.emit(Events.EngineStateChanged, EngineState.Ready)
    expect(notify).not.toHaveBeenCalled()
  })

  it('publishes a recoverable incident if automatic recovery becomes terminal', () => {
    const motrixDb = {
      deleteEngineNotificationLedgerBefore: vi.fn(() => 0),
    } as unknown as MotrixDatabase
    const eventBus = new EventBus()
    const notify = vi.fn()
    const payload = makePayload({
      reason: EngineFailureReason.HealthCheckFailed,
    })

    registerEngineFailureSubscriber({
      motrixDb,
      eventBus,
      notificationCenter: { notify },
      log: makeLog(),
    })

    eventBus.emit(Events.EngineFailureOccurred, payload)
    eventBus.emit(Events.EngineStateChanged, EngineState.Failed)

    expect(notify).toHaveBeenCalledOnce()
    expect(notify).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceKey: payload.incidentId,
        bodyKey:
          'panel.dashboard.engine.diagnostics.reason.health_check_failed',
      })
    )
  })

  it('reports only a terminal restart cause after a transient exit', () => {
    const motrixDb = {
      deleteEngineNotificationLedgerBefore: vi.fn(() => 0),
    } as unknown as MotrixDatabase
    const eventBus = new EventBus()
    const notify = vi.fn()

    registerEngineFailureSubscriber({
      motrixDb,
      eventBus,
      notificationCenter: { notify },
      log: makeLog(),
    })

    eventBus.emit(
      Events.EngineFailureOccurred,
      makePayload({ reason: EngineFailureReason.UnexpectedExit })
    )
    const terminal = makePayload({
      incidentId: 'engine:1001:1',
      occurredAt: 1001,
      reason: EngineFailureReason.SpawnFailed,
    })
    eventBus.emit(Events.EngineFailureOccurred, terminal)
    eventBus.emit(Events.EngineStateChanged, EngineState.Failed)

    expect(notify).toHaveBeenCalledOnce()
    expect(notify).toHaveBeenCalledWith(
      expect.objectContaining({ sourceKey: terminal.incidentId })
    )
  })

  it('a notify() throw (e.g. a full store) is swallowed and logged via log.warn, never re-thrown into the EventBus dispatch', () => {
    const motrixDb = {
      deleteEngineNotificationLedgerBefore: vi.fn(() => 0),
    } as unknown as MotrixDatabase
    const eventBus = new EventBus()
    const err = new Error('SQLITE_FULL')
    const notify = vi.fn(() => {
      throw err
    })
    const log = makeLog()

    registerEngineFailureSubscriber({
      motrixDb,
      eventBus,
      notificationCenter: { notify },
      log,
    })

    expect(() =>
      eventBus.emit(Events.EngineFailureOccurred, makePayload())
    ).not.toThrow()
    expect(log.warn).toHaveBeenCalledOnce()
  })

  describe('with a real in-memory MotrixDatabase', () => {
    let db: MotrixDatabase

    beforeEach(() => {
      db = new MotrixDatabase(':memory:')
      db.init()
    })

    afterEach(() => {
      db.close()
    })

    it('turns one payload into exactly one notification-center row', () => {
      const eventBus = new EventBus()
      const center = new NotificationCenter({
        store: db,
        emit: eventBus.emit.bind(eventBus),
        log: makeLog(),
      })
      registerEngineFailureSubscriber({
        motrixDb: db,
        eventBus,
        notificationCenter: center,
        log: makeLog(),
      })

      eventBus.emit(Events.EngineFailureOccurred, makePayload())

      const rows = center.list()
      expect(rows).toHaveLength(1)
      expect(rows[0]).toMatchObject({
        sourceKey: 'engine:1000:0',
        kind: NotificationKinds.EngineFailure,
        severity: 'error',
        titleKey: 'notification.engineFailure.title',
        bodyKey: 'panel.dashboard.engine.diagnostics.reason.spawn_failed',
        taskId: null,
      })
    })

    it('stamps the row with payload.occurredAt, not delivery time', () => {
      const eventBus = new EventBus()
      const center = new NotificationCenter({
        store: db,
        emit: eventBus.emit.bind(eventBus),
        log: makeLog(),
        now: () => 9999,
      })
      registerEngineFailureSubscriber({
        motrixDb: db,
        eventBus,
        notificationCenter: center,
        log: makeLog(),
      })

      eventBus.emit(
        Events.EngineFailureOccurred,
        makePayload({ occurredAt: 3333 })
      )

      const [row] = center.list()
      expect(row?.createdAt).toBe(3333)
    })

    it('a duplicate payload (same incidentId) does not create a second row', () => {
      const eventBus = new EventBus()
      const center = new NotificationCenter({
        store: db,
        emit: eventBus.emit.bind(eventBus),
        log: makeLog(),
      })
      registerEngineFailureSubscriber({
        motrixDb: db,
        eventBus,
        notificationCenter: center,
        log: makeLog(),
      })

      const payload = makePayload()
      eventBus.emit(Events.EngineFailureOccurred, payload)
      eventBus.emit(Events.EngineFailureOccurred, payload)

      expect(center.list()).toHaveLength(1)
    })

    it('grace cleanup removes stale task_id IS NULL ledger rows and leaves task-bound rows', () => {
      // Pre-seed the ledger directly: a stale engine-scoped row (task_id
      // NULL), a fresh engine-scoped row, and a stale task-bound row —
      // mirrors motrix-database.test.ts's own coverage of
      // deleteEngineNotificationLedgerBefore, exercised here through the
      // subscriber's bootstrap call instead of calling the store directly.
      const engineStale = db.insertNotificationWithLedger({
        sourceKey: 'engine:stale',
        taskId: null,
        kind: NotificationKinds.EngineFailure,
        severity: 'error',
        titleKey: 'notification.engineFailure.title',
        titleParams: null,
        bodyKey: null,
        bodyParams: null,
        createdAt: 1000,
      })
      db.insertNotificationWithLedger({
        sourceKey: 'engine:fresh',
        taskId: null,
        kind: NotificationKinds.EngineFailure,
        severity: 'error',
        titleKey: 'notification.engineFailure.title',
        titleParams: null,
        bodyKey: null,
        bodyParams: null,
        createdAt: 9000,
      })
      db.insertNotificationWithLedger({
        sourceKey: 'task:stale',
        taskId: 'm-1',
        kind: NotificationKinds.TaskError,
        severity: 'error',
        titleKey: 'notification.taskError.title',
        titleParams: null,
        bodyKey: null,
        bodyParams: null,
        createdAt: 1000,
      })

      const eventBus = new EventBus()
      const center = new NotificationCenter({
        store: db,
        emit: eventBus.emit.bind(eventBus),
        log: makeLog(),
      })
      registerEngineFailureSubscriber({
        motrixDb: db,
        eventBus,
        notificationCenter: center,
        now: () => 5000,
        log: makeLog(),
      })

      // The stale engine-scoped sourceKey was purged from the LEDGER, so
      // it is free to reuse — but F3's partial UNIQUE index on
      // `notifications.source_key` still blocks a byte-identical reuse
      // while the stale DISPLAY row survives (grace cleanup only ever
      // touches the ledger). Drop that display row too, mirroring
      // motrix-database.test.ts's own `deleteEngineNotificationLedgerBefore`
      // coverage of the same interaction.
      if (engineStale) db.deleteNotification(engineStale.id)
      expect(
        db.insertNotificationWithLedger({
          sourceKey: 'engine:stale',
          taskId: null,
          kind: NotificationKinds.EngineFailure,
          severity: 'error',
          titleKey: 'notification.engineFailure.title',
          titleParams: null,
          bodyKey: null,
          bodyParams: null,
          createdAt: 9500,
        })
      ).not.toBeNull()
      // The fresh engine-scoped row survived the cutoff.
      expect(
        db.insertNotificationWithLedger({
          sourceKey: 'engine:fresh',
          taskId: null,
          kind: NotificationKinds.EngineFailure,
          severity: 'error',
          titleKey: 'notification.engineFailure.title',
          titleParams: null,
          bodyKey: null,
          bodyParams: null,
          createdAt: 9500,
        })
      ).toBeNull()
      // The task-bound row is never touched by the engine-only sweep.
      expect(
        db.insertNotificationWithLedger({
          sourceKey: 'task:stale',
          taskId: 'm-1',
          kind: NotificationKinds.TaskError,
          severity: 'error',
          titleKey: 'notification.taskError.title',
          titleParams: null,
          bodyKey: null,
          bodyParams: null,
          createdAt: 9500,
        })
      ).toBeNull()
    })
  })
})
