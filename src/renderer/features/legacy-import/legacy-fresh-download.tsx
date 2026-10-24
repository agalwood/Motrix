import { MiddleEllipsis } from '@renderer/components/desktop-kit/middle-ellipsis'
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
import { legacyHttpAvailabilitySchema } from '@shared/schemas/legacy-http-activation'
import { legacyTaskMetadataSchema } from '@shared/schemas/legacy-import'
import type { AddTaskPrefill } from '@shared/schemas/show-add-task-window'
import type { DownloadTask } from '@shared/types/task'
import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

type PendingOperation = Pick<DownloadTask, 'id' | 'name' | 'type'> & {
  kind: 'activate' | 'prepare'
}

export function LegacyFreshDownload({ task }: { task: DownloadTask }) {
  const { t } = useTranslation()
  const marker = legacyTaskMetadataSchema.safeParse(
    task.instances[0]?.payload.legacyImport
  )
  const requiresRequestSettings =
    task.type === 'http' &&
    marker.success &&
    marker.data.reason === 'request-settings-required'
  const requestOptions = marker.success ? marker.data.requestOptions : undefined
  const freshDownloadLabel = t(
    requiresRequestSettings
      ? 'legacyImport.reconfigureDownload'
      : 'legacyImport.freshDownload'
  )
  const [open, setOpen] = useState(false)
  const [operation, setOperation] = useState<PendingOperation | null>(null)
  const [cancelling, setCancelling] = useState(false)
  const busy = operation !== null
  const inFlight = useRef<PendingOperation | null>(null)
  const [availability, setAvailability] = useState<ReturnType<
    typeof legacyBtAvailabilitySchema.parse
  > | null>(null)
  useEffect(() => {
    let current = true
    setAvailability(null)
    if (task.type !== 'bt' && task.type !== 'http') return
    const schema =
      task.type === 'http'
        ? legacyHttpAvailabilitySchema
        : legacyBtAvailabilitySchema
    void transport
      .invoke(
        task.type === 'http'
          ? Queries.GetLegacyHttpActivationAvailability
          : Queries.GetLegacyBtActivationAvailability,
        { taskId: task.id }
      )
      .then((value) => {
        if (current) setAvailability(schema.parse(value))
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
  }, [task.id, task.saveDir, task.type])
  const activate = async () => {
    if (inFlight.current) return
    const pending: PendingOperation = {
      id: task.id,
      name: task.name,
      type: task.type,
      kind: 'activate',
    }
    inFlight.current = pending
    setOperation(pending)
    setCancelling(false)
    try {
      await transport.invoke(
        task.type === 'http'
          ? Commands.ActivateLegacyHttp
          : Commands.ActivateLegacyBt,
        { taskId: task.id }
      )
    } catch (cause) {
      const key = String(cause).match(/legacyImport\.errors\.[a-zA-Z]+/)?.[0]
      toast.add({
        title: key ? t(key) : t('legacyImport.errors.failed'),
        ...(task.type === 'http' && {
          description: t('legacyImport.httpOriginalFilesKept'),
        }),
        type: 'error',
      })
    } finally {
      inFlight.current = null
      setOperation(null)
      setCancelling(false)
    }
  }
  const cancelActivation = async () => {
    if (
      operation?.kind !== 'activate' ||
      cancelling ||
      operation.type !== 'http'
    )
      return
    const pending = operation
    setCancelling(true)
    try {
      await transport.invoke(Commands.CancelLegacyHttpActivation, {
        taskId: pending.id,
      })
    } catch (cause) {
      const key = String(cause).match(/legacyImport\.errors\.[a-zA-Z]+/)?.[0]
      toast.add({
        title: key ? t(key) : t('legacyImport.errors.failed'),
        type: 'error',
      })
      if (inFlight.current === pending) setCancelling(false)
    }
  }
  const prepare = async () => {
    if (inFlight.current) return
    const pending: PendingOperation = {
      id: task.id,
      name: task.name,
      type: task.type,
      kind: 'prepare',
    }
    inFlight.current = pending
    setOperation(pending)
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
      inFlight.current = null
      setOperation(null)
    }
  }
  return (
    <>
      <div className="space-y-3 rounded-md border p-3">
        <p className="text-xs leading-5 text-muted-foreground">
          {availability?.available
            ? t('legacyImport.verifyReady')
            : t(availability?.reason ?? 'legacyImport.loading')}
        </p>
        {requiresRequestSettings && Boolean(requestOptions?.length) && (
          <p className="break-words text-xs leading-5 text-muted-foreground">
            {t('legacyImport.requestOptions', {
              options: requestOptions?.join(', '),
            })}
          </p>
        )}
        {(task.type === 'bt' || task.type === 'http') && (
          <div className="space-y-2">
            <p className="text-xs leading-5 text-muted-foreground">
              {t(
                task.type === 'http'
                  ? 'legacyImport.httpResumeDescription'
                  : 'legacyImport.verifyDescription'
              )}
            </p>
            <p className="min-w-0 text-xs">
              <MiddleEllipsis
                text={availability?.directory ?? task.saveDir}
                maxChars={64}
                className="font-sans!"
              />
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
        {operation?.type === 'http' && operation.kind === 'activate' && (
          <div className="space-y-2">
            <p
              role="status"
              className="text-xs leading-5 text-muted-foreground"
            >
              <span className="block font-medium">
                <MiddleEllipsis text={operation.name} className="font-sans!" />
              </span>
              {t('legacyImport.httpVerifying')}
            </p>
            <Button
              size="sm"
              variant="outline"
              disabled={cancelling}
              onClick={() => void cancelActivation()}
            >
              {t('common.cancel')}
            </Button>
          </div>
        )}
        <Button
          size="sm"
          variant="outline"
          onClick={() => setOpen(true)}
          disabled={busy}
        >
          {freshDownloadLabel}
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
            <AlertDialogTitle>{freshDownloadLabel}</AlertDialogTitle>
            <AlertDialogDescription>
              {t('legacyImport.freshDescription')}
              {requiresRequestSettings && (
                <span className="mt-2 block">
                  {t('legacyImport.requestSettingsDescription')}
                </span>
              )}
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
