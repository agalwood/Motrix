import { Progress as ProgressPrimitive } from '@base-ui/react/progress'
import { cn } from '@renderer/lib/utils'

export interface ProgressProps
  extends Omit<ProgressPrimitive.Root.Props, 'value'> {
  value?: number
}

export function Progress({ className, value, ...props }: ProgressProps) {
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
        <ProgressPrimitive.Indicator className="h-full bg-primary transition-all" />
      </ProgressPrimitive.Track>
    </ProgressPrimitive.Root>
  )
}
