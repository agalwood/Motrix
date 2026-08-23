import { Button } from '@renderer/components/ui/button'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@renderer/components/ui/tooltip'
import { openAddTaskDialog } from '@renderer/lib/open-add-task-dialog'
import { cn } from '@renderer/lib/utils'
import { Plus } from 'lucide-react'
import type React from 'react'
import { useTranslation } from 'react-i18next'

export function AddTaskTriggerButton({
  className,
}: React.ComponentProps<'button'>) {
  const { t } = useTranslation()
  const onClick = () => {
    void openAddTaskDialog()
  }
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            variant="ghost"
            size="icon"
            aria-label={t('chrome.newTask')}
            className={cn(
              'app-no-drag size-7 bg-transparent [&>svg]:opacity-65 hover:bg-accent hover:[&>svg]:opacity-90 focus-visible:[&>svg]:opacity-90',
              className
            )}
            onClick={onClick}
          />
        }
      >
        <Plus className="size-4" />
      </TooltipTrigger>
      <TooltipContent>{t('chrome.newTask')}</TooltipContent>
    </Tooltip>
  )
}
