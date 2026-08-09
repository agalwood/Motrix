// src/core/plugin/circuit/circuit-breaker.test.ts

import { describe, expect, it, vi } from 'vitest'
import { CircuitBreaker } from './circuit-breaker'

const DAY_MS = 24 * 60 * 60 * 1000

describe('CircuitBreaker', () => {
  it('fresh breaker: isOpen returns false, failureCount returns 0', () => {
    const breaker = new CircuitBreaker()
    expect(breaker.isOpen('p1', 'beforeCreate')).toBe(false)
    expect(breaker.failureCount('p1', 'beforeCreate')).toBe(0)
  })

  it('single failure: failureCount is 1, isOpen stays false', () => {
    const t = 0
    const breaker = new CircuitBreaker({ now: () => t })
    breaker.failure('p1', 'beforeCreate')
    expect(breaker.failureCount('p1', 'beforeCreate')).toBe(1)
    expect(breaker.isOpen('p1', 'beforeCreate')).toBe(false)
  })

  it('3 consecutive failures flip the breaker open', () => {
    const t = 0
    const breaker = new CircuitBreaker({ now: () => t })
    breaker.failure('p1', 'beforeCreate')
    breaker.failure('p1', 'beforeCreate')
    expect(breaker.isOpen('p1', 'beforeCreate')).toBe(false)
    breaker.failure('p1', 'beforeCreate')
    expect(breaker.isOpen('p1', 'beforeCreate')).toBe(true)
    expect(breaker.failureCount('p1', 'beforeCreate')).toBe(3)
  })

  it('onOpen fires exactly once when the threshold is crossed', () => {
    const t = 0
    const onOpen = vi.fn()
    const breaker = new CircuitBreaker({ now: () => t, onOpen })
    breaker.failure('p1', 'hook')
    breaker.failure('p1', 'hook')
    expect(onOpen).not.toHaveBeenCalled()
    breaker.failure('p1', 'hook')
    expect(onOpen).toHaveBeenCalledOnce()
    expect(onOpen).toHaveBeenCalledWith('p1', 'hook', 'consecutive failures: 3')
    // A 4th failure must NOT fire onOpen again
    breaker.failure('p1', 'hook')
    expect(onOpen).toHaveBeenCalledOnce()
  })

  it('success resets the counter: 2 failures → success → 2 more → still closed', () => {
    const t = 0
    const breaker = new CircuitBreaker({ now: () => t })
    breaker.failure('p1', 'beforeCreate')
    breaker.failure('p1', 'beforeCreate')
    breaker.success('p1', 'beforeCreate')
    expect(breaker.failureCount('p1', 'beforeCreate')).toBe(0)
    breaker.failure('p1', 'beforeCreate')
    breaker.failure('p1', 'beforeCreate')
    expect(breaker.isOpen('p1', 'beforeCreate')).toBe(false)
    expect(breaker.failureCount('p1', 'beforeCreate')).toBe(2)
  })

  it('decay closes the breaker after 24 h + 1 ms', () => {
    let t = 0
    const breaker = new CircuitBreaker({ now: () => t })
    breaker.failure('p1', 'beforeCreate')
    breaker.failure('p1', 'beforeCreate')
    breaker.failure('p1', 'beforeCreate')
    expect(breaker.isOpen('p1', 'beforeCreate')).toBe(true)
    // Advance clock past the decay window
    t += DAY_MS + 1
    expect(breaker.isOpen('p1', 'beforeCreate')).toBe(false)
    // Record should have been cleared — failureCount returns 0
    expect(breaker.failureCount('p1', 'beforeCreate')).toBe(0)
  })

  it('multiple plugins / hooks are isolated from each other', () => {
    const t = 0
    const breaker = new CircuitBreaker({ now: () => t })
    // Trip p1 / beforeCreate
    breaker.failure('p1', 'beforeCreate')
    breaker.failure('p1', 'beforeCreate')
    breaker.failure('p1', 'beforeCreate')
    expect(breaker.isOpen('p1', 'beforeCreate')).toBe(true)
    // p2 / beforeCreate is unaffected
    expect(breaker.isOpen('p2', 'beforeCreate')).toBe(false)
    expect(breaker.failureCount('p2', 'beforeCreate')).toBe(0)
    // p1 / beforeFinalize is a separate key
    expect(breaker.isOpen('p1', 'beforeFinalize')).toBe(false)
    expect(breaker.failureCount('p1', 'beforeFinalize')).toBe(0)
  })

  it('reset clears all state for the key', () => {
    const t = 0
    const breaker = new CircuitBreaker({ now: () => t })
    breaker.failure('p1', 'beforeCreate')
    breaker.failure('p1', 'beforeCreate')
    breaker.failure('p1', 'beforeCreate')
    expect(breaker.isOpen('p1', 'beforeCreate')).toBe(true)
    breaker.reset('p1', 'beforeCreate')
    expect(breaker.isOpen('p1', 'beforeCreate')).toBe(false)
    expect(breaker.failureCount('p1', 'beforeCreate')).toBe(0)
  })

  it('decay within failure(): last failure > decayMs ago restarts counter from 1', () => {
    let t = 0
    const onOpen = vi.fn()
    const breaker = new CircuitBreaker({ now: () => t, onOpen })
    breaker.failure('p1', 'beforeCreate')
    breaker.failure('p1', 'beforeCreate')
    expect(breaker.failureCount('p1', 'beforeCreate')).toBe(2)
    // Advance past decay before a 3rd failure
    t += DAY_MS + 1
    breaker.failure('p1', 'beforeCreate')
    // Counter restarted at 1, not 3 — so breaker stays closed
    expect(breaker.failureCount('p1', 'beforeCreate')).toBe(1)
    expect(breaker.isOpen('p1', 'beforeCreate')).toBe(false)
    expect(onOpen).not.toHaveBeenCalled()
  })

  it('custom failureThreshold of 2 trips the breaker on 2nd consecutive failure', () => {
    const t = 0
    const breaker = new CircuitBreaker({ now: () => t, failureThreshold: 2 })
    breaker.failure('p1', 'hook')
    expect(breaker.isOpen('p1', 'hook')).toBe(false)
    breaker.failure('p1', 'hook')
    expect(breaker.isOpen('p1', 'hook')).toBe(true)
  })
})
