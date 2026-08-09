import type { OnboardingState } from '@shared/types/settings'
import { z } from 'zod'

export const onboardingStateSchema = z
  .object({
    disclaimerAccepted: z.boolean().catch(false),
  })
  .catch({ disclaimerAccepted: false })

export const DEFAULT_ONBOARDING_STATE: OnboardingState =
  onboardingStateSchema.parse({})
