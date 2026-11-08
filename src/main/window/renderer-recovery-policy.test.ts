import { describe, expect, it } from 'vitest'
import {
  classifyRendererExit,
  RendererRecoveryBudget,
} from './renderer-recovery-policy'

describe('renderer recovery budget', () => {
  it('limits a logical window across replacements and preserves history after manual recovery', () => {
    let now = 0
    const budget = new RendererRecoveryBudget(() => now)
    expect(budget.reserveAutomatic(['main'])).toEqual({
      delay: 1_000,
      attempt: 1,
    })
    expect(budget.reserveManual('main')).toBe(true)
    expect(budget.reserveManual('main')).toBe(false)
    now = 60_000
    expect(budget.reserveAutomatic(['main'])).toEqual({
      delay: 5_000,
      attempt: 2,
    })
    expect(budget.reserveAutomatic(['main'])).toBeNull()
    now = 600_001
    expect(budget.reserveAutomatic(['main'])?.attempt).toBe(2)
  })

  it('charges shared-process incidents once globally and each affected window', () => {
    const budget = new RendererRecoveryBudget(() => 0)
    expect(budget.reserveAutomatic(['main', 'add-task', 'main'])).not.toBeNull()
    expect(budget.reserveAutomatic(['main'])).not.toBeNull()
    expect(budget.reserveAutomatic(['main'])).toBeNull()
    expect(budget.reserveAutomatic(['add-task'])).not.toBeNull()
    expect(budget.reserveAutomatic(['onboarding'])).not.toBeNull()
    expect(budget.reserveAutomatic(['onboarding'])).toBeNull()
  })

  it('allows only one memory-pressure retry in the rolling window', () => {
    const budget = new RendererRecoveryBudget(() => 0)
    expect(budget.reserveAutomatic(['main'], true)?.delay).toBe(10_000)
    expect(budget.reserveAutomatic(['main'], true)).toBeNull()
    expect(budget.reserveAutomatic([])).toBeNull()
  })

  it('blocks launch, integrity, and unknown failures without treating unexpected clean exits as intentional', () => {
    expect(classifyRendererExit('clean-exit')).toBe('recover')
    expect(classifyRendererExit('oom')).toBe('memory')
    expect(classifyRendererExit('memory-eviction')).toBe('memory')
    for (const reason of ['launch-failed', 'integrity-failure', 'future']) {
      expect(classifyRendererExit(reason)).toBe('block')
    }
  })
})
