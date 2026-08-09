import { Button } from '@renderer/components/ui/button'
import { Checkbox } from '@renderer/components/ui/checkbox'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@renderer/components/ui/dialog'
import { useEffect, useId, useState } from 'react'
import { useTranslation } from 'react-i18next'

export interface RemoveTaskDialogProps {
  open: boolean
  taskName: string
  onClose: () => void
  onConfirm: (deleteWithFiles: boolean) => void
}

export function RemoveTaskDialog({
  open,
  taskName,
  onClose,
  onConfirm,
}: RemoveTaskDialogProps) {
  const { t } = useTranslation()
  const checkboxId = useId()
  const [deleteFiles, setDeleteFiles] = useState(false)

  // Reset the checkbox whenever the dialog is re-opened so it never leaks
  // a stale checked state from a previous removal.
  useEffect(() => {
    if (open) {
      setDeleteFiles(false)
    }
  }, [open])

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('task.remove.title')}</DialogTitle>
          <DialogDescription>
            {t('task.remove.description', { name: taskName })}
          </DialogDescription>
        </DialogHeader>
        <div className="flex items-center gap-2 py-2">
          <Checkbox
            id={checkboxId}
            checked={deleteFiles}
            onCheckedChange={(v) => setDeleteFiles(Boolean(v))}
          />
          <label htmlFor={checkboxId} className="cursor-pointer text-sm">
            {t('task.remove.deleteFilesLabel')}
          </label>
        </div>
        <DialogFooter>
          <Button size="sm" variant="outline" onClick={onClose}>
            {t('task.remove.cancel')}
          </Button>
          <Button
            size="sm"
            variant="destructive"
            onClick={() => {
              onConfirm(deleteFiles)
              onClose()
            }}
          >
            {t('task.remove.confirm')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
