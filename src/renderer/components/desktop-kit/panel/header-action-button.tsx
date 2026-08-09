import { Button } from '@renderer/components/ui/button'
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@renderer/components/ui/tooltip'
import type React from 'react'
import { useCompactHeader } from '../hooks/use-compact-header'

// Compact buttons mirror the 28px window-chrome row (AddTaskTriggerButton
// is size-[28px] with a size-4 icon) so hit targets stay comfortable in
// the short header. Icons keep Button's default size-4.
export const COMPACT_ACTION_CLASS = 'h-7 px-1.5'

/**
 * A PanelShell header action that adapts to the compact header: full mode
 * renders an icon + label button, compact mode renders icon-only on the
 * 28px chrome row with the label in a tooltip. `aria-label` carries the
 * label in both modes so name-based queries stay stable.
 */
export function HeaderActionButton({
  label,
  visibleLabel,
  onClick,
  disabled = false,
  variant,
  wrapTrigger,
  children,
}: React.PropsWithChildren<{
  label: string
  /**
   * Optional shorter copy for the full header. The complete `label` remains
   * the accessible name and compact-mode tooltip.
   */
  visibleLabel?: string
  onClick?: () => void
  disabled?: boolean
  variant?: React.ComponentProps<typeof Button>['variant']
  /**
   * Wraps the inner Button (e.g. in a `DropdownMenuTrigger render={button}`) before
   * the compact tooltip composition, so popover/menu triggers share the same
   * chrome as plain click actions instead of re-implementing it.
   */
  wrapTrigger?: (button: React.ReactElement) => React.ReactElement
}>) {
  const compact = useCompactHeader()
  const inner = (
    <Button
      type="button"
      variant={variant}
      size="sm"
      aria-label={label}
      className={compact ? COMPACT_ACTION_CLASS : undefined}
      onClick={onClick}
      disabled={disabled}
    >
      {children}
      {compact ? null : (visibleLabel ?? label)}
    </Button>
  )
  const button = wrapTrigger ? wrapTrigger(inner) : inner

  if (!compact) return button
  // Self-contained provider keeps the component renderable outside
  // AppLayout's root TooltipProvider (tests, isolated mounts); nesting
  // under the app provider is harmless.
  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger render={button} />
        <TooltipContent>{label}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  )
}
