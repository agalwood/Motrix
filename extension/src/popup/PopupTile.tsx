import { type ComponentProps, type ReactNode, useId } from 'react'

import {
  Card,
  CardAction,
  CardContent,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import { cn } from '@/lib/utils'

export interface PopupTileProps
  extends Omit<ComponentProps<typeof Card>, 'children'> {
  label: string
  action?: ReactNode
  headerClassName?: string
  contentClassName?: string
  children: ReactNode
}

// Adapted from Motrix's MIT-licensed dashboard tile visual layer.
export function PopupTile({
  label,
  action,
  headerClassName,
  contentClassName,
  children,
  className,
  role,
  size = 'sm',
  ...props
}: PopupTileProps): React.ReactElement {
  const titleId = useId()

  return (
    <Card
      {...props}
      role={role ?? 'group'}
      aria-labelledby={props['aria-labelledby'] ?? titleId}
      size={size}
      className={cn(
        'min-h-0 gap-0 rounded-[18px] py-0 shadow-card ring-0',
        className
      )}
    >
      <CardHeader
        className={cn(
          'mx-4 mt-3 grid min-h-6 min-w-0 shrink-0 auto-rows-auto grid-cols-[minmax(0,1fr)_auto] items-center gap-2 px-0',
          headerClassName
        )}
      >
        <CardTitle
          id={titleId}
          className="min-w-0 truncate font-sans text-[10px] leading-4 font-medium tracking-[0.04em] text-muted-foreground uppercase group-data-[size=sm]/card:text-[10px]"
        >
          {label}
        </CardTitle>
        {action !== undefined && action !== null ? (
          <CardAction className="-me-1 row-span-1 row-start-1 flex shrink-0 items-center self-center">
            {action}
          </CardAction>
        ) : null}
      </CardHeader>
      <CardContent
        className={cn(
          'flex min-h-0 min-w-0 flex-1 flex-col px-4 pb-4',
          contentClassName
        )}
      >
        {children}
      </CardContent>
    </Card>
  )
}
