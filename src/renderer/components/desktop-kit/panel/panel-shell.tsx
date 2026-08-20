import { Input } from '@renderer/components/ui/input'
import { cn } from '@renderer/lib/utils'
import type React from 'react'

export const PANEL_TITLE_CLASS =
  'select-none text-2xl font-semibold tracking-tight compact-header:text-sm compact-header:leading-[28px] transition-text duration-200 linear'

export interface PanelShellSearch {
  value: string
  onChange: (value: string) => void
  placeholder?: string
}

export interface PanelShellProps {
  title: string | React.ReactNode
  search?: PanelShellSearch
  actions?: React.ReactNode
  actionsPosition?: 'start' | 'end'
  footer?: React.ReactNode
  children: React.ReactNode
  headerClassName?: string
  contentClassName?: string
}

export function PanelShell({
  title,
  search,
  actions,
  actionsPosition = 'end',
  footer,
  children,
  headerClassName,
  contentClassName,
}: PanelShellProps) {
  return (
    <div className="relative flex h-full flex-col">
      {/* PanelShell header */}
      <header
        className={cn(
          'flex shrink-0 items-start justify-between gap-4 px-6 pt-9 pb-4 transition-[padding] duration-200',
          // Compact rows center on the window-chrome icon line: the overlay
          // strip renders its 28px buttons at window y 13..41 (pt-[14px]
          // wrapper in AppLayout), i.e. centerline y=27. The inset sits 8px
          // down (m-2), so 5px top padding centers a 28px row at
          // 8 + 5 + 14 = 27 — same line as the traffic lights ({x:20,y:20}).
          'compact-header:py-[5px]',
          'compact-header:ps-[var(--window-chrome-safe-area-leading)] compact-header:pe-[var(--window-chrome-safe-area-trailing)]',
          headerClassName
        )}
      >
        {typeof title === 'string' ? (
          <div className="min-w-0">
            <h1 className={PANEL_TITLE_CLASS}>{title}</h1>
          </div>
        ) : (
          title
        )}
        <div
          data-slot="panel-shell-actions"
          // Keep actions above the z-30 WindowChrome drag strip but below the
          // z-50 modal layer so dialogs always cover background controls.
          className="app-no-drag relative z-40 flex shrink-0 items-center gap-2"
        >
          {actionsPosition === 'start' && actions}
          {search && (
            <Input
              value={search.value}
              onChange={(e) => search.onChange(e.target.value)}
              placeholder={search.placeholder}
              className="h-8 w-56 text-sm placeholder:text-xs compact-header:h-7 compact-header:w-40"
            />
          )}
          {actionsPosition === 'end' && actions}
        </div>
      </header>

      {/* PanelShell content */}
      <div
        className={cn('flex min-h-0 flex-1 flex-col px-0', contentClassName)}
      >
        {children}
      </div>

      {/* PanelShell footer */}
      {footer && (
        <footer className="flex shrink-0 items-center justify-between gap-2 px-6 py-3">
          {footer}
        </footer>
      )}
    </div>
  )
}
