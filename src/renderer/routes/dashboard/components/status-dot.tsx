import { cn } from '@renderer/lib/utils'
import type { ComponentProps } from 'react'

export interface StatusDotProps extends ComponentProps<'span'> {
  pulse?: boolean
}

export function StatusDot({
  pulse = false,
  className,
  ...props
}: StatusDotProps) {
  return (
    <span
      {...props}
      data-slot="status-dot"
      data-pulse={pulse ? 'true' : undefined}
      className={cn(
        'status-dot inline-block size-2.5 shrink-0 rounded-full',
        className
      )}
      aria-hidden="true"
    />
  )
}
