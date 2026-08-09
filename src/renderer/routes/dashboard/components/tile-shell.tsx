// src/renderer/routes/dashboard/components/tile-shell.tsx
import { Card, CardContent } from '@renderer/components/ui/card'
import { cn } from '@renderer/lib/utils'
import type React from 'react'

export interface TileShellProps {
  label: string
  action?: React.ReactNode
  className?: string
  bodyClassName?: string
  children: React.ReactNode
}

export function TileShell({
  label,
  action,
  className,
  bodyClassName,
  children,
}: TileShellProps) {
  return (
    <Card
      className={cn(
        'dashboard-tile flex min-h-0 flex-col overflow-hidden shadow-md/5 border-none',
        'gap-0',
        'p-4',
        className
      )}
    >
      <header
        data-slot="tile-header"
        className="-mt-1 grid min-h-6 min-w-0 shrink-0 grid-cols-[minmax(0,1fr)_auto] items-center gap-2"
      >
        <span
          data-slot="tile-label"
          className={cn(
            'min-w-0 truncate select-none font-medium text-[10px] text-muted-foreground uppercase leading-4 tracking-[0.04em]'
          )}
        >
          {label}
        </span>
        {action ? (
          <div
            data-slot="tile-action"
            className="-me-1 flex shrink-0 items-center"
          >
            {action}
          </div>
        ) : null}
      </header>
      <CardContent
        data-tile-content
        className={cn(
          'flex min-h-0 min-w-0 flex-1 flex-col p-0',
          bodyClassName
        )}
      >
        {children}
      </CardContent>
    </Card>
  )
}
