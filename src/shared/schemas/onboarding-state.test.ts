import { describe, expect, it } from 'vitest'
import {
  DEFAULT_ONBOARDING_STATE,
  onboardingStateSchema,
} from './onboarding-state'

describe('onboardingStateSchema', () => {
  it('defaults disclaimer consent to false', () => {
    expect(onboardingStateSchema.parse({})).toEqual({
      disclaimerAccepted: false,
    })
    expect(DEFAULT_ONBOARDING_STATE).toEqual({ disclaimerAccepted: false })
  })

  it('preserves accepted disclaimer consent', () => {
    expect(onboardingStateSchema.parse({ disclaimerAccepted: true })).toEqual({
      disclaimerAccepted: true,
    })
  })

  it('falls back safely for invalid persisted values', () => {
    expect(onboardingStateSchema.parse({ disclaimerAccepted: 'yes' })).toEqual({
      disclaimerAccepted: false,
    })
    expect(onboardingStateSchema.parse(null)).toEqual({
      disclaimerAccepted: false,
    })
  })
})
