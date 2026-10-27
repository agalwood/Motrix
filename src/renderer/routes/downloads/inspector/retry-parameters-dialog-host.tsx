import { AddTaskForm } from '@renderer/components/add-task/add-task-form'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@renderer/components/ui/dialog'
import { MenuConfirmation } from '@renderer/features/application-menu/menu-confirmation'
import { useExitSnapshot } from '@renderer/hooks/use-exit-snapshot'
import { useCallback, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router'
import {
  retryParametersPrefill,
  useRetryParametersStore,
} from './retry-parameters-store'

export function RetryParametersDialogHost() {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const { targets, total, revision, close, advance } = useRetryParametersStore()
  const target = targets[0]
  const open = Boolean(target)
  const presentation = useExitSnapshot(open, {
    target,
    total,
    current: total - targets.length + 1,
    revision,
  })
  const [draft, setDraft] = useState({ revision, dirty: false, busy: false })
  const busy = draft.revision === revision && draft.busy
  const dirty = draft.revision === revision && draft.dirty
  const [discardRevision, setDiscardRevision] = useState<number | null>(null)
  const onDraftStateChange = useCallback(
    (dirty: boolean, busy: boolean) => setDraft({ revision, dirty, busy }),
    [revision]
  )
  const requestClose = useCallback(() => {
    if (busy) return
    if (dirty) setDiscardRevision(revision)
    else close()
  }, [busy, dirty, revision, close])
  const onSubmitSuccess = useCallback(
    (taskId: string) => {
      if (!advance(revision)) return
      if (!useRetryParametersStore.getState().targets.length) {
        navigate(`/downloads/all?task=${encodeURIComponent(taskId)}`)
      }
    },
    [advance, revision, navigate]
  )

  return (
    <>
      <Dialog
        open={open}
        onOpenChange={(nextOpen) => !nextOpen && requestClose()}
      >
        <DialogContent
          className="flex h-[min(720px,calc(100dvh-2rem))] max-w-[calc(100%-2rem)] flex-col gap-0 overflow-hidden p-0 sm:max-w-[640px]"
          showCloseButton={!busy}
        >
          <DialogHeader className="shrink-0 gap-2 px-4 pt-4 pb-2 pe-12">
            <DialogTitle>
              {t('panel.downloads.action.retryDialogTitle')}
            </DialogTitle>
            <DialogDescription className="break-words text-xs">
              {t('panel.downloads.action.retryDialogDescription', {
                name: presentation.target?.name ?? '',
              })}
            </DialogDescription>
            {presentation.total > 1 && (
              <p className="text-xs text-muted-foreground">
                {t('panel.downloads.action.retryDialogProgress', {
                  current: presentation.current,
                  total: presentation.total,
                })}
              </p>
            )}
          </DialogHeader>
          {presentation.target && (
            <AddTaskForm
              key={presentation.revision}
              active={open}
              purpose="redownload"
              defaultValues={retryParametersPrefill(presentation.target)}
              onDraftStateChange={onDraftStateChange}
              onSubmitSuccess={onSubmitSuccess}
              onCancel={requestClose}
              presentation="dialog"
              subscribeEvents={false}
            />
          )}
        </DialogContent>
      </Dialog>
      <MenuConfirmation
        request={
          open && discardRevision === revision
            ? {
                kind: 'discard',
                run: async () => {
                  setDiscardRevision(null)
                  close()
                },
              }
            : null
        }
        close={() => setDiscardRevision(null)}
      />
    </>
  )
}
