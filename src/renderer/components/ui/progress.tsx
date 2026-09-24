import { Progress as ProgressPrimitive } from '@base-ui/react/progress'
import { cn } from '@renderer/lib/utils'

export interface ProgressProps
  extends Omit<ProgressPrimitive.Root.Props, 'value'> {
  value?: number
  indicatorClassName?: string
}

export function Progress({
  className,
  value,
  indicatorClassName,
  ...props
}: ProgressProps) {
  return (
    <ProgressPrimitive.Root
      data-slot="progress"
      className={cn(
        'relative h-2 w-full overflow-hidden rounded-full bg-muted',
        className
      )}
      value={value ?? null}
      {...props}
    >
      <ProgressPrimitive.Track className="size-full">
        <ProgressPrimitive.Indicator
          className={cn(
            'h-full bg-primary transition-all motion-reduce:transition-none',
            value == null && 'w-1/3 animate-pulse motion-reduce:animate-none',
            indicatorClassName
          )}
        />
      </ProgressPrimitive.Track>
    </ProgressPrimitive.Root>
  )
}
