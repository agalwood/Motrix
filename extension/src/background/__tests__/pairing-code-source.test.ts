import { describe, expect, it } from 'vitest'
import { createPairingCodeSource } from '@/background/pairing-code-source'

function makeRequest(overrides: { timeoutMs?: number } = {}) {
  return {
    instanceId: 'motrix-desktop-1',
    timeoutMs: overrides.timeoutMs ?? 5000,
    run: 1,
    attemptsRemaining: 2,
  }
}

describe('createPairingCodeSource', () => {
  it('rejects at timeoutMs when nobody submits by the deadline', async () => {
    let firedCallback: (() => void) | null = null
    const source = createPairingCodeSource({
      setTimeout: (callback) => {
        firedCallback = callback
        return 'timer-handle'
      },
      clearTimeout: () => {},
    })

    const pending = source.provider(makeRequest({ timeoutMs: 5000 }))

    // This is the assertion a "delete the setTimeout" mutation breaks:
    // without it, nothing ever schedules a callback, so this stays null and
    // the test fails here instead of timing out 5000ms later on a promise
    // that never rejects.
    expect(firedCallback).not.toBeNull()
    ;(firedCallback as unknown as () => void)()

    await expect(pending).rejects.toThrow(/timed out after 5000ms/)
  })

  it('resolves and cancels the timer when submit answers before the deadline', async () => {
    const cleared: unknown[] = []
    const source = createPairingCodeSource({
      setTimeout: () => 'timer-handle',
      clearTimeout: (handle) => cleared.push(handle),
    })

    const pending = source.provider(makeRequest())
    const accepted = source.submit('MTX7K2Q9')

    expect(accepted).toBe(true)
    await expect(pending).resolves.toBe('MTX7K2Q9')
    expect(cleared).toEqual(['timer-handle'])
  })

  it('submit is a no-op when nothing is pending', () => {
    const source = createPairingCodeSource()
    expect(source.submit('MTX7K2Q9')).toBe(false)
  })

  it('submit is a no-op once the deadline has already fired', async () => {
    let firedCallback: (() => void) | null = null
    const source = createPairingCodeSource({
      setTimeout: (callback) => {
        firedCallback = callback
        return 'timer-handle'
      },
      clearTimeout: () => {},
    })

    const pending = source.provider(makeRequest())
    ;(firedCallback as unknown as () => void)()
    await expect(pending).rejects.toThrow(/timed out/)

    expect(source.submit('TOO-LATE1')).toBe(false)
  })

  it('exposes the pending request via getPending until it settles', async () => {
    const source = createPairingCodeSource({ now: () => 1_000 })
    expect(source.getPending()).toBeNull()

    const pending = source.provider(makeRequest({ timeoutMs: 2_000 }))
    expect(source.getPending()).toEqual({
      request: makeRequest({ timeoutMs: 2_000 }),
      deadlineMs: 3_000,
    })

    source.submit('MTX7K2Q9')
    await pending
    expect(source.getPending()).toBeNull()
  })

  it('keeps a replacement request submit-able after the prior timer fires', async () => {
    const timers: Array<() => void> = []
    const source = createPairingCodeSource({
      setTimeout: (callback) => {
        timers.push(callback)
        return timers.length
      },
      clearTimeout: () => {},
    })
    const firstRequest = makeRequest({ timeoutMs: 1_000 })
    const replacementRequest = {
      ...makeRequest({ timeoutMs: 2_000 }),
      instanceId: 'motrix-desktop-2',
    }
    const first = source.provider(firstRequest)
    const firstOutcome = first.catch((error: unknown) => error)
    const replacement = source.provider(replacementRequest)

    timers[0]?.()

    await expect(firstOutcome).resolves.toEqual(expect.any(Error))
    expect(source.getPending()).toEqual({
      request: replacementRequest,
      deadlineMs: expect.any(Number),
    })
    expect(source.submit('MTX7K2Q9')).toBe(true)
    await expect(replacement).resolves.toBe('MTX7K2Q9')
    expect(source.getPending()).toBeNull()
  })
})
