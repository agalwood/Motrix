import { z } from 'zod'

// Explicit colors describe the artwork, not the panel background.
export const trayIconColorSchema = z.enum(['auto', 'light', 'dark'])
export type TrayIconColor = z.infer<typeof trayIconColorSchema>
export const DEFAULT_TRAY_ICON_COLOR: TrayIconColor = 'auto'
