import { Events } from '@shared/protocol/events'
import type { DownloadTask } from '@shared/types/task'
import { TaskStatus } from '@shared/types/task'
import { makeDownloadTask } from '@test-utils/task'
import { beforeEach, describe, expect, it } from 'vitest'
import { EventBus } from '../events/event-bus'
import { TaskManager } from './task-manager'
import {
  TASK_UPDATED_COALESCE_MS,
  TaskUpdatePublisher,
} from './task-update-publisher'

/**
 * Deterministic stand-in for setTimeout/clearTimeout. `fire()` runs every
 * scheduled callback, simulating the trailing window elapsing.
 */
class FakeScheduler {
  delays: number[] = []
  private pending = new Map<number, () => void>()
  private nextId = 1

  set = (fn: () => void, ms: number): number => {
    this.delays.push(ms)
    const id = this.nextId++
    this.pending.set(id, fn)
    return id
  }

  clear = (handle: number): void => {
    this.pending.delete(handle)
  }

  fire(): void {
    const callbacks = [...this.pending.values()]
    this.pending.clear()
    for (const fn of callbacks) fn()
  }

  get pendingCount(): number {
    return this.pending.size
  }
}

describe('TaskUpdatePublisher', () => {
  let taskManager: TaskManager
  let eventBus: EventBus
  let scheduler: FakeScheduler
  let publisher: TaskUpdatePublisher
  let payloads: DownloadTask[][]

  beforeEach(() => {
    taskManager = new TaskManager()
    eventBus = new EventBus()
    scheduler = new FakeScheduler()
    publisher = new TaskUpdatePublisher(
      { taskManager, eventBus },
      { scheduler }
    )
    payloads = []
    eventBus.on(Events.TaskUpdated, (...args: unknown[]) => {
      payloads.push(args[0] as DownloadTask[])
    })
  })

  it('collapses a burst of publish() calls into one trailing emit', () => {
    taskManager.set('a', makeDownloadTask({ id: 'a' }))
    for (let i = 0; i < 200; i++) publisher.publish()

    expect(payloads).toHaveLength(0)
    scheduler.fire()

    expect(payloads).toHaveLength(1)
    expect(payloads[0]?.map((t) => t.id)).toEqual(['a'])
  })

  it('schedules the trailing flush with the default 16 ms window', () => {
    publisher.publish()
    expect(scheduler.delays).toEqual([TASK_UPDATED_COALESCE_MS])
  })

  it('builds the payload at flush time, not at publish time', () => {
    taskManager.set(
      'a',
      makeDownloadTask({ id: 'a', status: TaskStatus.Downloading })
    )
    publisher.publish()
    taskManager.set(
      'a',
      makeDownloadTask({ id: 'a', status: TaskStatus.Paused })
    )
    scheduler.fire()

    expect(payloads).toHaveLength(1)
    expect(payloads[0]?.[0]?.status).toBe(TaskStatus.Paused)
  })

  it('a removal during the window yields a snapshot without the id', () => {
    taskManager.set('a', makeDownloadTask({ id: 'a' }))
    taskManager.set('b', makeDownloadTask({ id: 'b' }))
    publisher.publish()
    taskManager.remove('b')
    publisher.publish()
    scheduler.fire()

    expect(payloads).toHaveLength(1)
    expect(payloads[0]?.map((t) => t.id)).toEqual(['a'])
  })

  it('publishNow() emits synchronously and cancels the pending window', () => {
    taskManager.set(
      'a',
      makeDownloadTask({ id: 'a', status: TaskStatus.Completed })
    )
    publisher.publish()
    publisher.publishNow()

    expect(payloads).toHaveLength(1)
    expect(payloads[0]?.[0]?.status).toBe(TaskStatus.Completed)
    expect(scheduler.pendingCount).toBe(0)

    scheduler.fire()
    expect(payloads).toHaveLength(1)
  })

  it('publishNow() emits even without a pending publish', () => {
    publisher.publishNow()
    expect(payloads).toHaveLength(1)
  })

  it('a publish() after a flush arms a new window', () => {
    publisher.publish()
    scheduler.fire()
    publisher.publish()
    scheduler.fire()

    expect(payloads).toHaveLength(2)
  })

  it('flush() drains a pending snapshot', () => {
    taskManager.set('a', makeDownloadTask({ id: 'a' }))
    publisher.publish()
    publisher.flush()

    expect(payloads).toHaveLength(1)
    expect(scheduler.pendingCount).toBe(0)
  })

  it('flush() without a pending publish emits nothing', () => {
    publisher.flush()
    expect(payloads).toHaveLength(0)
  })

  it('uses real timers when no scheduler is injected', async () => {
    const realPublisher = new TaskUpdatePublisher(
      { taskManager, eventBus },
      { windowMs: 1 }
    )
    realPublisher.publish()
    expect(payloads).toHaveLength(0)
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(payloads).toHaveLength(1)
  })
})
