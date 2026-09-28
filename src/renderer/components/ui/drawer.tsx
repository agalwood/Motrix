import { Drawer as DrawerPrimitive } from '@base-ui/react/drawer'
import { cn } from '@renderer/lib/utils'
import type * as React from 'react'

export function Drawer(
  props: React.ComponentProps<typeof DrawerPrimitive.Root>
) {
  return <DrawerPrimitive.Root {...props} />
}
export function DrawerTrigger(
  props: React.ComponentProps<typeof DrawerPrimitive.Trigger>
) {
  return <DrawerPrimitive.Trigger data-slot="drawer-trigger" {...props} />
}
export function DrawerPortal(
  props: React.ComponentProps<typeof DrawerPrimitive.Portal>
) {
  return <DrawerPrimitive.Portal data-slot="drawer-portal" {...props} />
}
export function DrawerClose(
  props: React.ComponentProps<typeof DrawerPrimitive.Close>
) {
  return <DrawerPrimitive.Close data-slot="drawer-close" {...props} />
}
export function DrawerOverlay({
  className,
  ...props
}: React.ComponentProps<typeof DrawerPrimitive.Backdrop>) {
  return (
    <DrawerPrimitive.Backdrop
      data-slot="drawer-overlay"
      className={cn('fixed inset-0 z-50 bg-black/50', className)}
      {...props}
    />
  )
}
export function DrawerViewport(
  props: React.ComponentProps<typeof DrawerPrimitive.Viewport>
) {
  return <DrawerPrimitive.Viewport data-slot="drawer-viewport" {...props} />
}
export function DrawerPopup({
  className,
  ...props
}: React.ComponentProps<typeof DrawerPrimitive.Popup>) {
  return (
    <DrawerPrimitive.Popup
      data-slot="drawer-content"
      className={cn(
        'flex flex-col border-t bg-background outline-none',
        className
      )}
      {...props}
    />
  )
}
export function DrawerContent({
  className,
  children,
  ...props
}: React.ComponentProps<typeof DrawerPrimitive.Popup>) {
  return (
    <DrawerPortal>
      <DrawerOverlay />
      <DrawerViewport className="fixed inset-0 z-50 flex items-end">
        <DrawerPopup
          className={cn(
            'max-h-[calc(100dvh-6rem)] w-full rounded-t-lg',
            className
          )}
          {...props}
        >
          {children}
        </DrawerPopup>
      </DrawerViewport>
    </DrawerPortal>
  )
}
export function DrawerBody(
  props: React.ComponentProps<typeof DrawerPrimitive.Content>
) {
  return <DrawerPrimitive.Content {...props} />
}
export function DrawerHeader({
  className,
  ...props
}: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot="drawer-header"
      className={cn('flex flex-col gap-1 p-4', className)}
      {...props}
    />
  )
}
export function DrawerFooter({
  className,
  ...props
}: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot="drawer-footer"
      className={cn('mt-auto flex flex-col gap-2 p-4', className)}
      {...props}
    />
  )
}
export function DrawerTitle({
  className,
  ...props
}: React.ComponentProps<typeof DrawerPrimitive.Title>) {
  return (
    <DrawerPrimitive.Title
      data-slot="drawer-title"
      className={cn('font-semibold', className)}
      {...props}
    />
  )
}
export function DrawerDescription({
  className,
  ...props
}: React.ComponentProps<typeof DrawerPrimitive.Description>) {
  return (
    <DrawerPrimitive.Description
      data-slot="drawer-description"
      className={cn('text-sm text-muted-foreground', className)}
      {...props}
    />
  )
}
