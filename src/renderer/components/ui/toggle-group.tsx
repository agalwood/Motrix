import { ToggleGroup as ToggleGroupPrimitive } from '@base-ui/react/toggle-group'
import { cn } from '@renderer/lib/utils'
import type { ComponentProps } from 'react'
import { Toggle } from './toggle'

function ToggleGroup<Value extends string>({
  className,
  ...props
}: ToggleGroupPrimitive.Props<Value>) {
  return (
    <ToggleGroupPrimitive
      data-slot="toggle-group"
      className={cn(
        'flex w-fit items-center gap-0 rounded-lg bg-tab-background p-[3px] text-muted-foreground',
        className
      )}
      {...props}
    />
  )
}

function ToggleGroupItem({
  className,
  ...props
}: ComponentProps<typeof Toggle>) {
  return (
    <Toggle
      data-slot="toggle-group-item"
      size="sm"
      className={cn(
        'h-7 min-w-0 shrink-0 rounded-md border-0 bg-transparent px-2.5 text-xs shadow-none',
        'data-pressed:bg-background! data-pressed:text-foreground! data-pressed:shadow-sm',
        'hover:bg-background/60 hover:text-foreground',
        className
      )}
      {...props}
    />
  )
}

export { ToggleGroup, ToggleGroupItem }
