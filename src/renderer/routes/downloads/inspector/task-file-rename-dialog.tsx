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
import { taskWritesAvailable } from '@renderer/features/application-menu/task-context'
import { useOperatorSession } from '@renderer/lib/operator-auth'
import { transport } from '@renderer/lib/transport'
import { Commands } from '@shared/protocol/commands'
import { taskFileNameSchema } from '@shared/schemas/task-file-rename'
import type { DownloadTask, TaskFile } from '@shared/types/task'
import { useEffect, useId, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

export function TaskFileRenameDialog({
  task,
  file,
  onClose,
  onRenamed,
}: {
  task: DownloadTask
  file: TaskFile
  onClose: () => void
  onRenamed: () => Promise<void>
}) {
  const { t } = useTranslation()
  useOperatorSession()
  const writable = transport.platform !== 'web' || taskWritesAvailable()
  const original = file.path.split(/[\\/]/u).at(-1) ?? file.path
  const [name, setName] = useState(original)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const id = useId()
  const alive = useRef(true)
  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
    }
  }, [])
  async function apply() {
    if (busy || !writable) return
    if (!taskFileNameSchema.safeParse(name).success) {
      setError('invalid')
      return
    }
    setBusy(true)
    setError('')
    try {
      await transport.invoke(Commands.RenameTaskFile, {
        taskId: task.id,
        engineTaskId: task.engineTaskId,
        fileIndex: file.index,
        expectedName: original,
        name,
      })
      await onRenamed()
      if (alive.current) onClose()
    } catch (reason) {
      if (!alive.current) return
      const message = reason instanceof Error ? reason.message : String(reason)
      setError(
        ['invalid', 'changed', 'unavailable', 'conflict', 'pending'].find(
          (key) => message.includes(`task.fileRename.${key}`)
        ) ?? 'failed'
      )
      void onRenamed()
    } finally {
      if (alive.current) setBusy(false)
    }
  }
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) onClose()
      }}
    >
      <DialogContent forceRenderOverlay>
        <form
          className="contents"
          onSubmit={(event) => {
            event.preventDefault()
            void apply()
          }}
        >
          <DialogHeader>
            <DialogTitle>{t('task.fileRename.title')}</DialogTitle>
            <DialogDescription>
              {t('task.fileRename.description')}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <Label htmlFor={id}>{t('task.torrent.column.name')}</Label>
            <Input
              id={id}
              value={name}
              disabled={busy}
              onChange={(event) => setName(event.target.value)}
              spellCheck={false}
            />
          </div>
          {error && (
            <p role="alert" className="text-xs text-destructive">
              {t(`task.fileRename.${error}`)}
            </p>
          )}
          <DialogFooter>
            <Button
              size="sm"
              variant="outline"
              type="button"
              disabled={busy}
              onClick={onClose}
            >
              {t('common.cancel')}
            </Button>
            <Button
              size="sm"
              type="submit"
              disabled={busy || !writable || name === original}
            >
              {t(busy ? 'common.loading' : 'common.apply')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
