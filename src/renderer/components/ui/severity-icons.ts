import type { MotrixIcon } from '@renderer/components/icons'
import {
  InfoIcon,
  StatusBlockedIcon,
  StatusCompleteIcon,
  WarningIcon,
} from '@renderer/components/icons'

/**
 * Severity icons and accents for toast feedback. The notification center
 * uses category-specific icons in its persistent list. Toasts additionally
 * support 'success', beyond the persisted info/warning/error severities.
 */
export type SeverityIconKind = 'success' | 'info' | 'warning' | 'error'

export const SEVERITY_ICONS: Record<
  SeverityIconKind,
  { icon: MotrixIcon; iconClassName: string }
> = {
  success: { icon: StatusCompleteIcon, iconClassName: 'text-emerald-500' },
  info: { icon: InfoIcon, iconClassName: 'text-sky-500' },
  warning: { icon: WarningIcon, iconClassName: 'text-amber-500' },
  error: { icon: StatusBlockedIcon, iconClassName: 'text-destructive' },
}
