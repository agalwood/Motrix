import type { OnboardingState } from '@shared/types/settings'
import { describe, expect, it, vi } from 'vitest'
import { DisclaimerGate } from './disclaimer-gate'

function createSettings(disclaimerAccepted = false) {
  const onboarding: OnboardingState = { disclaimerAccepted }
  const acceptDisclaimer = vi.fn(async () => {
    onboarding.disclaimerAccepted = true
    return { saved: true }
  })
  return {
    onboarding,
    settings: {
      get: () => ({ onboarding }),
      acceptDisclaimer,
    },
    acceptDisclaimer,
  }
}

describe('DisclaimerGate', () => {
  it('starts open when consent was already persisted', async () => {
    const { settings, acceptDisclaimer } = createSettings(true)
    const gate = new DisclaimerGate({ settings })

    await expect(gate.waitForDecision()).resolves.toBe('accepted')
    expect(gate.isAccepted()).toBe(true)
    expect(acceptDisclaimer).not.toHaveBeenCalled()
  })

  it('persists consent before releasing startup', async () => {
    let finishWrite!: () => void
    const write = new Promise<void>((resolve) => {
      finishWrite = resolve
    })
    const { settings, acceptDisclaimer } = createSettings()
    acceptDisclaimer.mockImplementationOnce(async () => {
      await write
      return { saved: true }
    })
    const gate = new DisclaimerGate({ settings })
    let released = false
    void gate.waitForDecision().then(() => {
      released = true
    })

    const accepting = gate.accept()
    await Promise.resolve()
    expect(released).toBe(false)
    expect(gate.isAccepted()).toBe(false)

    finishWrite()
    await accepting
    await expect(gate.waitForDecision()).resolves.toBe('accepted')
    expect(acceptDisclaimer).toHaveBeenCalledOnce()
    expect(gate.isAccepted()).toBe(true)
    expect(released).toBe(true)
  })

  it('deduplicates concurrent acceptance requests', async () => {
    const { settings, acceptDisclaimer } = createSettings()
    const gate = new DisclaimerGate({ settings })

    await Promise.all([gate.accept(), gate.accept()])

    expect(acceptDisclaimer).toHaveBeenCalledOnce()
  })

  it('stays closed after a persistence failure and allows retry', async () => {
    const { settings, acceptDisclaimer } = createSettings()
    acceptDisclaimer.mockRejectedValueOnce(new Error('disk full'))
    const gate = new DisclaimerGate({ settings })

    await expect(gate.accept()).rejects.toThrow('disk full')
    expect(gate.isAccepted()).toBe(false)

    await expect(gate.accept()).resolves.toBeUndefined()
    expect(acceptDisclaimer).toHaveBeenCalledTimes(2)
    expect(gate.isAccepted()).toBe(true)
  })

  it('releases startup as cancelled without accepting consent', async () => {
    const { settings, acceptDisclaimer } = createSettings()
    const gate = new DisclaimerGate({ settings })

    gate.cancel()

    await expect(gate.waitForDecision()).resolves.toBe('cancelled')
    await expect(gate.accept()).rejects.toThrow('cancelled')
    expect(gate.isAccepted()).toBe(false)
    expect(acceptDisclaimer).not.toHaveBeenCalled()
  })

  it('does not reopen the gate when shutdown wins an in-flight save', async () => {
    let finishWrite!: () => void
    const write = new Promise<void>((resolve) => {
      finishWrite = resolve
    })
    const { settings, acceptDisclaimer } = createSettings()
    acceptDisclaimer.mockImplementationOnce(async () => {
      await write
      return { saved: true }
    })
    const gate = new DisclaimerGate({ settings })
    const accepting = gate.accept()

    gate.cancel()
    finishWrite()

    await expect(accepting).rejects.toThrow('cancelled')
    await expect(gate.waitForDecision()).resolves.toBe('cancelled')
    expect(gate.isAccepted()).toBe(false)
  })
})
