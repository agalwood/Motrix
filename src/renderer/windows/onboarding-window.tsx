import { DisclaimerStep } from '@renderer/components/onboarding/disclaimer-step'
import { OnboardingLanguageSelect } from '@renderer/components/onboarding/onboarding-language-select'
import { OnboardingSurface } from '@renderer/components/onboarding/onboarding-surface'
import { WindowChrome } from '@renderer/components/window-chrome/window-chrome'

export function OnboardingWindow() {
  return (
    <OnboardingSurface>
      <WindowChrome
        title="Motrix"
        variant="titled"
        compact
        maximizable={false}
        actionsPosition="end"
      >
        <OnboardingLanguageSelect />
      </WindowChrome>
      <DisclaimerStep />
    </OnboardingSurface>
  )
}
