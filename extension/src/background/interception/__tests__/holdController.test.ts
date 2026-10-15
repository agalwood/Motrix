import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createHold,
  type HoldIo,
} from '@/background/interception/holdController'

function makeIo(): HoldIo & {
  suggest: ReturnType<typeof vi.fn>
  cancel: ReturnType<typeof vi.fn>
  erase: ReturnType<typeof vi.fn>
} {
  return {
    suggest: vi.fn(),
    cancel: vi.fn(async () => {}),
    erase: vi.fn(async () => {}),
  }
}

afterEach(() => {
  vi.useRealTimers()
})

describe('createHold', () => {
  it('release calls suggest exactly once, even when called twice', () => {
    const io = makeIo()
    const hold = createHold(io, 12_000)
    hold.release()
    hold.release()
    expect(io.suggest).toHaveBeenCalledTimes(1)
    expect(hold.released()).toBe(true)
    hold.dispose()
  })

  it('release swallows a throwing suggest (determination may be gone)', () => {
    const io = makeIo()
    io.suggest.mockImplementation(() => {
      throw new Error('kNotInProgress')
    })
    const hold = createHold(io, 12_000)
    expect(() => hold.release()).not.toThrow()
    expect(hold.released()).toBe(true)
    hold.dispose()
  })

  it('cancelNative cancels then erases; a later release never suggests', async () => {
    const io = makeIo()
    const hold = createHold(io, 12_000)
    await hold.cancelNative()
    expect(io.cancel).toHaveBeenCalledTimes(1)
    expect(io.erase).toHaveBeenCalledTimes(1)
    expect(hold.committed()).toBe(true)
    hold.release()
    expect(io.suggest).not.toHaveBeenCalled()
    hold.dispose()
  })

  it('cancelNative after release rejects without touching the download', async () => {
    const io = makeIo()
    const hold = createHold(io, 12_000)
    hold.release()
    await expect(hold.cancelNative()).rejects.toThrow(
      'determination already released'
    )
    expect(io.cancel).not.toHaveBeenCalled()
    expect(hold.committed()).toBe(false)
    hold.dispose()
  })

  it('a failing cancel leaves the hold uncommitted so release still suggests', async () => {
    const io = makeIo()
    io.cancel.mockImplementation(async () => {
      throw new Error('cancel failed')
    })
    const hold = createHold(io, 12_000)
    await expect(hold.cancelNative()).rejects.toThrow('cancel failed')
    expect(hold.committed()).toBe(false)
    hold.release()
    expect(io.suggest).toHaveBeenCalledTimes(1)
    hold.dispose()
  })

  it('a failing erase is swallowed; commit stands', async () => {
    const io = makeIo()
    io.erase.mockImplementation(async () => {
      throw new Error('erase failed')
    })
    const hold = createHold(io, 12_000)
    await expect(hold.cancelNative()).resolves.toBeUndefined()
    expect(hold.committed()).toBe(true)
    hold.dispose()
  })

  it('the deadline releases the hold and poisons later commits', async () => {
    vi.useFakeTimers()
    const io = makeIo()
    const hold = createHold(io, 12_000)
    vi.advanceTimersByTime(12_000)
    expect(io.suggest).toHaveBeenCalledTimes(1)
    await expect(hold.cancelNative()).rejects.toThrow(
      'determination already released'
    )
    hold.dispose()
  })

  it('starting a commit disarms the deadline (no suggest during in-flight cancel)', async () => {
    vi.useFakeTimers()
    const io = makeIo()
    let resolveCancel: (() => void) | undefined
    io.cancel.mockImplementation(
      () => new Promise<void>((r) => (resolveCancel = r))
    )
    const hold = createHold(io, 12_000)
    const commit = hold.cancelNative()
    vi.advanceTimersByTime(12_000) // deadline elapses while cancel is in flight
    expect(io.suggest).not.toHaveBeenCalled()
    resolveCancel?.()
    await commit
    expect(hold.committed()).toBe(true)
    expect(io.erase).toHaveBeenCalledTimes(1)
    expect(io.suggest).not.toHaveBeenCalled()
    hold.dispose()
  })

  it('dispose stops the deadline timer', () => {
    vi.useFakeTimers()
    const io = makeIo()
    const hold = createHold(io, 12_000)
    hold.dispose()
    vi.advanceTimersByTime(60_000)
    expect(io.suggest).not.toHaveBeenCalled()
  })
})
