import { Toolbar as ToolbarPrimitive } from '@base-ui/react/toolbar'
import { TooltipProvider } from '@renderer/components/ui/tooltip'
import { useLiquidGlass } from '@renderer/hooks/use-liquid-glass'
import { cn } from '@renderer/lib/utils'
import { type ComponentProps, createContext, useContext } from 'react'
import { useCompactHeader } from '../hooks/use-compact-header'

const ToolbarContext = createContext({ glassEnabled: false })

export const useToolbarMaterial = () => useContext(ToolbarContext)

/** Owns material, density and arrow-key navigation; pages own their actions. */
export function Toolbar({
  label,
  glassEnabled,
  className,
  children,
  ...props
}: Omit<ComponentProps<typeof ToolbarPrimitive.Root>, 'className'> & {
  label: string
  glassEnabled?: boolean
  className?: string
}) {
  const savedGlassEnabled = useLiquidGlass()
  const compact = useCompactHeader()
  return (
    <ToolbarContext.Provider
      value={{ glassEnabled: glassEnabled ?? savedGlassEnabled }}
    >
      <TooltipProvider>
        <ToolbarPrimitive.Root
          data-slot="toolbar"
          data-density={compact ? 'compact' : 'standard'}
          aria-label={label}
          className={cn(
            'flex min-w-0 flex-1 items-center justify-end gap-2',
            className
          )}
          {...props}
        >
          {children}
        </ToolbarPrimitive.Root>
      </TooltipProvider>
    </ToolbarContext.Provider>
  )
}

/** Optional boundary between related controls within one capsule. */
export function ToolbarSeparator() {
  return (
    <ToolbarPrimitive.Separator className="mx-1 h-4 w-px shrink-0 bg-foreground/15" />
  )
}
