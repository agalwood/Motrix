import { describe, expect, it } from 'vitest'
import { GenerationGuard, TransitionMutex } from './state-machine'

describe('TransitionMutex', () => {
  it('allows only one transition in flight', async () => {
    const m = new TransitionMutex()
    const firstDone: Promise<void> = m.runExclusive(async () => {
      await new Promise((r) => setTimeout(r, 20))
    })
    const secondResult = await m
      .runExclusive(async () => 'ran')
      .catch((e: Error) => e.message)
    // Second should be rejected as busy
    expect(secondResult).toMatch(/busy/)
    await firstDone
  })

  it('releases lock after the first completes', async () => {
    const m = new TransitionMutex()
    await m.runExclusive(async () => {})
    const r = await m.runExclusive(async () => 'ok')
    expect(r).toBe('ok')
  })

  it('releases lock if the operation throws', async () => {
    const m = new TransitionMutex()
    await m
      .runExclusive(async () => {
        throw new Error('boom')
      })
      .catch(() => {})
    const r = await m.runExclusive(async () => 'ok')
    expect(r).toBe('ok')
  })
})

describe('GenerationGuard', () => {
  it('tracks the current generation', () => {
    const g = new GenerationGuard()
    expect(g.current()).toBe(0)
    g.bump()
    expect(g.current()).toBe(1)
  })

  it('identifies stale generations', () => {
    const g = new GenerationGuard()
    const gen = g.current()
    g.bump()
    expect(g.isCurrent(gen)).toBe(false)
    expect(g.isCurrent(g.current())).toBe(true)
  })
})
