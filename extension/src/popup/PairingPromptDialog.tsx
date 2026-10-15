import { useTranslation } from 'react-i18next'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { PairingCodePanel } from '@/popup/PairingCodePanel'
import type { PopupState } from '@/popup/usePopupState'

export function PairingPromptDialog({
  prompt,
  error,
  submitting,
  onSubmit,
  onDismiss,
}: {
  prompt: NonNullable<PopupState['pairingCode']>
  error: string | null
  submitting: boolean
  onSubmit: (code: string) => void
  onDismiss: () => void
}): React.ReactElement {
  const { t } = useTranslation()

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onDismiss()
      }}
    >
      <DialogContent
        className="max-h-[520px] max-w-[360px] gap-4 overflow-y-auto p-5 sm:max-w-[360px]"
        showCloseButton={false}
      >
        <DialogHeader className="gap-1.5">
          <DialogTitle>{t('popup.pairing.dialogTitle')}</DialogTitle>
          <DialogDescription className="text-xs/5">
            {t('popup.pairing.codeDescription')}
          </DialogDescription>
        </DialogHeader>
        <PairingCodePanel
          onSubmit={onSubmit}
          run={prompt.run}
          maxRuns={prompt.maxRuns}
          attemptsRemaining={prompt.attemptsRemaining}
          deadlineMs={prompt.deadlineMs}
          disabled={submitting}
        />
        {error && (
          <Alert variant="destructive" className="py-2">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="mx-auto -mb-1"
          onClick={onDismiss}
        >
          {t('popup.pairing.dismissPrompt')}
        </Button>
      </DialogContent>
    </Dialog>
  )
}
