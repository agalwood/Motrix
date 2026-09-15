import { Button } from '@renderer/components/ui/button'
import { cn } from '@renderer/lib/utils'
import type { ComponentProps } from 'react'

/** Both densities reserve 2px padding and a border around each target. */
export function DownloadsToolbarButton({
  className,
  ...props
}: ComponentProps<typeof Button>) {
  return (
    <Button
      size="icon"
      variant="ghost"
      {...props}
      className={cn(
        'app-no-drag relative size-[30px] compact-header:size-6 rounded-full text-foreground bg-transparent transition-colors hover:bg-accent active:bg-accent [&>svg]:size-[18px] compact-header:[&>svg]:size-4 [&>svg]:opacity-65 hover:[&>svg]:opacity-90 focus-visible:[&>svg]:opacity-90 focus-visible:ring-1 focus-visible:ring-[#7388a3] dark:focus-visible:ring-[#97aac4] aria-pressed:bg-accent data-popup-open:bg-accent',
        className
      )}
    />
  )
}
