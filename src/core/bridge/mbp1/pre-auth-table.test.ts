import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PreAuthTable } from './pre-auth-table'

describe('PreAuthTable (§4)', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('enforces the total cap, rejecting admission once full', () => {
    const onDeadline = vi.fn()
    const table = new PreAuthTable<string>({
      cap: 2,
      deadlineMs: 10_000,
      onDeadline,
    })
    expect(table.admit('a')).toBe(true)
    expect(table.admit('b')).toBe(true)
    expect(table.admit('c')).toBe(false)
    expect(table.size()).toBe(2)
  })

  it('fires onDeadline for an entry that never settles', () => {
    const onDeadline = vi.fn()
    const table = new PreAuthTable<string>({
      cap: 5,
      deadlineMs: 10_000,
      onDeadline,
    })
    table.admit('conn-1')
    vi.advanceTimersByTime(10_000)
    expect(onDeadline).toHaveBeenCalledExactlyOnceWith('conn-1')
    expect(table.size()).toBe(0)
  })

  it('settle before the deadline removes the entry and cancels its timer', () => {
    const onDeadline = vi.fn()
    const table = new PreAuthTable<string>({
      cap: 5,
      deadlineMs: 10_000,
      onDeadline,
    })
    table.admit('conn-1')
    table.settle('conn-1')
    expect(table.size()).toBe(0)

    // No leaked timer: advancing well past the deadline must not fire it.
    vi.advanceTimersByTime(60_000)
    expect(onDeadline).not.toHaveBeenCalled()
  })

  it('settle frees a cap slot for a new admission', () => {
    const onDeadline = vi.fn()
    const table = new PreAuthTable<string>({
      cap: 1,
      deadlineMs: 10_000,
      onDeadline,
    })
    expect(table.admit('conn-1')).toBe(true)
    expect(table.admit('conn-2')).toBe(false)
    table.settle('conn-1')
    expect(table.admit('conn-2')).toBe(true)
  })

  it('rejects re-admitting an already-admitted entry without leaking its timer', () => {
    const onDeadline = vi.fn()
    const table = new PreAuthTable<string>({
      cap: 5,
      deadlineMs: 10_000,
      onDeadline,
    })
    expect(table.admit('conn-1')).toBe(true)
    expect(table.admit('conn-1')).toBe(false)
    expect(table.size()).toBe(1)

    // The original timer must still be the one armed -- not orphaned by a
    // second admit() silently overwriting its slot.
    vi.advanceTimersByTime(10_000)
    expect(onDeadline).toHaveBeenCalledExactlyOnceWith('conn-1')
  })

  it('settle on an entry that already hit its deadline is a harmless no-op', () => {
    const onDeadline = vi.fn()
    const table = new PreAuthTable<string>({
      cap: 5,
      deadlineMs: 10_000,
      onDeadline,
    })
    table.admit('conn-1')
    vi.advanceTimersByTime(10_000)
    expect(onDeadline).toHaveBeenCalledExactlyOnceWith('conn-1')

    expect(() => table.settle('conn-1')).not.toThrow()
    expect(onDeadline).toHaveBeenCalledTimes(1)
  })
})
