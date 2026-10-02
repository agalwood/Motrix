import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@renderer/components/ui/alert-dialog'
import { Button } from '@renderer/components/ui/button'
import { toast } from '@renderer/components/ui/toast'
import { openAddTaskDialog } from '@renderer/lib/open-add-task-dialog'
import { transport } from '@renderer/lib/transport'
import { Commands } from '@shared/protocol/commands'
import { legacyTaskMetadataSchema } from '@shared/schemas/legacy-import'
import type { AddTaskPrefill } from '@shared/schemas/show-add-task-window'
import type { DownloadTask } from '@shared/types/task'
import { useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

export function LegacyFreshDownload({ task }: { task: DownloadTask }) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const inFlight = useRef(false)
  const marker = legacyTaskMetadataSchema.safeParse(
    task.instances[0]?.payload.legacyImport
  )
  const prepare = async () => {
    if (inFlight.current) return
    inFlight.current = true
    setBusy(true)
    try {
      const prefill = (await transport.invoke(
        Commands.PrepareLegacyFreshDownload,
        { taskId: task.id }
      )) as AddTaskPrefill | null
      if (!prefill) return
      await openAddTaskDialog(prefill)
      setOpen(false)
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause)
      const key = message.match(/legacyImport\.errors\.[a-zA-Z]+/)?.[0]
      toast.add({
        title: key ? t(key) : t('legacyImport.errors.failed'),
        type: 'error',
      })
    } finally {
      inFlight.current = false
      setBusy(false)
    }
  }
  return (
    <>
      <div className="space-y-3 rounded-md border p-3">
        <p className="text-xs leading-5 text-muted-foreground">
          {marker.success
            ? t(`legacyImport.reasons.${marker.data.reason}`)
            : t('legacyImport.capabilityLimit')}{' '}
          {t('legacyImport.capabilityLimit')}
        </p>
        <Button
          size="sm"
          variant="outline"
          onClick={() => setOpen(true)}
          disabled={busy}
        >
          {t('legacyImport.freshDownload')}
        </Button>
      </div>
      <AlertDialog
        open={open}
        onOpenChange={(next) => {
          if (!busy) setOpen(next)
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t('legacyImport.freshDownload')}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t('legacyImport.freshDescription')}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <Button
              size="sm"
              variant="outline"
              disabled={busy}
              onClick={() => setOpen(false)}
            >
              {t('common.cancel')}
            </Button>
            <Button size="sm" disabled={busy} onClick={() => void prepare()}>
              {t('legacyImport.chooseDestination')}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}
