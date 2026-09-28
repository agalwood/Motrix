import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { newHookAbort } from './abort'

describe('newHookAbort', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('aborts once at its deadline with the timeout reason', async () => {
    const budget = newHookAbort(50)
    const listener = vi.fn()
    budget.signal.addEventListener('abort', listener)

    await vi.advanceTimersByTimeAsync(49)
    expect(budget.signal.aborted).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    expect(budget.signal.reason).toBe('timeout')
    expect(listener).toHaveBeenCalledOnce()
    budget.dispose()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('explicit abort cancels the deadline and preserves its first reason', async () => {
    const budget = newHookAbort(200)
    const listener = vi.fn()
    budget.signal.addEventListener('abort', listener)

    budget.abort('manual')
    budget.abort('another reason')
    expect(vi.getTimerCount()).toBe(0)
    await vi.advanceTimersByTimeAsync(500)

    expect(budget.signal.aborted).toBe(true)
    expect(budget.signal.reason).toBe('manual')
    expect(listener).toHaveBeenCalledOnce()
    budget.dispose()
  })

  it('disposal cancels the timer without sending an abort, even when repeated', async () => {
    const budget = newHookAbort(200)
    const listener = vi.fn()
    budget.signal.addEventListener('abort', listener)

    budget.dispose()
    budget.dispose()
    budget.abort('late cancellation')
    expect(vi.getTimerCount()).toBe(0)
    await vi.advanceTimersByTimeAsync(500)

    expect(budget.signal.aborted).toBe(false)
    expect(listener).not.toHaveBeenCalled()
  })

  it('disposing an earlier budget preserves the later invocation deadline', async () => {
    const first = newHookAbort(100)
    await vi.advanceTimersByTimeAsync(80)
    first.dispose()
    const second = newHookAbort(100)

    await vi.advanceTimersByTimeAsync(20)
    expect(first.signal.aborted).toBe(false)
    expect(second.signal.aborted).toBe(false)
    await vi.advanceTimersByTimeAsync(80)
    expect(second.signal.aborted).toBe(true)
    expect(second.signal.reason).toBe('timeout')
    second.dispose()
  })
})
