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
import { Queries } from '@shared/protocol/queries'
import { legacyBtAvailabilitySchema } from '@shared/schemas/legacy-bt-activation'
import type { AddTaskPrefill } from '@shared/schemas/show-add-task-window'
import type { DownloadTask } from '@shared/types/task'
import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

export function LegacyFreshDownload({ task }: { task: DownloadTask }) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const inFlight = useRef(false)
  const [availability, setAvailability] = useState<ReturnType<
    typeof legacyBtAvailabilitySchema.parse
  > | null>(null)
  useEffect(() => {
    let current = true
    setAvailability(null)
    void transport
      .invoke(Queries.GetLegacyBtActivationAvailability, { taskId: task.id })
      .then((value) => {
        if (current) setAvailability(legacyBtAvailabilitySchema.parse(value))
      })
      .catch(() => {
        if (current)
          setAvailability({
            available: false,
            reason: 'legacyImport.errors.checkpointUnavailable',
            directory: task.saveDir,
          })
      })
    return () => {
      current = false
    }
  }, [task.id, task.saveDir])
  const activate = async () => {
    if (inFlight.current) return
    inFlight.current = true
    setBusy(true)
    try {
      await transport.invoke(Commands.ActivateLegacyBt, { taskId: task.id })
    } catch (cause) {
      const key = String(cause).match(/legacyImport\.errors\.[a-zA-Z]+/)?.[0]
      toast.add({
        title: key ? t(key) : t('legacyImport.errors.failed'),
        type: 'error',
      })
    } finally {
      inFlight.current = false
      setBusy(false)
    }
  }
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
          {task.type === 'bt'
            ? availability?.available
              ? t('legacyImport.verifyReady')
              : t(availability?.reason ?? 'legacyImport.loading')
            : t('legacyImport.capabilityLimit')}
        </p>
        {task.type === 'bt' && (
          <div className="space-y-2">
            <p className="text-xs leading-5 text-muted-foreground">
              {t('legacyImport.verifyDescription')}
            </p>
            <p className="break-all text-xs">
              {availability?.directory ?? task.saveDir}
            </p>
            <Button
              size="sm"
              disabled={busy || !availability?.available}
              onClick={() => void activate()}
            >
              {t('legacyImport.verifyAndContinue')}
            </Button>
          </div>
        )}
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
