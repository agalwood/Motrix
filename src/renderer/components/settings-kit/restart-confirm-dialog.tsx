import { Button } from '@renderer/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@renderer/components/ui/dialog'
import { useTranslation } from 'react-i18next'

export interface RestartConfirmDialogProps {
  open: boolean
  onResolve: (confirmed: boolean) => void
}

export function RestartConfirmDialog({
  open,
  onResolve,
}: RestartConfirmDialogProps) {
  const { t } = useTranslation()
  return (
    <Dialog open={open} onOpenChange={(v) => !v && onResolve(false)}>
      <DialogContent className="sm:max-w-[420px]">
        <DialogHeader>
          <DialogTitle>{t('settings.common.restartConfirm.title')}</DialogTitle>
          <DialogDescription>
            {t('settings.common.restartConfirm.body')}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => onResolve(false)}
          >
            {t('common.cancel')}
          </Button>
          <Button type="button" size="sm" onClick={() => onResolve(true)}>
            {t('settings.common.restartConfirm.confirm')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
