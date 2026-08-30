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
    // Advance between the two admits so a leaked timer would fire at a
    // DIFFERENT instant than the original: admitting twice at the same fake
    // instant cannot tell a leaked timer from a wrong return value.
    vi.advanceTimersByTime(4_000)
    expect(table.admit('conn-1')).toBe(false)
    expect(table.size()).toBe(1)

    // The original timer must still be the one armed -- not orphaned by a
    // second admit() silently overwriting its slot.
    vi.advanceTimersByTime(6_000)
    expect(onDeadline).toHaveBeenCalledExactlyOnceWith('conn-1')
    vi.advanceTimersByTime(60_000)
    expect(onDeadline).toHaveBeenCalledTimes(1)
  })

  it('clear() cancels every armed deadline and empties the table', () => {
    const onDeadline = vi.fn()
    const table = new PreAuthTable<string>({
      cap: 5,
      deadlineMs: 10_000,
      onDeadline,
    })
    table.admit('conn-1')
    table.admit('conn-2')

    table.clear()

    expect(table.size()).toBe(0)
    vi.advanceTimersByTime(60_000)
    expect(onDeadline).not.toHaveBeenCalled()
  })

  it('takeWhere synchronously removes matching entries and cancels only their deadlines', () => {
    const onDeadline = vi.fn()
    const table = new PreAuthTable<string>({
      cap: 5,
      deadlineMs: 10_000,
      onDeadline,
    })
    table.admit('same-origin-pair')
    table.admit('other-origin-pair')
    table.admit('same-origin-reconnect')

    expect(table.takeWhere((entry) => entry.startsWith('same-origin'))).toEqual(
      ['same-origin-pair', 'same-origin-reconnect']
    )
    expect(table.size()).toBe(1)

    vi.advanceTimersByTime(10_000)
    expect(onDeadline).toHaveBeenCalledExactlyOnceWith('other-origin-pair')
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
