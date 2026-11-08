import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createCallGraphEngine } from './call-graph-engine'

const { layout, workers } = vi.hoisted(() => ({
  layout: vi.fn(),
  workers: [] as Array<EventTarget & { terminate: ReturnType<typeof vi.fn> }>,
}))
vi.mock('elkjs/lib/elk-worker.min.js?worker', () => ({
  default: class extends EventTarget {
    terminate = vi.fn()
    constructor() {
      super()
      workers.push(this)
    }
  },
}))
vi.mock('elkjs/lib/elk-api.js', () => ({
  default: class {
    layout = layout
  },
}))

describe('call graph Worker lifecycle', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    workers.length = 0
    layout.mockReset().mockImplementation(async (graph) => graph)
  })
  afterEach(() => vi.useRealTimers())

  it('waits for warmup and releases request timers after successful layout', async () => {
    let ready!: (value: { id: string }) => void
    layout.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          ready = resolve
        })
    )
    const initialized = vi.fn()
    const creating = createCallGraphEngine(vi.fn()).then((engine) => {
      initialized()
      return engine
    })
    await Promise.resolve()
    expect(initialized).not.toHaveBeenCalled()
    ready({ id: 'warmup' })
    const engine = await creating
    expect(await engine.layout({ id: 'graph' })).toEqual({ id: 'graph' })
    expect(vi.getTimerCount()).toBe(0)
    expect(workers[0]?.terminate).not.toHaveBeenCalled()
  })

  it('rejects pending layouts on Worker failure and invalidates the cache once', async () => {
    const invalidate = vi.fn()
    const engine = await createCallGraphEngine(invalidate)
    layout.mockImplementation(() => new Promise(() => {}))
    const first = expect(engine.layout({ id: 'first' })).rejects.toThrow(
      'Worker crashed'
    )
    const second = expect(engine.layout({ id: 'second' })).rejects.toThrow(
      'Worker crashed'
    )
    workers[0]?.dispatchEvent(
      new ErrorEvent('error', { message: 'Worker crashed', cancelable: true })
    )
    await Promise.all([first, second])
    await expect(engine.layout({ id: 'later' })).rejects.toThrow(
      'Worker crashed'
    )
    expect(invalidate).toHaveBeenCalledOnce()
    expect(workers[0]?.terminate).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('bounds a Worker that never finishes initialization and permits a fresh engine', async () => {
    layout.mockImplementationOnce(() => new Promise(() => {}))
    const invalidate = vi.fn()
    const rejected = expect(createCallGraphEngine(invalidate)).rejects.toThrow(
      'timed out'
    )
    await vi.advanceTimersByTimeAsync(30_000)
    await rejected
    expect(invalidate).toHaveBeenCalledOnce()
    expect(workers[0]?.terminate).toHaveBeenCalledOnce()
    const replacement = await createCallGraphEngine(vi.fn())
    expect(await replacement.layout({ id: 'retry' })).toEqual({ id: 'retry' })
    expect(workers).toHaveLength(2)
  })

  it('rejects unreadable Worker messages instead of leaving the graph pending', async () => {
    layout.mockImplementationOnce(() => new Promise(() => {}))
    const rejected = expect(createCallGraphEngine(vi.fn())).rejects.toThrow(
      'unreadable'
    )
    workers[0]?.dispatchEvent(new MessageEvent('messageerror'))
    await rejected
    expect(vi.getTimerCount()).toBe(0)
  })
})
