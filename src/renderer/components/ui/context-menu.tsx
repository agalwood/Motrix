import { ContextMenu as ContextMenuPrimitive } from '@base-ui/react/context-menu'
import { cn } from '@renderer/lib/utils'
import type * as React from 'react'

// Base UI context menus share the Menu item primitives. Keep the same shadcn
// styling and keyboard behavior as the application's dropdown menus.
export {
  DropdownMenuCheckboxItem as ContextMenuCheckboxItem,
  DropdownMenuGroup as ContextMenuGroup,
  DropdownMenuItem as ContextMenuItem,
  DropdownMenuLabel as ContextMenuLabel,
  DropdownMenuRadioGroup as ContextMenuRadioGroup,
  DropdownMenuRadioItem as ContextMenuRadioItem,
  DropdownMenuSeparator as ContextMenuSeparator,
  DropdownMenuShortcut as ContextMenuShortcut,
  DropdownMenuSub as ContextMenuSub,
  DropdownMenuSubContent as ContextMenuSubContent,
  DropdownMenuSubTrigger as ContextMenuSubTrigger,
} from './dropdown-menu'

export function ContextMenu(
  props: React.ComponentProps<typeof ContextMenuPrimitive.Root>
) {
  return <ContextMenuPrimitive.Root {...props} />
}

export function ContextMenuTrigger(
  props: React.ComponentProps<typeof ContextMenuPrimitive.Trigger>
) {
  return (
    <ContextMenuPrimitive.Trigger data-slot="context-menu-trigger" {...props} />
  )
}

export function ContextMenuContent({
  className,
  ...props
}: React.ComponentProps<typeof ContextMenuPrimitive.Popup>) {
  return (
    <ContextMenuPrimitive.Portal>
      <ContextMenuPrimitive.Positioner
        className="isolate z-50 outline-none"
        sideOffset={2}
      >
        <ContextMenuPrimitive.Popup
          data-slot="context-menu-content"
          data-menu-density="compact"
          className={cn(
            'z-50 max-h-(--available-height) min-w-48 overflow-x-hidden overflow-y-auto rounded-md border bg-popover p-1 text-popover-foreground shadow-md outline-none',
            className
          )}
          {...props}
        />
      </ContextMenuPrimitive.Positioner>
    </ContextMenuPrimitive.Portal>
  )
}
