import { useAdaptiveDialogHeight } from '@renderer/components/add-task-dialog/use-adaptive-dialog-height'
import { TaskFormDialog } from '@renderer/components/task-form-dialog'
import { Dialog } from '@renderer/components/ui/dialog'
import {
  ADD_TASK_COLLAPSED_HEIGHT,
  ADD_TASK_MAX_HEIGHT,
} from '@shared/constants/add-task'
import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { CreateTorrentForm } from './create-torrent-form'
import { ServerTorrentClient } from './server-torrent-client'

export function ServerTorrentDialog({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation()
  const [client] = useState(() => new ServerTorrentClient())
  const [busy, setBusy] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const { height } = useAdaptiveDialogHeight(ref, {
    open: true,
    collapsedHeight: ADD_TASK_COLLAPSED_HEIGHT,
    maxHeight: ADD_TASK_MAX_HEIGHT,
  })
  useEffect(() => () => client.release(), [client])
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) onClose()
      }}
    >
      <TaskFormDialog
        contentRef={ref}
        title={t('createTorrent.title')}
        busy={busy}
        height={height}
      >
        <CreateTorrentForm
          server={client}
          onBusyChange={setBusy}
          onClose={onClose}
        />
      </TaskFormDialog>
    </Dialog>
  )
}
