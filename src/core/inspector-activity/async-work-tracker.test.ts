import { describe, expect, it, vi } from 'vitest'
import { AsyncWorkTracker } from './async-work-tracker'

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((onResolve, onReject) => {
    resolve = onResolve
    reject = onReject
  })
  return { promise, reject, resolve }
}

describe('AsyncWorkTracker', () => {
  it('gates new work and drains every operation accepted before shutdown', async () => {
    const tracker = new AsyncWorkTracker()
    const first = deferred<void>()
    const second = deferred<void>()
    const firstWork = tracker.run(() => first.promise)
    const secondWork = tracker.run(() => second.promise)

    expect(tracker.isAccepting()).toBe(true)
    const drain = tracker.stopAndDrain()
    expect(tracker.isAccepting()).toBe(false)
    expect(tracker.stopAndDrain()).toBe(drain)

    let drained = false
    void drain.then(() => {
      drained = true
    })
    await Promise.resolve()
    expect(drained).toBe(false)

    await expect(
      tracker.run(async () => {
        throw new Error('must not start')
      })
    ).rejects.toThrow('stopped')

    first.resolve()
    await firstWork
    await Promise.resolve()
    expect(drained).toBe(false)

    second.resolve()
    await secondWork
    await drain
    expect(drained).toBe(true)
  })

  it('waits for rejected work without changing the original rejection', async () => {
    const tracker = new AsyncWorkTracker()
    const error = new Error('sync failed')
    const work = tracker.run(async () => {
      throw error
    })
    const observed = vi.fn()
    void work.catch(observed)

    await expect(tracker.stopAndDrain()).resolves.toBeUndefined()
    expect(observed).toHaveBeenCalledWith(error)
  })
})
