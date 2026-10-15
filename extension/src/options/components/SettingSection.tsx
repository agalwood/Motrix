import type * as React from 'react'

export function SettingSection({
  title,
  description,
  action,
  children,
}: {
  title?: React.ReactNode
  description?: React.ReactNode
  action?: React.ReactNode
  children: React.ReactNode
}): React.ReactElement {
  return (
    <section className="flex flex-col gap-3">
      {(title != null || action != null) && (
        <div className="flex items-start justify-between gap-3">
          <div className="flex flex-col gap-1">
            {title != null && (
              <h2 className="text-sm font-semibold tracking-tight text-foreground">
                {title}
              </h2>
            )}
            {description != null && (
              <p className="text-xs text-muted-foreground">{description}</p>
            )}
          </div>
          {action != null && <div className="shrink-0">{action}</div>}
        </div>
      )}
      {children}
    </section>
  )
}
