import type { LegacyImportService } from '@core/legacy-import/import-service'
import { AppError, ErrorCode } from '@shared/errors'
import type { LegacyImportNavigationState } from '@shared/schemas/legacy-import'

/** Detection controls navigation only; it never blocks engine/task startup. */
export class LegacyImportNavigation {
  private state: LegacyImportNavigationState = {
    detected: false,
    invitationPending: false,
  }
  private discovery: Promise<LegacyImportNavigationState> | null = null
  constructor(
    private readonly deps: {
      hasConsent: () => boolean
      getService: () => Pick<
        LegacyImportService,
        'discover' | 'invitationDismissed'
      >
      roots: () => string[]
      changed: () => void
    }
  ) {}

  getState(): LegacyImportNavigationState {
    return { ...this.state }
  }

  detect(): Promise<LegacyImportNavigationState> {
    if (!this.deps.hasConsent())
      return Promise.reject(
        new AppError(
          ErrorCode.InvalidSelection,
          'legacyImport.errors.consentRequired'
        )
      )
    if (this.discovery) return this.discovery
    this.discovery = (async () => {
      const service = this.deps.getService()
      const sources = await service.discover(this.deps.roots())
      if (!this.deps.hasConsent()) return this.getState()
      this.state = {
        detected: this.state.detected || sources.length > 0,
        invitationPending: sources.length > 0 && !service.invitationDismissed(),
      }
      this.deps.changed()
      return this.getState()
    })().catch((error) => {
      this.discovery = null
      throw error
    })
    return this.discovery
  }

  sourceDetected(): void {
    this.state = { ...this.state, detected: true }
    this.deps.changed()
  }

  finishInvitation(): void {
    this.state = { ...this.state, invitationPending: false }
    this.deps.changed()
  }
}
