import { create } from 'zustand'

const STORAGE_KEY = 'motrix.legacy-import.sidebar-dismissed'

function readDismissed(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) === 'true'
  } catch {
    return false
  }
}

interface LegacyImportSidebarState {
  dismissed: boolean
  dismiss: () => void
}

export function createLegacyImportSidebarStore() {
  return create<LegacyImportSidebarState>((set) => ({
    dismissed: readDismissed(),
    dismiss: () => {
      try {
        localStorage.setItem(STORAGE_KEY, 'true')
      } catch {
        // Keep the entry hidden for this session if storage is unavailable.
      }
      set({ dismissed: true })
    },
  }))
}

// Explicitly skipping hides the sidebar entry independently of the startup invitation.
export const useLegacyImportSidebar = createLegacyImportSidebarStore()
