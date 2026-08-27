import { AddTaskForm } from '@renderer/components/add-task/add-task-form'
import { Button } from '@renderer/components/ui/button'
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@renderer/components/ui/dialog'
import { Input } from '@renderer/components/ui/input'
import { WindowChromeCaptionIcon } from '@renderer/components/window-chrome/window-chrome'
import { transport } from '@renderer/lib/transport'
import { PlatformServicesProvider } from '@renderer/platform/services'
import {
  __setWebCloseHandler,
  __webPathPickerBus,
  webServices,
} from '@renderer/platform/web-services'
import {
  ADD_TASK_COLLAPSED_HEIGHT,
  ADD_TASK_MAX_HEIGHT,
} from '@shared/constants/add-task'
import { Events } from '@shared/protocol/events'
import { Queries } from '@shared/protocol/queries'
import {
  magnetFileSelectionPayloadSchema,
  protocolTorrentFilePayloadSchema,
  setAddTaskModeEventPayloadSchema,
  urlParamsToFormDefaults,
} from '@shared/schemas/add-task'
import { useCallback, useEffect, useId, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router'
import { useAdaptiveDialogHeight } from './use-adaptive-dialog-height'
import { useAddTaskDialogStore } from './use-add-task-dialog-store'

export function AddTaskDialogHost() {
  const { t } = useTranslation()
  const open = useAddTaskDialogStore((s) => s.open)
  const prefill = useAddTaskDialogStore((s) => s.prefill)
  const openWith = useAddTaskDialogStore((s) => s.openWith)
  const close = useAddTaskDialogStore((s) => s.close)
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
      if (!useAddTaskDialogStore.getState().open) return
      close()
      navigate(`/downloads/all?task=${encodeURIComponent(taskId)}`)
    },
    [close, navigate]
  )

  // Register the web close handler so webServices.closeHost() works.
  useEffect(() => {
    __setWebCloseHandler(() => useAddTaskDialogStore.getState().close())
    return () => __setWebCloseHandler(null)
  }, [])

  // Global event subscription — even when Dialog is closed.
  useEffect(() => {
    const onMagnet = (...args: unknown[]) => {
      const p = magnetFileSelectionPayloadSchema.safeParse(args[0])
      if (!p.success) return
      openWith({
        tab: 'torrent',
        source: 'magnet',
        magnetUri: p.data.magnetUri,
        base64: p.data.torrentBase64,
        torrentMeta: p.data.meta,
        selectedFiles: p.data.meta.files.map((f) => f.index),
        saveDir: p.data.saveDir,
        // Plan B: forward the metadata pending task's motrixId so the
        // CreateTask handler can swap the instance in place rather
        // than creating a duplicate row in Downloads.
        existingTaskId: p.data.taskId,
      })
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
      openWith(urlParamsToFormDefaults(p.data))
    }

    transport.on(Events.MagnetFileSelection, onMagnet)
    transport.on(Events.ProtocolTorrentFile, onProtocol)
    transport.on(Events.SetAddTaskMode, onSetMode)
    return () => {
      transport.off(Events.MagnetFileSelection, onMagnet)
      transport.off(Events.ProtocolTorrentFile, onProtocol)
      transport.off(Events.SetAddTaskMode, onSetMode)
    }
  }, [openWith])

  return (
    <>
      <Dialog open={open} onOpenChange={(v) => !v && close()}>
        <DialogContent
          ref={dialogRef}
          showCloseButton={false}
          overlayClassName="transition-opacity duration-150 data-open:animate-none data-closed:animate-none data-starting-style:opacity-0 data-ending-style:opacity-0"
          className="flex w-[calc(100%-2rem)] max-w-[640px] flex-col gap-0 overflow-hidden p-0 transition-[height] duration-200 ease-out motion-reduce:transition-none sm:max-w-[640px]"
          style={{
            height: dialogHeight,
            maxHeight: `min(${ADD_TASK_MAX_HEIGHT}px, calc(100vh - 2rem))`,
          }}
        >
          <DialogHeader className="h-10 shrink-0 justify-center px-4 pe-14">
            <DialogTitle className="pt-[14px] text-[13px] font-semibold">
              {t('task.add.title')}
            </DialogTitle>
          </DialogHeader>
          <PlatformServicesProvider services={webServices}>
            <AddTaskForm
              key={open ? 'open' : 'closed'}
              defaultValues={prefill}
              onSubmitSuccess={onSubmitSuccess}
              onCancel={close}
              onAdvancedOpenChange={onAdvancedOpenChange}
              presentation="dialog"
              subscribeEvents={false}
            />
          </PlatformServicesProvider>
          <DialogClose
            aria-label={t('chrome.close')}
            className="app-no-drag absolute top-3.5 right-3.5 flex size-7 shrink-0 items-center justify-center rounded-md border-0 bg-transparent text-foreground outline-none transition-colors [&>svg]:opacity-65 hover:bg-accent hover:text-accent-foreground hover:[&>svg]:opacity-90 focus-visible:ring-2 focus-visible:ring-ring focus-visible:[&>svg]:opacity-90 dark:hover:bg-accent/50"
          >
            <WindowChromeCaptionIcon name="close" />
          </DialogClose>
        </DialogContent>
      </Dialog>
      <WebPathPickerDialog />
    </>
  )
}

function WebPathPickerDialog() {
  const { t } = useTranslation()
  const customInputId = useId()
  const [open, setOpen] = useState(false)
  const [defaultPath, setDefaultPath] = useState<string | undefined>()
  const [allowed, setAllowed] = useState<{ path: string; label?: string }[]>([])
  const [allowCustom, setAllowCustom] = useState(true)
  const [custom, setCustom] = useState('')
  const [selected, setSelected] = useState('')

  useEffect(() => {
    const unsubscribe = __webPathPickerBus.subscribe(async (req) => {
      setDefaultPath(req.defaultPath)
      setCustom('')
      try {
        const res = (await transport.invoke(Queries.ListAllowedSaveDirs)) as {
          paths: { path: string; label?: string }[]
          defaultPath: string
          allowCustom: boolean
        }
        setAllowed(res.paths)
        setAllowCustom(res.allowCustom)
        setSelected(req.defaultPath ?? res.defaultPath ?? '')
      } catch {
        setAllowed([])
        setAllowCustom(true)
        setSelected(req.defaultPath ?? '')
      }
      setOpen(true)
    })
    return () => unsubscribe()
  }, [])

  const confirm = (path: string | null) => {
    setOpen(false)
    __webPathPickerBus.resolve(path)
  }

  return (
    <Dialog open={open} onOpenChange={(v) => !v && confirm(null)}>
      <DialogContent className="max-w-[400px]">
        <DialogHeader>
          <DialogTitle>{t('task.add.pickPathTitle')}</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          {allowed.length > 0 && (
            <div className="space-y-1">
              {allowed.map((p) => (
                <label key={p.path} className="flex items-center gap-2 text-sm">
                  <input
                    type="radio"
                    checked={selected === p.path}
                    onChange={() => setSelected(p.path)}
                  />
                  <span dir="ltr">{p.label ?? p.path}</span>
                </label>
              ))}
            </div>
          )}
          {allowCustom && (
            <div className="space-y-1">
              <label
                htmlFor={customInputId}
                className="text-xs text-muted-foreground"
              >
                {t('task.add.pickPathCustom')}
              </label>
              <Input
                id={customInputId}
                value={custom}
                onChange={(e) => {
                  setCustom(e.target.value)
                  setSelected(e.target.value)
                }}
                placeholder={defaultPath ?? '/downloads'}
                dir="ltr"
              />
            </div>
          )}
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={() => confirm(null)}>
              {t('common.cancel')}
            </Button>
            <Button
              onClick={() => confirm(selected || null)}
              disabled={!selected}
            >
              {t('common.confirm')}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
