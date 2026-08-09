import { NatState, type NatStatus } from '@shared/types/nat'
import { describe, expect, it } from 'vitest'
import { isNatRetrying, isNatRunning, natBucket } from './nat-status'

function makeStatus(overrides: Partial<NatStatus> = {}): NatStatus {
  return {
    state: NatState.Active,
    enabled: true,
    activeMappings: [],
    gatewayInfo: null,
    lastError: null,
    lastDiagnostic: null,
    retryAttempt: 0,
    maxRetries: 3,
    ...overrides,
  }
}

describe('natBucket', () => {
  it('maps a null status to the off bucket', () => {
    expect(natBucket(null)).toEqual({ bucket: 'off', color: 'bg-gray-500' })
  })

  it('maps Active to the active bucket (green)', () => {
    expect(natBucket(makeStatus({ state: NatState.Active }))).toEqual({
      bucket: 'active',
      color: 'bg-green-500',
    })
  })

  it('maps Discovering/Mapping/Ready to the settingUp bucket (blue)', () => {
    for (const state of [
      NatState.Discovering,
      NatState.Mapping,
      NatState.Ready,
    ]) {
      expect(natBucket(makeStatus({ state }))).toEqual({
        bucket: 'settingUp',
        color: 'bg-blue-500',
      })
    }
  })

  it('locks Failed to settingUp while retry budget remains (anti-flicker)', () => {
    expect(
      natBucket(
        makeStatus({ state: NatState.Failed, retryAttempt: 1, maxRetries: 3 })
      )
    ).toEqual({ bucket: 'settingUp', color: 'bg-blue-500' })
  })

  it('maps dormant Failed (budget exhausted) to the failed bucket (red)', () => {
    expect(
      natBucket(
        makeStatus({ state: NatState.Failed, retryAttempt: 3, maxRetries: 3 })
      )
    ).toEqual({ bucket: 'failed', color: 'bg-red-500' })
  })

  it('maps Idle/Stopped/Stopping to the off bucket', () => {
    for (const state of [NatState.Idle, NatState.Stopped, NatState.Stopping]) {
      expect(natBucket(makeStatus({ state })).bucket).toBe('off')
    }
  })
})

describe('isNatRetrying', () => {
  it('is false for a null status', () => {
    expect(isNatRetrying(null)).toBe(false)
  })

  it('is false when no retry has been scheduled', () => {
    expect(isNatRetrying(makeStatus({ retryAttempt: 0 }))).toBe(false)
  })

  it('is true mid-retry', () => {
    expect(
      isNatRetrying(
        makeStatus({ state: NatState.Failed, retryAttempt: 2, maxRetries: 3 })
      )
    ).toBe(true)
  })

  it('is false for dormant Failed with the budget exhausted', () => {
    expect(
      isNatRetrying(
        makeStatus({ state: NatState.Failed, retryAttempt: 3, maxRetries: 3 })
      )
    ).toBe(false)
  })
})

describe('isNatRunning', () => {
  it('is false for a null status', () => {
    expect(isNatRunning(null)).toBe(false)
  })

  it('is true for the active/setup states', () => {
    for (const state of [
      NatState.Active,
      NatState.Discovering,
      NatState.Mapping,
      NatState.Ready,
    ]) {
      expect(isNatRunning(makeStatus({ state }))).toBe(true)
    }
  })

  it('is true for Failed while still retrying', () => {
    expect(
      isNatRunning(
        makeStatus({ state: NatState.Failed, retryAttempt: 1, maxRetries: 3 })
      )
    ).toBe(true)
  })

  it('is false for dormant Failed', () => {
    expect(
      isNatRunning(
        makeStatus({ state: NatState.Failed, retryAttempt: 3, maxRetries: 3 })
      )
    ).toBe(false)
  })

  it('is false when stopped', () => {
    expect(isNatRunning(makeStatus({ state: NatState.Stopped }))).toBe(false)
  })
})
