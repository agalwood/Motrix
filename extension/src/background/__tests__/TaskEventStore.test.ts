import { describe, expect, it, vi } from 'vitest'
import { TaskEventStore } from '@/background/TaskEventStore'

const prog = (taskId: string, bytesDone: number) => ({
  taskId,
  bytesDone,
  bytesTotal: 100,
  speedBps: 10,
  etaSec: 1,
  phase: 'downloading' as const,
})

describe('TaskEventStore', () => {
  it('records the latest progress per task', () => {
    const s = new TaskEventStore()
    s.recordProgress(prog('t1', 10))
    s.recordProgress(prog('t1', 40))
    expect(s.take('t1')?.bytesDone).toBe(40)
  })

  it('take() removes the entry', () => {
    const s = new TaskEventStore()
    s.recordProgress(prog('t1', 10))
    s.take('t1')
    expect(s.take('t1')).toBeUndefined()
  })

  it('size reflects add and remove', () => {
    const s = new TaskEventStore()
    expect(s.size).toBe(0)
    s.recordProgress(prog('a', 0))
    expect(s.size).toBe(1)
    s.take('a')
    expect(s.size).toBe(0)
  })

  it('onChange fires on first record of an id, not on subsequent progress', () => {
    const s = new TaskEventStore()
    const cb = vi.fn()
    s.onChange(cb)
    s.recordProgress(prog('a', 0))
    s.recordProgress(prog('a', 0)) // same id, membership unchanged
    expect(cb).toHaveBeenCalledTimes(1)
  })

  it('onChange fires on take only when an entry was present', () => {
    const s = new TaskEventStore()
    const cb = vi.fn()
    s.recordProgress(prog('a', 0))
    s.onChange(cb)
    s.take('a')
    s.take('a') // already gone
    expect(cb).toHaveBeenCalledTimes(1)
  })

  it('clear() empties the map and fires onChange when it had entries', () => {
    const s = new TaskEventStore()
    const cb = vi.fn()
    s.recordProgress(prog('a', 0))
    s.recordProgress(prog('b', 0))
    s.onChange(cb)
    s.clear()
    expect(s.size).toBe(0)
    expect(cb).toHaveBeenCalledTimes(1)
  })

  it('clear() on an already-empty store does not fire onChange', () => {
    const s = new TaskEventStore()
    const cb = vi.fn()
    s.onChange(cb)
    s.clear()
    expect(s.size).toBe(0)
    expect(cb).not.toHaveBeenCalled()
  })
})
