import type * as React from 'react'

/** Shared surface for tab content; headings belong to its setting groups. */
export function SettingPanel({
  children,
}: {
  children: React.ReactNode
}): React.ReactElement {
  return (
    <div className="rounded-2xl border border-border/60 bg-card px-5 py-4 shadow-inset-panel">
      <div className="space-y-3">{children}</div>
    </div>
  )
}

/**
 * Matches the look of the shadcn <Input> for native <select>/<textarea>
 * controls that don't have a dedicated component, so fields stay consistent.
 */
export const fieldClass =
  'h-9 rounded-md border border-input bg-background px-3 text-sm shadow-xs outline-none transition-[color,box-shadow] focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50'

/**
 * Shared label-column width so every panel's controls line up on the same
 * x-offset. w-36 fits the longest label ("Minimum size (MB)") on one line.
 */
export const labelColClass = 'w-36 shrink-0 text-muted-foreground'
