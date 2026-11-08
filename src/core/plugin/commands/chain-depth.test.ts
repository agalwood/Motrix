// src/core/plugin/commands/chain-depth.test.ts
import { describe, expect, it } from 'vitest'
import { ChainDepth } from './chain-depth'

describe('ChainDepth', () => {
  it('reports depth 0 for an unknown taskId', () => {
    const tracker = new ChainDepth()
    expect(tracker.current('t1')).toBe(0)
  })

  it('clamps at 0 when exit() is called more times than enter()', () => {
    const tracker = new ChainDepth()
    tracker.enter('t1')
    tracker.enter('t1')
    tracker.enter('t1')

    expect(() => {
      tracker.exit('t1')
      tracker.exit('t1')
      tracker.exit('t1')
      tracker.exit('t1')
      tracker.exit('t1')
    }).not.toThrow()

    expect(tracker.current('t1')).toBe(0)
  })

  it('handles interleaved enter/exit on the same task', () => {
    const tracker = new ChainDepth()
    expect(tracker.enter('t1')).toBe(1)
    expect(tracker.current('t1')).toBe(1)
    expect(tracker.enter('t1')).toBe(2)
    tracker.exit('t1')
    expect(tracker.current('t1')).toBe(1)
  })

  it('keeps t2 tracked after t1 drains to 0', () => {
    const tracker = new ChainDepth()
    tracker.enter('t1')
    tracker.enter('t2')
    tracker.enter('t2')

    expect(tracker.current('t1')).toBe(1)
    expect(tracker.current('t2')).toBe(2)
    tracker.exit('t1')
    expect(tracker.current('t1')).toBe(0)
    expect(tracker.current('t2')).toBe(2)
  })

  it('defaults max to 8', () => {
    const tracker = new ChainDepth()
    expect(tracker.max).toBe(8)
  })

  it('accepts a custom max', () => {
    const tracker = new ChainDepth(16)
    expect(tracker.max).toBe(16)
  })
})
