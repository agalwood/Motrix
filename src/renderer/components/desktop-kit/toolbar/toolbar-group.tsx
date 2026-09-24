import { cn } from '@renderer/lib/utils'
import type { ComponentProps } from 'react'
import { ToolbarGlass } from '../toolbar-glass/toolbar-glass'
import { useToolbarMaterial } from './toolbar'

/** Shared capsule geometry for panel actions in both header densities. */
export function ToolbarGroup({
  children,
  className,
  ...props
}: ComponentProps<'div'>) {
  const { glassEnabled } = useToolbarMaterial()
  return (
    <div
      {...props}
      className={cn(
        'app-no-drag toolbar-glass-surface flex h-9 shrink-0 items-center gap-1 rounded-full border border-border/70 bg-background/70 p-0.5 compact-header:h-[30px]',
        className
      )}
    >
      <ToolbarGlass enabled={glassEnabled} />
      {children}
    </div>
  )
}
