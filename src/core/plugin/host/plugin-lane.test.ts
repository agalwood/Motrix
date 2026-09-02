import { describe, expect, it, vi } from 'vitest'
import { currentPluginCallChain, PluginLane } from './plugin-lane'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

describe('PluginLane', () => {
  it('serializes entries FIFO for one plugin', async () => {
    const lane = new PluginLane('alice.demo')
    const gate = deferred<void>()
    const order: string[] = []
    const first = lane.run(async () => {
      order.push('first:start')
      await gate.promise
      order.push('first:end')
    })
    const second = lane.run(() => {
      order.push('second')
    })

    await vi.waitFor(() => expect(order).toEqual(['first:start']))
    expect(lane.state()).toMatchObject({ running: 1, queued: 1 })
    gate.resolve()
    await Promise.all([first, second])
    expect(order).toEqual(['first:start', 'first:end', 'second'])
  })

  it('allows different plugin lanes to run concurrently', async () => {
    const gate = deferred<void>()
    const a = new PluginLane('alice.a')
    const b = new PluginLane('alice.b')
    const entered: string[] = []

    const first = a.run(async () => {
      entered.push('a')
      await gate.promise
    })
    const second = b.run(async () => {
      entered.push('b')
      await gate.promise
    })
    await vi.waitFor(() => expect(entered.sort()).toEqual(['a', 'b']))
    gate.resolve()
    await Promise.all([first, second])
  })

  it('rejects self and A -> B -> A cycles before enqueue', async () => {
    const a = new PluginLane('alice.a')
    const b = new PluginLane('alice.b')

    await expect(a.run(() => a.run(() => Promise.resolve()))).rejects.toThrow(
      'plugin.runtime.reentrant_call'
    )

    await expect(
      a.run(() =>
        b.run(() => {
          const chain = currentPluginCallChain()
          expect(chain?.plugins).toEqual(['alice.a', 'alice.b'])
          return a.run(() => Promise.resolve())
        })
      )
    ).rejects.toThrow('plugin.runtime.reentrant_call')
    expect(a.isDrained()).toBe(true)
    expect(b.isDrained()).toBe(true)
  })

  it('closes new admission and drains admitted work', async () => {
    const lane = new PluginLane('alice.demo')
    const gate = deferred<void>()
    const work = lane.run(() => gate.promise)
    await vi.waitFor(() => expect(lane.state().running).toBe(1))
    lane.close()
    await expect(lane.run(() => Promise.resolve())).rejects.toThrow(
      'plugin.runtime.admission_closed'
    )

    const drained = lane.drain()
    gate.resolve()
    await Promise.all([work, drained])
    expect(lane.isDrained()).toBe(true)
  })
})
