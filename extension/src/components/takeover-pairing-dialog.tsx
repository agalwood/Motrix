import { useEffect, useState } from 'react'
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
import {
  openBackendPairing,
  type PairingAction,
} from '@/shared/pairingNavigation'
import { hasNativeMessagingSupport } from '@/shared/platformCapabilities'

export function TakeoverPairingDialog({
  open,
  onCancel,
}: {
  open: boolean
  onCancel: () => void
}): React.ReactElement {
  const { t } = useTranslation()
  const [error, setError] = useState(false)
  useEffect(() => {
    if (open) setError(false)
  }, [open])
  const navigate = async (action: PairingAction): Promise<void> => {
    setError(false)
    try {
      await openBackendPairing(action)
      onCancel()
    } catch {
      setError(true)
    }
  }
  return (
    <AlertDialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onCancel()
      }}
    >
      <AlertDialogContent className="max-h-[calc(100dvh-2rem)] w-[min(360px,calc(100dvw-2rem))] overflow-y-auto">
        <AlertDialogHeader>
          <AlertDialogTitle>
            {t('options.takeover.pairingRequiredTitle')}
          </AlertDialogTitle>
          <AlertDialogDescription>
            {t('options.takeover.pairingRequiredBody')}
          </AlertDialogDescription>
        </AlertDialogHeader>
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {t('options.common.loadError')}
          </p>
        )}
        <AlertDialogFooter className="flex-col sm:flex-col">
          <AlertDialogAction
            className="h-auto min-h-9 whitespace-normal"
            disabled={!hasNativeMessagingSupport()}
            title={
              hasNativeMessagingSupport()
                ? undefined
                : t('options.pairing.serverRequiredHelp')
            }
            onClick={() => void navigate('pair-app')}
          >
            {t('options.takeover.pairApp')}
          </AlertDialogAction>
          <AlertDialogAction
            variant="outline"
            className="h-auto min-h-9 whitespace-normal"
            onClick={() => void navigate('add-server')}
          >
            {t('options.takeover.addServerPair')}
          </AlertDialogAction>
          <AlertDialogCancel>{t('options.common.cancel')}</AlertDialogCancel>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
