import { Button } from '@renderer/components/ui/button'
import { toast } from '@renderer/components/ui/toast'
import { openMagnetFileSelection } from '@renderer/lib/open-magnet-file-selection'
import type { DownloadTask } from '@shared/types/task'
import { ListChecks } from 'lucide-react'
import { useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

export function MagnetFileSelectionButton({ task }: { task: DownloadTask }) {
  const { t } = useTranslation()
  const pendingRef = useRef(false)
  const [pending, setPending] = useState(false)

  const openSelection = async () => {
    if (pendingRef.current) return
    pendingRef.current = true
    setPending(true)
    try {
      await openMagnetFileSelection(task.id)
    } catch (error) {
      toast.add({
        title: t('panel.downloads.action.singleTaskFailed', {
          name: task.name,
          reason: error instanceof Error ? error.message : String(error),
        }),
        type: 'error',
      })
    } finally {
      pendingRef.current = false
      setPending(false)
    }
  }

  return (
    <Button
      size="xs"
      variant="outline"
      className="w-fit max-w-full"
      disabled={pending}
      onClick={(event) => {
        event.stopPropagation()
        void openSelection()
      }}
    >
      <ListChecks />
      <span className="truncate">
        {t('panel.downloads.action.selectFiles')}
      </span>
    </Button>
  )
}
