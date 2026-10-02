import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@renderer/components/ui/dialog'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { MediaMergeForm } from './media-merge-form'
import { useMediaMergeDialog } from './media-merge-store'

export function MediaMergeDialogHost() {
  const { open, request, close } = useMediaMergeDialog()
  const { t } = useTranslation()
  const [busy, setBusy] = useState(false)
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next && !busy) close()
      }}
    >
      <DialogContent
        className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-xl"
        showCloseButton={!busy}
      >
        <DialogHeader>
          <DialogTitle>{t('mediaMerge.title')}</DialogTitle>
          <DialogDescription>{t('mediaMerge.description')}</DialogDescription>
        </DialogHeader>
        {open && (
          <MediaMergeForm {...request} onClose={close} onBusyChange={setBusy} />
        )}
      </DialogContent>
    </Dialog>
  )
}
