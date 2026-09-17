import type { LucideIcon } from 'lucide-react'
import {
  CircleCheckIcon,
  InfoIcon,
  OctagonXIcon,
  TriangleAlertIcon,
} from 'lucide-react'

/**
 * Severity icons and accents for toast feedback. The notification center
 * uses category-specific icons in its persistent list. Toasts additionally
 * support 'success', beyond the persisted info/warning/error severities.
 */
export type SeverityIconKind = 'success' | 'info' | 'warning' | 'error'

export const SEVERITY_ICONS: Record<
  SeverityIconKind,
  { icon: LucideIcon; iconClassName: string }
> = {
  success: { icon: CircleCheckIcon, iconClassName: 'text-emerald-500' },
  info: { icon: InfoIcon, iconClassName: 'text-sky-500' },
  warning: { icon: TriangleAlertIcon, iconClassName: 'text-amber-500' },
  error: { icon: OctagonXIcon, iconClassName: 'text-destructive' },
}
