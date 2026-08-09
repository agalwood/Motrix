import { SidebarTrigger } from '@renderer/components/ui/sidebar'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@renderer/components/ui/tooltip'
import { cn } from '@renderer/lib/utils'
import type React from 'react'
import { useTranslation } from 'react-i18next'

export function SidebarTriggerButton({
  className,
}: React.ComponentProps<'button'>) {
  const { t } = useTranslation()

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <SidebarTrigger
            aria-label={t('chrome.toggleSidebar')}
            className={cn(
              'app-no-drag size-7 bg-transparent hover:bg-accent',
              className
            )}
          />
        }
      />
      <TooltipContent>{t('chrome.toggleSidebar')}</TooltipContent>
    </Tooltip>
  )
}
