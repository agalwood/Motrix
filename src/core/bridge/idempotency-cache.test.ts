import { describe, expect, it } from 'vitest'
import { IdempotencyCache } from './idempotency-cache'

function deferred<T>() {
  let resolve!: (v: T) => void
  let reject!: (e: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

describe('IdempotencyCache', () => {
  it('shares a pending promise across replays', async () => {
    const cache = new IdempotencyCache<string>()
    const d = deferred<string>()
    let calls = 0
    const exec = () => {
      calls++
      return d.promise
    }
    const first = cache.run('k', exec)
    const replay = cache.run('k', exec)
    expect(replay).toBe(first)
    d.resolve('r')
    await expect(first).resolves.toBe('r')
    expect(calls).toBe(1)
  })

  it('returns the settled result without re-executing', async () => {
    const cache = new IdempotencyCache<string>()
    let calls = 0
    await cache.run('k', async () => {
      calls++
      return 'r1'
    })
    const again = await cache.run('k', async () => {
      calls++
      return 'r2'
    })
    expect(again).toBe('r1')
    expect(calls).toBe(1)
  })

  it('evicts a rejected entry so a retry re-executes', async () => {
    const cache = new IdempotencyCache<string>()
    let calls = 0
    await expect(
      cache.run('k', async () => {
        calls++
        throw new Error('boom')
      })
    ).rejects.toThrow('boom')
    await expect(
      cache.run('k', async () => {
        calls++
        return 'ok'
      })
    ).resolves.toBe('ok')
    expect(calls).toBe(2)
  })

  it('after a rejection, a newer entry reusing the key is served intact', async () => {
    const cache = new IdempotencyCache<string>()
    const slow = deferred<string>()
    const p1 = cache.run('k', () => slow.promise)
    slow.reject(new Error('boom'))
    await expect(p1).rejects.toThrow('boom')
    await cache.run('k', async () => 'newer')
    await expect(cache.run('k', async () => 'x')).resolves.toBe('newer')
  })

  it('capacity eviction removes only settled entries', async () => {
    const cache = new IdempotencyCache<string>(2)
    const pending = deferred<string>()
    const kept = cache.run('pending', () => pending.promise)
    await cache.run('settled', async () => 's')
    await cache.run('new', async () => 'n')
    let calls = 0
    const replay = cache.run('pending', async () => {
      calls++
      return 'dupe'
    })
    pending.resolve('orig')
    await expect(kept).resolves.toBe('orig')
    await expect(replay).resolves.toBe('orig')
    expect(calls).toBe(0)
    await expect(cache.run('settled', async () => 's2')).resolves.toBe('s2')
  })
})
