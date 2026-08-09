import type { Worker } from 'node:worker_threads'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CapabilityBridge } from '../host/capability-bridge'
import { newHookAbort } from './abort'

function makeBridge(): CapabilityBridge & {
  notifyAbort: ReturnType<typeof vi.fn>
} {
  return { notifyAbort: vi.fn() } as unknown as CapabilityBridge & {
    notifyAbort: ReturnType<typeof vi.fn>
  }
}

function makeWorker(): Worker & { terminate: ReturnType<typeof vi.fn> } {
  return {
    terminate: vi.fn().mockResolvedValue(0),
  } as unknown as Worker & { terminate: ReturnType<typeof vi.fn> }
}

describe('newHookAbort', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('timer triggers abort with reason "timeout"', async () => {
    const bridge = makeBridge()
    const worker = makeWorker()
    const budget = newHookAbort(bridge, worker, 50)

    expect(budget.signal.aborted).toBe(false)

    await vi.advanceTimersByTimeAsync(50)

    expect(budget.signal.aborted).toBe(true)
    expect(budget.signal.reason).toBe('timeout')
  })

  it('explicit abort cancels timer; bridge.notifyAbort called exactly once', async () => {
    const bridge = makeBridge()
    const worker = makeWorker()
    const budget = newHookAbort(bridge, worker, 200)

    budget.abort('manual')

    // Advance past original timeout — the timer should have been cleared.
    await vi.advanceTimersByTimeAsync(500)

    expect(budget.signal.aborted).toBe(true)
    expect(budget.signal.reason).toBe('manual')
    // Even with time advancing past the deadline, notifyAbort fires only once.
    expect(bridge.notifyAbort).toHaveBeenCalledTimes(1)
  })

  it('bridge.notifyAbort is called once when timeout fires', async () => {
    const bridge = makeBridge()
    const worker = makeWorker()
    newHookAbort(bridge, worker, 30)

    await vi.advanceTimersByTimeAsync(30)

    expect(bridge.notifyAbort).toHaveBeenCalledTimes(1)
  })

  it('terminate: signal is aborted before worker.terminate is called', async () => {
    const bridge = makeBridge()
    const worker = makeWorker()
    const budget = newHookAbort(bridge, worker, 10_000)

    const terminatePromise = budget.terminate()

    // Signal must be aborted immediately, before the 1 s grace elapses.
    expect(budget.signal.aborted).toBe(true)
    expect(worker.terminate).not.toHaveBeenCalled()

    // Advance through the 1 s grace period.
    await vi.advanceTimersByTimeAsync(1_000)
    await terminatePromise

    expect(worker.terminate).toHaveBeenCalledTimes(1)
  })

  it('abort.signal.reason matches the passed reason on explicit abort', () => {
    const bridge = makeBridge()
    const worker = makeWorker()
    const budget = newHookAbort(bridge, worker, 5_000)

    budget.abort('plugin_timeout')

    expect(budget.signal.reason).toBe('plugin_timeout')
  })
})
