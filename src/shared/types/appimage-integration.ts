// Renderer-facing view of the Linux AppImage desktop-integration state.
// The full persisted record (previous handlers, install id, icon hash) stays
// private to the main-process integration module; the settings UI only needs
// the decision/ownership/health triple plus whether the environment supports
// integration at all (packaged Linux AppImage).

export type AppImageIntegrationDecision = 'unset' | 'accepted' | 'declined'
export type AppImageIntegrationOwner = 'self' | 'external' | null
export type AppImageIntegrationHealth = 'healthy' | 'failed' | null

export type AppImageIntegrationView =
  | { supported: false }
  | {
      supported: true
      decision: AppImageIntegrationDecision
      owner: AppImageIntegrationOwner
      status: AppImageIntegrationHealth
    }
