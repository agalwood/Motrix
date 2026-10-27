import { DirectoryPicker } from '@renderer/components/desktop-kit/directory-picker'
import { Button } from '@renderer/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@renderer/components/ui/dialog'
import { Input } from '@renderer/components/ui/input'
import { Label } from '@renderer/components/ui/label'
import { Switch } from '@renderer/components/ui/switch'
import { invalidateTaskList } from '@renderer/hooks/use-task-list'
import { transport } from '@renderer/lib/transport'
import { Commands } from '@shared/protocol/commands'
import { Events } from '@shared/protocol/events'
import type {
  BtStorageCommandResult,
  BtStorageProgress,
  BtStorageRequest,
} from '@shared/schemas/bt-storage'
import { type DownloadTask, TaskStatus } from '@shared/types/task'
import { useEffect, useId, useState } from 'react'
import { FormProvider, useForm } from 'react-hook-form'
import { useTranslation } from 'react-i18next'

export function BtStorageDialog({
  task,
  mode,
  onClose,
}: {
  task: DownloadTask
  mode: BtStorageRequest['mode']
  onClose: () => void
}) {
  const { t } = useTranslation()
  const id = useId()
  const form = useForm({
    defaultValues: {
      directory: task.saveDir,
      name: task.finalName || task.name,
    },
  })
  const [resume, setResume] = useState(
    mode === 'locate' || task.status === TaskStatus.Seeding
  )
  const [busy, setBusy] = useState(false)
  const [progress, setProgress] = useState<BtStorageProgress | null>(null)
  const [result, setResult] = useState<BtStorageCommandResult | null>(null)
  useEffect(() => {
    const listener = (...args: unknown[]) => {
      const value = args[0] as BtStorageProgress
      if (value.taskId === task.id) setProgress(value)
    }
    transport.on(Events.BtStorageProgress, listener)
    return () => transport.off(Events.BtStorageProgress, listener)
  }, [task.id])

  const submit = form.handleSubmit(async (values) => {
    if (busy) return
    setBusy(true)
    setResult(null)
    setProgress({
      taskId: task.id,
      phase: 'checking',
      checkedPieces: 0,
      totalPieces: 0,
    })
    try {
      setResult(
        (await transport.invoke(Commands.ChangeBtStorage, {
          taskId: task.id,
          mode,
          ...values,
          resume,
        })) as BtStorageCommandResult
      )
      invalidateTaskList()
    } catch {
      setResult({ error: 'failed' })
    } finally {
      setBusy(false)
    }
  })
  const message =
    result &&
    ('error' in result
      ? t(`task.storage.errors.${result.error}`)
      : !result.verification.complete
        ? t('task.storage.incomplete')
        : result.resumeFailed
          ? t('task.storage.resumeFailed')
          : t(
              result.resumed ? 'task.storage.resumed' : 'task.storage.verified'
            ))
  const verification =
    result && !('error' in result) ? result.verification : null
  const verifiedPercent = verification?.complete
    ? 100
    : verification &&
        verification.totalPieces > 0 &&
        verification.validPieces < verification.totalPieces
      ? Math.floor((verification.validPieces / verification.totalPieces) * 100)
      : null

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) onClose()
      }}
    >
      <DialogContent className="sm:max-w-lg" showCloseButton={!busy}>
        <DialogHeader>
          <DialogTitle>{t(`task.storage.${mode}`)}</DialogTitle>
          <DialogDescription>
            {t(`task.storage.${mode}Description`)}
          </DialogDescription>
        </DialogHeader>
        <FormProvider {...form}>
          <form onSubmit={submit} className="space-y-4">
            <p className="break-all text-xs text-muted-foreground">
              {result && !('error' in result) ? result.path : task.finalPath}
            </p>
            {mode !== 'recheck' && (
              <>
                <div className="space-y-1.5">
                  <Label htmlFor={`${id}-directory`}>
                    {t('task.storage.directory')}
                  </Label>
                  <DirectoryPicker
                    name="directory"
                    disabled={busy}
                    inputProps={{ id: `${id}-directory` }}
                    recordRecent={false}
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor={`${id}-name`}>{t('task.storage.name')}</Label>
                  <Input
                    id={`${id}-name`}
                    {...form.register('name', { required: true })}
                    disabled={busy}
                  />
                </div>
              </>
            )}
            <div className="flex items-center justify-between gap-4">
              <Label htmlFor={`${id}-resume`}>{t('task.storage.resume')}</Label>
              <Switch
                id={`${id}-resume`}
                checked={resume}
                onCheckedChange={setResume}
                disabled={busy}
              />
            </div>
            {busy && (
              <div role="status" className="space-y-2 text-xs">
                <p>{t(`task.storage.${progress?.phase ?? 'checking'}`)}</p>
                {progress?.phase === 'checking' && progress.totalPieces > 0 && (
                  <progress
                    className="h-2 w-full"
                    aria-label={t('task.storage.checking')}
                    value={progress.checkedPieces}
                    max={progress.totalPieces}
                  />
                )}
              </div>
            )}
            {message && (
              <div
                role="status"
                className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1"
              >
                <p className="min-w-0 flex-[1_1_16rem] text-sm">{message}</p>
                {verification && (
                  <p className="ms-auto shrink-0 text-xs text-muted-foreground tabular-nums">
                    {verifiedPercent === null
                      ? t('task.storage.checkFailed')
                      : t('task.storage.verifiedPercent', {
                          percent: verifiedPercent,
                        })}
                  </p>
                )}
              </div>
            )}
            <DialogFooter>
              {busy ? (
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={progress?.phase !== 'checking'}
                  onClick={() => {
                    void transport
                      .invoke(Commands.CancelBtStorage, task.id)
                      .catch(() => setResult({ error: 'failed' }))
                  }}
                >
                  {t('common.cancel')}
                </Button>
              ) : (
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={onClose}
                >
                  {t('common.close')}
                </Button>
              )}
              <Button type="submit" size="sm" disabled={busy}>
                {t(`task.storage.${mode}`)}
              </Button>
            </DialogFooter>
          </form>
        </FormProvider>
      </DialogContent>
    </Dialog>
  )
}
