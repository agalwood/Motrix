import type * as React from 'react'
import { Label } from '@/components/ui/label'

export function SettingRow({
  label,
  htmlFor,
  description,
  children,
  stack = false,
}: {
  label: React.ReactNode
  htmlFor?: string
  description?: React.ReactNode
  children: React.ReactNode
  stack?: boolean
}): React.ReactElement {
  if (stack) {
    return (
      <div className="space-y-1.5">
        <Label htmlFor={htmlFor} className="text-muted-foreground">
          {label}
        </Label>
        {description != null && (
          <p className="text-xs text-muted-foreground">{description}</p>
        )}
        {children}
      </div>
    )
  }
  return (
    <div className="flex items-start justify-between gap-4">
      <div className="space-y-1">
        <Label htmlFor={htmlFor}>{label}</Label>
        {description != null && (
          <p className="text-xs leading-relaxed text-muted-foreground">
            {description}
          </p>
        )}
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  )
}
