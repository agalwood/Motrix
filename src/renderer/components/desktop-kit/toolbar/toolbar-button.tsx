import { Toolbar as ToolbarPrimitive } from '@base-ui/react/toolbar'
import { buttonVariants } from '@renderer/components/ui/button'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@renderer/components/ui/tooltip'
import { cn } from '@renderer/lib/utils'
import type { ComponentProps, ReactElement } from 'react'

const controlClassName = cn(
  buttonVariants({ variant: 'ghost', size: 'icon' }),
  'app-no-drag toolbar-button relative size-[30px] compact-header:size-6 rounded-full text-foreground bg-transparent transition-colors duration-150 active:duration-0 motion-reduce:transition-none hover:bg-accent active:bg-accent [&>svg]:size-[18px] compact-header:[&>svg]:size-4 [&>svg]:opacity-90 focus-visible:ring-1 focus-visible:ring-[#7388a3] dark:focus-visible:ring-[#97aac4] aria-pressed:bg-accent data-popup-open:bg-accent'
)

function withTooltip(control: ReactElement, label?: string) {
  return label ? (
    <Tooltip>
      <TooltipTrigger delay={400} render={control} />
      <TooltipContent side="bottom" sideOffset={8}>
        {label}
      </TooltipContent>
    </Tooltip>
  ) : (
    control
  )
}

/** `label` supplies the accessible name and tooltip; render composes menu triggers. */
export function ToolbarButton({
  label,
  className,
  ...props
}: Omit<ComponentProps<typeof ToolbarPrimitive.Button>, 'className'> & {
  label?: string
  className?: string
}) {
  return withTooltip(
    <ToolbarPrimitive.Button
      data-slot="toolbar-button"
      focusableWhenDisabled={false}
      aria-label={label}
      {...props}
      className={cn(controlClassName, className)}
    />,
    label
  )
}

/** Real link semantics, with the same visuals and toolbar keyboard navigation. */
export function ToolbarLink({
  label,
  className,
  ...props
}: Omit<ComponentProps<typeof ToolbarPrimitive.Link>, 'className'> & {
  label: string
  className?: string
}) {
  return withTooltip(
    <ToolbarPrimitive.Link
      data-slot="toolbar-button"
      aria-label={label}
      {...props}
      className={cn(controlClassName, className)}
    />,
    label
  )
}
