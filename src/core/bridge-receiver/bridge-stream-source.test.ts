import type { GlobalStats } from '@shared/types/stats'
import { TaskStatus } from '@shared/types/task'
import { makeDownloadTask } from '@test-utils/task'
import { describe, expect, it } from 'vitest'
import {
  BridgeStreamSource,
  type CoreEventSubscriber,
  type StreamBroadcaster,
} from './bridge-stream-source'

function fakeBus() {
  const listeners = new Map<string, (p: unknown) => void>()
  const bus: CoreEventSubscriber = {
    on: (e, l) => {
      listeners.set(e, l)
    },
    off: (e) => {
      listeners.delete(e)
    },
  }
  return {
    bus,
    emit: (e: string, p: unknown) => listeners.get(e)?.(p),
    has: (e: string) => listeners.has(e),
  }
}

function setup() {
  const calls: Array<{ event: string; data: unknown }> = []
  const target: StreamBroadcaster = {
    broadcastStreamEvent: (event, data) => calls.push({ event, data }),
  }
  const source = new BridgeStreamSource(target, (c) => `localized:${c}`)
  const f = fakeBus()
  source.attach(f.bus)
  return { calls, source, f }
}

describe('BridgeStreamSource', () => {
  it('emits $/task/progress per non-terminal task in the array', () => {
    const { calls, f } = setup()
    f.emit('event:taskUpdated', [
      makeDownloadTask({ id: 't1', status: TaskStatus.Downloading }),
      makeDownloadTask({ id: 't2', status: TaskStatus.Queued }),
    ])
    expect(calls).toHaveLength(2)
    expect(calls[0]).toMatchObject({ event: '$/task/progress' })
    expect((calls[0].data as { taskId: string }).taskId).toBe('t1')
    expect((calls[1].data as { taskId: string }).taskId).toBe('t2')
  })

  it('derives $/task/completed once (deduped across ticks)', () => {
    const { calls, f } = setup()
    const completed = makeDownloadTask({
      id: 't1',
      status: TaskStatus.Completed,
      finalPath: '/dl/f',
    })
    f.emit('event:taskUpdated', [completed])
    f.emit('event:taskUpdated', [completed]) // still completed next tick
    expect(calls.filter((c) => c.event === '$/task/completed')).toHaveLength(1)
  })

  it('derives $/task/error once with a classified code + localized message', () => {
    const { calls, f } = setup()
    f.emit('event:taskUpdated', [
      makeDownloadTask({
        id: 't1',
        status: TaskStatus.Error,
        errorMessage: 'ENOSPC no space',
      }),
    ])
    const err = calls.find((c) => c.event === '$/task/error')
    expect(err?.data).toMatchObject({
      taskId: 't1',
      code: 'disk-full',
      message: 'localized:disk-full',
    })
  })

  it('emits progress then completed across a transition', () => {
    const { calls, f } = setup()
    f.emit('event:taskUpdated', [
      makeDownloadTask({ id: 't1', status: TaskStatus.Downloading }),
    ])
    f.emit('event:taskUpdated', [
      makeDownloadTask({ id: 't1', status: TaskStatus.Completed }),
    ])
    expect(calls.map((c) => c.event)).toEqual([
      '$/task/progress',
      '$/task/completed',
    ])
  })

  it('does not broadcast for removed tasks', () => {
    const { calls, f } = setup()
    f.emit('event:taskUpdated', [
      makeDownloadTask({ id: 't1', status: TaskStatus.Removed }),
    ])
    expect(calls).toHaveLength(0)
  })

  it('ignores a non-array TaskUpdated payload (defensive)', () => {
    const { calls, f } = setup()
    f.emit('event:taskUpdated', makeDownloadTask({ id: 't1' }))
    expect(calls).toHaveLength(0)
  })

  it('emits $/stats from a GlobalStats payload', () => {
    const { calls, f } = setup()
    const stats: GlobalStats = {
      totalDownloadSpeed: 1,
      totalUploadSpeed: 2,
      activeTasks: 3,
      waitingTasks: 4,
      stoppedTasks: 5,
    }
    f.emit('event:statsUpdated', stats)
    expect(calls).toEqual([{ event: '$/stats', data: stats }])
  })

  it('detach removes the listeners', () => {
    const { source, f } = setup()
    expect(f.has('event:taskUpdated')).toBe(true)
    source.detach(f.bus)
    expect(f.has('event:taskUpdated')).toBe(false)
    expect(f.has('event:statsUpdated')).toBe(false)
  })
})
