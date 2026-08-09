import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@renderer/components/ui/alert-dialog'
import { Button, buttonVariants } from '@renderer/components/ui/button'
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@renderer/components/ui/tooltip'
import { transport } from '@renderer/lib/transport'
import { cn } from '@renderer/lib/utils'
import { Commands } from '@shared/protocol/commands'
import { Trash2 } from 'lucide-react'
import { useTranslation } from 'react-i18next'

interface Props {
  pluginId: string
  pluginName: string
  hidden: boolean
}

export function UninstallSection({ pluginId, pluginName, hidden }: Props) {
  const { t } = useTranslation()
  if (hidden) return null
  return (
    <AlertDialog>
      <TooltipProvider>
        <Tooltip>
          <TooltipTrigger
            render={
              <AlertDialogTrigger
                render={
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label={t('plugins.detail.uninstall')}
                    className="text-destructive hover:bg-destructive/10 hover:text-destructive"
                  />
                }
              >
                <Trash2 className="size-4" />
              </AlertDialogTrigger>
            }
          />
          <TooltipContent>{t('plugins.detail.uninstall')}</TooltipContent>
        </Tooltip>
      </TooltipProvider>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>
            {t('plugins.detail.uninstallConfirmTitle', {
              name: pluginName,
            })}
          </AlertDialogTitle>
          <AlertDialogDescription>
            {t('plugins.detail.uninstallConfirmDesc')}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>{t('common.cancel')}</AlertDialogCancel>
          <AlertDialogAction
            className={cn(buttonVariants({ variant: 'destructive' }))}
            onClick={() =>
              transport.invoke(Commands.UninstallPlugin, { pluginId })
            }
          >
            {t('plugins.detail.uninstall')}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
