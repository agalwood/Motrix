import { WarningIcon } from '@renderer/components/icons'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@renderer/components/ui/alert-dialog'
import type { DownloadTask } from '@shared/types/task'
import { useTranslation } from 'react-i18next'

export interface RedownloadOverwriteDialogProps {
  open: boolean
  busy?: boolean
  target: DownloadTask | null
  onOpenChange: (open: boolean) => void
  onConfirm: () => void
}

/**
 * Confirm re-downloading when the destination file already exists.
 */
export function RedownloadOverwriteDialog({
  open,
  busy,
  target,
  onOpenChange,
  onConfirm,
}: RedownloadOverwriteDialogProps) {
  const { t } = useTranslation()

  if (!target) return null

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <div className="flex items-center gap-2">
            <WarningIcon className="size-5 shrink-0 text-amber-500" />
            <AlertDialogTitle>
              {t('panel.downloads.action.redownloadOverwriteTitle')}
            </AlertDialogTitle>
          </div>
          <AlertDialogDescription>
            {t('panel.downloads.action.redownloadOverwriteDescription', {
              name: target.name,
            })}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={busy}>
            {t('common.cancel')}
          </AlertDialogCancel>
          <AlertDialogAction
            disabled={busy}
            onClick={(event) => {
              event.preventDefault()
              onConfirm()
            }}
          >
            {t('panel.downloads.action.redownload')}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
