import { AddTaskForm } from '@renderer/components/add-task/add-task-form'
import { Button } from '@renderer/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@renderer/components/ui/dialog'
import { Input } from '@renderer/components/ui/input'
import { transport } from '@renderer/lib/transport'
import { PlatformServicesProvider } from '@renderer/platform/services'
import {
  __setWebCloseHandler,
  __webPathPickerBus,
  webServices,
} from '@renderer/platform/web-services'
import { Events } from '@shared/protocol/events'
import { Queries } from '@shared/protocol/queries'
import {
  magnetFileSelectionPayloadSchema,
  protocolTorrentFilePayloadSchema,
  setAddTaskModeEventPayloadSchema,
  urlParamsToFormDefaults,
} from '@shared/schemas/add-task'
import { useCallback, useEffect, useId, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router'
import { useAddTaskDialogStore } from './use-add-task-dialog-store'

export function AddTaskDialogHost() {
  const { t } = useTranslation()
  const open = useAddTaskDialogStore((s) => s.open)
  const prefill = useAddTaskDialogStore((s) => s.prefill)
  const openWith = useAddTaskDialogStore((s) => s.openWith)
  const close = useAddTaskDialogStore((s) => s.close)
  const navigate = useNavigate()

  // Web mirror of AddTaskWindow's electron behavior: after a successful
  // submit, close the dialog and route the main view to /downloads so
  // the user lands on the list with the new task visible.
  //
  // Guard against the cancelled-submit race: CreateTask is in-flight for
  // ~300-500ms, and the user can close the dialog (Esc / outside-click)
  // during that window. If they did, the store is already closed —
  // navigating would yank them off whatever route they switched to.
  const onSubmitSuccess = useCallback(() => {
    if (!useAddTaskDialogStore.getState().open) return
    close()
    navigate('/downloads')
  }, [close, navigate])

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
        <DialogContent className="max-w-[560px]">
          <DialogHeader>
            <DialogTitle>{t('task.add.title')}</DialogTitle>
          </DialogHeader>
          <PlatformServicesProvider services={webServices}>
            <AddTaskForm
              key={open ? 'open' : 'closed'}
              defaultValues={prefill}
              onSubmitSuccess={onSubmitSuccess}
              onCancel={close}
              subscribeEvents={false}
            />
          </PlatformServicesProvider>
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
