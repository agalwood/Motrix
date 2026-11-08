import { ChevronRightIcon } from '@renderer/components/icons'
import { Button } from '@renderer/components/ui/button'
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@renderer/components/ui/collapsible'
import { cn } from '@renderer/lib/utils'
import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'

export const taskFormFooter =
  'w-full shrink-0 border-t-[0.5px] border-border bg-background px-4 py-3'
export const taskFormActions = 'flex shrink-0 items-center gap-2'
export function TaskFormAdvanced({
  open,
  onOpenChange,
  disabled,
  children,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  disabled?: boolean
  children: ReactNode
}) {
  const { t } = useTranslation()
  return (
    <Collapsible open={open} onOpenChange={onOpenChange}>
      <CollapsibleTrigger
        disabled={disabled}
        render={
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="-ms-2 h-7 gap-1.5 px-2 text-xs text-muted-foreground hover:text-foreground hover:bg-transparent dark:hover:bg-transparent"
          />
        }
      >
        <ChevronRightIcon
          className={cn(
            'size-3.5 motion-safe:transition-transform motion-safe:duration-150',
            open ? 'rotate-90' : 'rtl:rotate-180'
          )}
          aria-hidden="true"
        />
        {t('task.add.advanced')}
      </CollapsibleTrigger>
      <CollapsibleContent className="mt-2 ms-1.5 space-y-2 border-s-2 border-border ps-3">
        {children}
      </CollapsibleContent>
    </Collapsible>
  )
}
