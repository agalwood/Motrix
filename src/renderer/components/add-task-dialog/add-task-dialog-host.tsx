import { AddTaskForm } from '@renderer/components/add-task/add-task-form'
import { TaskFormDialog } from '@renderer/components/task-form-dialog'
import { Dialog } from '@renderer/components/ui/dialog'
import { MenuConfirmation } from '@renderer/features/application-menu/menu-confirmation'
import { WebDirectoryPickerDialog } from '@renderer/features/web-directory-picker/web-directory-picker-dialog'
import { useExitSnapshot } from '@renderer/hooks/use-exit-snapshot'
import { showMagnetFileSelection } from '@renderer/lib/open-magnet-file-selection'
import { transport } from '@renderer/lib/transport'
import { PlatformServicesProvider } from '@renderer/platform/services'
import {
  __setWebCloseHandler,
  webServices,
} from '@renderer/platform/web-services'
import {
  ADD_TASK_COLLAPSED_HEIGHT,
  ADD_TASK_MAX_HEIGHT,
} from '@shared/constants/add-task'
import { Events } from '@shared/protocol/events'
import {
  addTaskModeToFormDefaults,
  magnetFileSelectionPayloadSchema,
  magnetFileSelectionSettledPayloadSchema,
  protocolTorrentFilePayloadSchema,
  setAddTaskModeEventPayloadSchema,
} from '@shared/schemas/add-task'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router'
import { useAdaptiveDialogHeight } from './use-adaptive-dialog-height'
import { useAddTaskDialogStore } from './use-add-task-dialog-store'
import { usePendingMagnetSelection } from './use-pending-magnet-selection'

export function AddTaskDialogHost() {
  const { t } = useTranslation()
  const open = useAddTaskDialogStore((s) => s.open)
  const revision = useAddTaskDialogStore((s) => s.revision)
  const torrentFiles = useAddTaskDialogStore((s) => s.torrentFiles)
  const [draft, setDraft] = useState({ dirty: false, busy: false })
  const [discard, setDiscard] = useState(false)
  const onDraftStateChange = useCallback(
    (dirty: boolean, busy: boolean) => setDraft({ dirty, busy }),
    []
  )
  const prefill = useAddTaskDialogStore((s) => s.prefill)
  const presentation = useExitSnapshot(open, {
    revision,
    prefill,
    torrentFiles,
  })
  const openWith = useAddTaskDialogStore((s) => s.openWith)
  const close = useAddTaskDialogStore((s) => s.close)
  const requestClose = useCallback(() => {
    if (draft.busy) return
    if (draft.dirty) setDiscard(true)
    else close()
  }, [draft, close])
  useEffect(() => {
    if (!open) {
      setDraft({ dirty: false, busy: false })
      setDiscard(false)
    }
  }, [open])
  const navigate = useNavigate()
  const dialogRef = useRef<HTMLDivElement>(null)
  const {
    height: dialogHeight,
    resetHeight: resetDialogHeight,
    scheduleMeasurement: scheduleDialogHeightMeasurement,
  } = useAdaptiveDialogHeight(dialogRef, {
    collapsedHeight: ADD_TASK_COLLAPSED_HEIGHT,
    maxHeight: ADD_TASK_MAX_HEIGHT,
    open,
  })
  const onAdvancedOpenChange = useCallback(
    (expanded: boolean) => {
      if (expanded) scheduleDialogHeightMeasurement()
      else resetDialogHeight()
    },
    [resetDialogHeight, scheduleDialogHeightMeasurement]
  )

  // Web mirror of AddTaskWindow's electron behavior: after a successful
  // submit, close the dialog and route the main view to /downloads so
  // the user lands on the list with the new task visible.
  //
  // Guard against the cancelled-submit race: CreateTask is in-flight for
  // ~300-500ms, and the user can close the dialog (Esc / outside-click)
  // during that window. If they did, the store is already closed —
  // navigating would yank them off whatever route they switched to.
  const onSubmitSuccess = useCallback(
    (taskId: string) => {
      const current = useAddTaskDialogStore.getState()
      if (!current.open || current.revision !== revision) return
      close()
      navigate(`/downloads/all?task=${encodeURIComponent(taskId)}`)
    },
    [close, navigate, revision]
  )

  usePendingMagnetSelection(onSubmitSuccess)

  // Register the web close handler so webServices.closeHost() works.
  useEffect(() => {
    __setWebCloseHandler(requestClose)
    return () => __setWebCloseHandler(null)
  }, [requestClose])

  // Global event subscription — even when Dialog is closed.
  useEffect(() => {
    const onMagnet = (...args: unknown[]) => {
      const p = magnetFileSelectionPayloadSchema.safeParse(args[0])
      if (!p.success) return
      // The snapshot recovery hook offers this task after the current form
      // closes. Never overwrite user input or an in-flight submission.
      if (useAddTaskDialogStore.getState().open) return
      showMagnetFileSelection(p.data)
    }
    const onSelectionSettled = (...args: unknown[]) => {
      const parsed = magnetFileSelectionSettledPayloadSchema.safeParse(args[0])
      const current = useAddTaskDialogStore.getState()
      if (
        !parsed.success ||
        !current.open ||
        current.prefill?.tab !== 'torrent' ||
        current.prefill.existingTaskId !== parsed.data.taskId
      )
        return
      current.close()
    }
    const onProtocol = (...args: unknown[]) => {
      const p = protocolTorrentFilePayloadSchema.safeParse(args[0])
      if (!p.success) return
      openWith({
        tab: 'torrent',
        source: 'file',
        base64: p.data.payload.dataBase64,
        torrentMeta: p.data.meta,
        selectedFiles: p.data.meta.files.map((f) => f.index),
      })
    }
    const onSetMode = (...args: unknown[]) => {
      const p = setAddTaskModeEventPayloadSchema.safeParse(args[0])
      if (!p.success) return
      openWith(addTaskModeToFormDefaults(p.data))
    }

    transport.on(Events.MagnetFileSelection, onMagnet)
    transport.on(Events.MagnetFileSelectionSettled, onSelectionSettled)
    transport.on(Events.ProtocolTorrentFile, onProtocol)
    transport.on(Events.SetAddTaskMode, onSetMode)
    return () => {
      transport.off(Events.MagnetFileSelection, onMagnet)
      transport.off(Events.MagnetFileSelectionSettled, onSelectionSettled)
      transport.off(Events.ProtocolTorrentFile, onProtocol)
      transport.off(Events.SetAddTaskMode, onSetMode)
    }
  }, [openWith])

  return (
    <>
      <Dialog open={open} onOpenChange={(v) => !v && requestClose()}>
        <TaskFormDialog
          contentRef={dialogRef}
          title={t('task.add.title')}
          busy={draft.busy}
          height={dialogHeight}
        >
          <PlatformServicesProvider services={webServices}>
            <AddTaskForm
              active={open}
              key={presentation.revision}
              defaultValues={presentation.prefill}
              initialTorrentFiles={presentation.torrentFiles}
              onDraftStateChange={onDraftStateChange}
              onSubmitSuccess={onSubmitSuccess}
              onCancel={requestClose}
              onAdvancedOpenChange={onAdvancedOpenChange}
              presentation="dialog"
              subscribeEvents={false}
            />
          </PlatformServicesProvider>
        </TaskFormDialog>
      </Dialog>
      <MenuConfirmation
        request={
          discard
            ? {
                kind: 'discard',
                run: async () => {
                  setDiscard(false)
                  close()
                },
              }
            : null
        }
        close={() => setDiscard(false)}
      />
      <WebDirectoryPickerDialog />
    </>
  )
}
