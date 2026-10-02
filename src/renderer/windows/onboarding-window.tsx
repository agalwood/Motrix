import { DisclaimerStep } from '@renderer/components/onboarding/disclaimer-step'
import { OnboardingLanguageSelect } from '@renderer/components/onboarding/onboarding-language-select'
import { OnboardingSurface } from '@renderer/components/onboarding/onboarding-surface'
import { WindowChrome } from '@renderer/components/window-chrome/window-chrome'
import { LegacyImportDialog } from '@renderer/features/legacy-import/legacy-import-dialog'
import { transport } from '@renderer/lib/transport'
import { Queries } from '@shared/protocol/queries'
import { useEffect, useState } from 'react'

export function OnboardingWindow() {
  const [importInvitation, setImportInvitation] = useState(false)
  useEffect(() => {
    let disposed = false
    void transport
      .invoke(Queries.GetDisclaimerState)
      .then((result) => {
        if (
          !disposed &&
          (result as { disclaimerAccepted?: boolean })?.disclaimerAccepted
        )
          setImportInvitation(true)
      })
      .catch(() => {})
    return () => {
      disposed = true
    }
  }, [])
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
      {importInvitation ? (
        <LegacyImportDialog open invitation onClose={() => {}} />
      ) : (
        <DisclaimerStep onImportInvitation={() => setImportInvitation(true)} />
      )}
    </OnboardingSurface>
  )
}
