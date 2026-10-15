import { useTranslation } from 'react-i18next'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'

export function TakeoverConsentDialog({
  open,
  saving = false,
  onConfirm,
  onCancel,
}: {
  open: boolean
  saving?: boolean
  onConfirm: () => void
  onCancel: () => void
}): React.ReactElement {
  const { t } = useTranslation()

  return (
    <AlertDialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) onCancel()
      }}
    >
      <AlertDialogContent size="sm" className="max-w-[360px]">
        <AlertDialogHeader>
          <AlertDialogTitle>
            {t('options.takeover.consentDialogLabel')}
          </AlertDialogTitle>
          <AlertDialogDescription>
            {t('options.takeover.consentBody')}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel
            type="button"
            className="min-w-0"
            disabled={saving}
          >
            {t('options.takeover.consentCancel')}
          </AlertDialogCancel>
          <AlertDialogAction
            type="button"
            className="min-w-0"
            disabled={saving}
            onClick={onConfirm}
          >
            {t('options.takeover.consentConfirm')}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
