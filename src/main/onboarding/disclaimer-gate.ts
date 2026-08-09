import type { OnboardingState } from '@shared/types/settings'

interface SettingsPort {
  get(): { onboarding: OnboardingState }
  acceptDisclaimer(): Promise<{ saved: boolean }>
}

export interface DisclaimerGateDeps {
  settings: SettingsPort
}

/**
 * A single-purpose startup gate. Consent is persisted before the blocked
 * main-process initialization is released.
 */
export class DisclaimerGate {
  private accepted: boolean
  private cancelled = false
  private acceptInFlight: Promise<void> | null = null
  private readonly decisionPromise: Promise<'accepted' | 'cancelled'>
  private resolveDecision: (decision: 'accepted' | 'cancelled') => void =
    () => {}

  constructor(private readonly deps: DisclaimerGateDeps) {
    this.accepted = deps.settings.get().onboarding.disclaimerAccepted
    this.decisionPromise = this.accepted
      ? Promise.resolve('accepted')
      : new Promise((resolve) => {
          this.resolveDecision = resolve
        })
  }

  isAccepted(): boolean {
    return this.accepted
  }

  waitForDecision(): Promise<'accepted' | 'cancelled'> {
    return this.decisionPromise
  }

  cancel(): void {
    if (this.accepted || this.cancelled) return
    this.cancelled = true
    this.resolveDecision('cancelled')
  }

  accept(): Promise<void> {
    if (this.accepted) return Promise.resolve()
    if (this.cancelled) {
      return Promise.reject(new Error('disclaimer gate is cancelled'))
    }
    if (this.acceptInFlight) return this.acceptInFlight

    this.acceptInFlight = this.persistAcceptance().finally(() => {
      this.acceptInFlight = null
    })
    return this.acceptInFlight
  }

  private async persistAcceptance(): Promise<void> {
    await this.deps.settings.acceptDisclaimer()
    if (this.cancelled) {
      throw new Error('disclaimer gate is cancelled')
    }
    this.accepted = true
    this.resolveDecision('accepted')
  }
}
