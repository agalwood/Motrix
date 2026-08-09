// Tests for LifecycleCapabilityHost — deactivate handler registry with budget.

import { describe, expect, it } from 'vitest'
import { LifecycleCapabilityHost, LifecycleError } from './lifecycle'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeHost(totalBudgetMs = 2000) {
  return new LifecycleCapabilityHost({ totalBudgetMs })
}

// ---------------------------------------------------------------------------
// LifecycleError
// ---------------------------------------------------------------------------

describe('LifecycleError', () => {
  it('has a code property and extends Error', () => {
    const err = new LifecycleError(
      'plugin.lifecycle.deactivate_timeout',
      'oops'
    )
    expect(err.code).toBe('plugin.lifecycle.deactivate_timeout')
    expect(err).toBeInstanceOf(Error)
    expect(err.name).toBe('LifecycleError')
    expect(err.message).toBe('oops')
  })
})

// ---------------------------------------------------------------------------
// count / registration basics
// ---------------------------------------------------------------------------

describe('LifecycleCapabilityHost — registration', () => {
  it('count returns 0 before any registration', () => {
    const host = makeHost()
    expect(host.count('plugin-a')).toBe(0)
  })

  it('registerOnDeactivate increments count; dispose() decrements it', () => {
    const host = makeHost()
    const reg = host.registerOnDeactivate('plugin-a', () => {})
    expect(host.count('plugin-a')).toBe(1)
    reg.dispose()
    expect(host.count('plugin-a')).toBe(0)
  })

  it('multiple handlers stack independently', () => {
    const host = makeHost()
    const r1 = host.registerOnDeactivate('plugin-a', () => {})
    const r2 = host.registerOnDeactivate('plugin-a', () => {})
    expect(host.count('plugin-a')).toBe(2)
    r1.dispose()
    expect(host.count('plugin-a')).toBe(1)
    r2.dispose()
    expect(host.count('plugin-a')).toBe(0)
  })

  it('dispose() is idempotent — calling twice does not throw', () => {
    const host = makeHost()
    const reg = host.registerOnDeactivate('plugin-a', () => {})
    reg.dispose()
    expect(() => reg.dispose()).not.toThrow()
    expect(host.count('plugin-a')).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// runDeactivate — ordering, async, clearing
// ---------------------------------------------------------------------------

describe('LifecycleCapabilityHost — runDeactivate', () => {
  it('runs handlers in registration order', async () => {
    const host = makeHost()
    const order: number[] = []
    host.registerOnDeactivate('plugin-a', () => {
      order.push(1)
    })
    host.registerOnDeactivate('plugin-a', () => {
      order.push(2)
    })
    host.registerOnDeactivate('plugin-a', () => {
      order.push(3)
    })
    await host.runDeactivate('plugin-a')
    expect(order).toEqual([1, 2, 3])
  })

  it('awaits async handlers — next handler runs only after previous resolves', async () => {
    const host = makeHost()
    const order: string[] = []

    host.registerOnDeactivate('plugin-a', async () => {
      await new Promise<void>((resolve) => setTimeout(resolve, 10))
      order.push('first-end')
    })
    host.registerOnDeactivate('plugin-a', () => {
      order.push('second-start')
    })

    await host.runDeactivate('plugin-a')
    expect(order).toEqual(['first-end', 'second-start'])
  })

  it('clears handlers after successful run (count is 0)', async () => {
    const host = makeHost()
    host.registerOnDeactivate('plugin-a', () => {})
    await host.runDeactivate('plugin-a')
    expect(host.count('plugin-a')).toBe(0)
  })

  it('resolves cleanly when no handlers are registered', async () => {
    const host = makeHost()
    await expect(host.runDeactivate('plugin-x')).resolves.toBeUndefined()
  })

  it('clears handlers even when a handler throws', async () => {
    const host = makeHost()
    host.registerOnDeactivate('plugin-a', () => {
      throw new Error('boom')
    })
    host.registerOnDeactivate('plugin-a', () => {})
    await expect(host.runDeactivate('plugin-a')).rejects.toThrow('boom')
    expect(host.count('plugin-a')).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// runDeactivate — handler error aborts remaining handlers
// ---------------------------------------------------------------------------

describe('LifecycleCapabilityHost — handler throw aborts the run', () => {
  it('subsequent handlers do NOT run after a throw', async () => {
    const host = makeHost()
    const ran: number[] = []
    host.registerOnDeactivate('plugin-a', () => {
      throw new Error('boom')
    })
    host.registerOnDeactivate('plugin-a', () => {
      ran.push(2)
    })

    await expect(host.runDeactivate('plugin-a')).rejects.toThrow('boom')
    expect(ran).toEqual([])
  })

  it('rejects with the original thrown error (not a LifecycleError)', async () => {
    const host = makeHost()
    const original = new Error('handler failed')
    host.registerOnDeactivate('plugin-a', () => {
      throw original
    })

    await expect(host.runDeactivate('plugin-a')).rejects.toBe(original)
  })
})

// ---------------------------------------------------------------------------
// Budget enforcement — real timers with tiny durations (< 200ms total)
// ---------------------------------------------------------------------------
// Note: fake timers deadlock in jsdom when handlers contain never-resolving
// promises. Real timers with ms-scale budgets are fast and reliable here.

describe('LifecycleCapabilityHost — budget timeout (real timers)', () => {
  it('rejects with deactivate_timeout when a single handler exceeds the budget', async () => {
    // 30ms budget; handler never resolves → timeout fires at ~30ms
    const host = makeHost(30)
    host.registerOnDeactivate('plugin-a', () => new Promise(() => {})) // never resolves

    await expect(host.runDeactivate('plugin-a')).rejects.toMatchObject({
      code: 'plugin.lifecycle.deactivate_timeout',
    })
  })

  it('rejects with deactivate_timeout when budget is consumed across two handlers', async () => {
    // handler1 sleeps 40ms, consuming most of a 50ms budget; handler2 gets
    // ≤10ms remaining and never resolves → timeout fires
    const host = makeHost(50)

    host.registerOnDeactivate(
      'plugin-a',
      () => new Promise<void>((resolve) => setTimeout(resolve, 40))
    )
    host.registerOnDeactivate('plugin-a', () => new Promise(() => {})) // never resolves

    await expect(host.runDeactivate('plugin-a')).rejects.toMatchObject({
      code: 'plugin.lifecycle.deactivate_timeout',
    })
  })

  it('rejects immediately (before running) if budget is already 0 at start of a handler', async () => {
    // handler1 sleeps 60ms; budget is 30ms → times out before handler1 resolves
    // handler2 should never start
    const host = makeHost(30)
    const ran: number[] = []

    host.registerOnDeactivate(
      'plugin-a',
      () => new Promise<void>((resolve) => setTimeout(resolve, 60))
    )
    host.registerOnDeactivate('plugin-a', () => {
      ran.push(2)
    }) // should never run

    await expect(host.runDeactivate('plugin-a')).rejects.toMatchObject({
      code: 'plugin.lifecycle.deactivate_timeout',
    })
    expect(ran).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// reset
// ---------------------------------------------------------------------------

describe('LifecycleCapabilityHost — reset', () => {
  it('removes all handlers without running them', async () => {
    const host = makeHost()
    const ran: boolean[] = []
    host.registerOnDeactivate('plugin-a', () => {
      ran.push(true)
    })
    host.registerOnDeactivate('plugin-a', () => {
      ran.push(true)
    })

    host.reset('plugin-a')
    expect(host.count('plugin-a')).toBe(0)
    expect(ran).toEqual([])

    // runDeactivate after reset should be a no-op
    await expect(host.runDeactivate('plugin-a')).resolves.toBeUndefined()
    expect(ran).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// Plugin isolation
// ---------------------------------------------------------------------------

describe('LifecycleCapabilityHost — plugin isolation', () => {
  it('different plugins have independent registries', async () => {
    const host = makeHost()
    const ranA: string[] = []
    const ranB: string[] = []

    host.registerOnDeactivate('plugin-a', () => {
      ranA.push('a')
    })
    host.registerOnDeactivate('plugin-b', () => {
      ranB.push('b')
    })

    expect(host.count('plugin-a')).toBe(1)
    expect(host.count('plugin-b')).toBe(1)

    await host.runDeactivate('plugin-a')
    expect(ranA).toEqual(['a'])
    expect(ranB).toEqual([]) // plugin-b untouched

    expect(host.count('plugin-a')).toBe(0)
    expect(host.count('plugin-b')).toBe(1) // still registered
  })
})
