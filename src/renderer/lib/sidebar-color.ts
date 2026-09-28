import { DEFAULT_APP_SETTINGS } from '@shared/schemas/app-settings'
import type { SidebarColor } from '@shared/schemas/sidebar-color'
import { create } from 'zustand'

/** Persisted transport mirror plus the appearance dialog's temporary preview. */
export const useSidebarColorState = create<{
  saved: SidebarColor
  preview: SidebarColor | null
  revision: number
}>(() => ({
  saved: DEFAULT_APP_SETTINGS.sidebarColor,
  preview: null,
  revision: 0,
}))
