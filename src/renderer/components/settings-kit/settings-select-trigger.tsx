import { SelectTrigger } from '@renderer/components/ui/select'
import { cn } from '@renderer/lib/utils'
import type * as React from 'react'

type SettingsSelectTriggerProps = React.ComponentProps<typeof SelectTrigger>

/**
 * Keeps localized setting values compact without constraining them to the
 * width of the source-language copy. The underlying SelectTrigger uses
 * intrinsic width; these bounds preserve alignment and cap unusually long
 * values before the select's overflow treatment takes over.
 */
export function SettingsSelectTrigger({
  className,
  size = 'sm',
  ...props
}: SettingsSelectTriggerProps) {
  return (
    <SelectTrigger
      className={cn('min-w-30 max-w-64', className)}
      size={size}
      {...props}
    />
  )
}
