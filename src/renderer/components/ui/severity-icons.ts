import type { LucideIcon } from 'lucide-react'
import {
  CircleCheckIcon,
  InfoIcon,
  OctagonXIcon,
  TriangleAlertIcon,
} from 'lucide-react'

/**
 * Single source for a severity/type's icon + accent — shared by the toast
 * surface (`ui/toast.tsx`) and the notifications page
 * (`routes/notifications/notifications-page.tsx`) so the two never drift
 * apart. `'success'` only applies to toasts; the
 * notification center's `NotificationSeverity` (`info` | `warning` |
 * `error`) is a subset of this key set.
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
