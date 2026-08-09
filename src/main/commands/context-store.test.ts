import { TaskStatus } from '@shared/types/task'
import { describe, expect, it, vi } from 'vitest'
import { ContextStore } from './context-store'

describe('ContextStore', () => {
  it('starts with defaults', () => {
    const store = new ContextStore()
    expect(store.get().taskSelected).toBe(false)
    expect(store.get().selectedTaskId).toBe(null)
  })

  it('merge updates fields and fires listener once', () => {
    const store = new ContextStore()
    const listener = vi.fn()
    store.onChange(listener)
    store.merge({
      selectedTaskId: 't1',
      selectedTaskStatus: TaskStatus.Downloading,
    })
    expect(store.get().selectedTaskId).toBe('t1')
    expect(listener).toHaveBeenCalledOnce()
  })

  it('derives taskSelected from selectedTaskId', () => {
    const store = new ContextStore()
    store.merge({ selectedTaskId: 't1' })
    expect(store.get().taskSelected).toBe(true)
    store.merge({ selectedTaskId: null })
    expect(store.get().taskSelected).toBe(false)
  })

  it('no-op merge does not fire listener', () => {
    const store = new ContextStore()
    store.merge({ selectedTaskId: 't1' })
    const listener = vi.fn()
    store.onChange(listener)
    store.merge({ selectedTaskId: 't1' })
    expect(listener).not.toHaveBeenCalled()
  })

  it('unsubscribe returned by onChange works', () => {
    const store = new ContextStore()
    const listener = vi.fn()
    const off = store.onChange(listener)
    off()
    store.merge({ selectedTaskId: 't1' })
    expect(listener).not.toHaveBeenCalled()
  })
})
