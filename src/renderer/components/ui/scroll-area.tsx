import { ScrollArea as ScrollAreaPrimitive } from '@base-ui/react/scroll-area'
import { cn } from '@renderer/lib/utils'
import type { ComponentProps } from 'react'

export function ScrollArea({
  className,
  ...props
}: ComponentProps<typeof ScrollAreaPrimitive.Root>) {
  return (
    <ScrollAreaPrimitive.Root
      data-slot="scroll-area"
      className={cn('relative min-h-0 overflow-hidden', className)}
      {...props}
    />
  )
}

export function ScrollAreaViewport({
  className,
  ...props
}: ComponentProps<typeof ScrollAreaPrimitive.Viewport>) {
  return (
    <ScrollAreaPrimitive.Viewport
      data-slot="scroll-area-viewport"
      className={cn(
        'size-full rounded-[inherit] outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring',
        className
      )}
      style={{ overflow: 'auto' }}
      {...props}
    />
  )
}

export function ScrollAreaContent(
  props: ComponentProps<typeof ScrollAreaPrimitive.Content>
) {
  return (
    <ScrollAreaPrimitive.Content data-slot="scroll-area-content" {...props} />
  )
}

export function ScrollBar({
  className,
  orientation = 'vertical',
  ...props
}: ComponentProps<typeof ScrollAreaPrimitive.Scrollbar>) {
  return (
    <ScrollAreaPrimitive.Scrollbar
      data-slot="scroll-area-scrollbar"
      orientation={orientation}
      className={cn(
        'absolute z-20 flex touch-none select-none p-0.5 opacity-0 transition-opacity duration-150 data-hovering:opacity-100 data-scrolling:opacity-100 focus-within:opacity-100 motion-reduce:transition-none',
        orientation === 'vertical'
          ? 'inset-y-0 end-0 w-2.5 data-has-overflow-x:bottom-2.5'
          : 'inset-x-0 bottom-0 h-2.5 flex-col data-has-overflow-y:end-2.5',
        className
      )}
      {...props}
    >
      <ScrollAreaPrimitive.Thumb
        data-slot="scroll-area-thumb"
        className="relative flex-1 rounded-full bg-foreground/70 hover:bg-foreground/85"
      />
    </ScrollAreaPrimitive.Scrollbar>
  )
}
