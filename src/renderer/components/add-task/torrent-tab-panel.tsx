import { openCreateTorrentDialog } from '@renderer/components/create-torrent/use-create-torrent-dialog-store'
import { FolderAddIcon } from '@renderer/components/icons'
import { Button } from '@renderer/components/ui/button'
import type { ParsedTorrentFile } from '@renderer/lib/parse-torrent-file'
import type { AddTaskFormValues } from '@shared/schemas/add-task'
import { useCallback } from 'react'
import { useFormContext, useWatch } from 'react-hook-form'
import { useTranslation } from 'react-i18next'
import { DropZone } from './drop-zone'
import { TorrentFilePanel } from './torrent-file-panel'

export function TorrentTabPanel({
  onFilesLoaded,
}: {
  onFilesLoaded: (files: ParsedTorrentFile[]) => void
}) {
  const { setValue } = useFormContext<AddTaskFormValues>()
  const meta = useWatch<AddTaskFormValues, 'torrentMeta'>({
    name: 'torrentMeta',
  })
  const { t } = useTranslation()

  const handleClear = useCallback(() => {
    setValue('torrentMeta' as never, undefined as never, { shouldDirty: true })
    setValue('base64' as never, undefined as never, { shouldDirty: true })
    setValue('magnetUri' as never, undefined as never, { shouldDirty: true })
    setValue('selectedFiles' as never, [] as never, { shouldDirty: true })
  }, [setValue])

  if (meta) {
    return <TorrentFilePanel onClear={handleClear} />
  }
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col justify-center gap-3">
      <DropZone onFilesLoaded={onFilesLoaded} />
      {/* #459: creating a torrent lives beside adding one — the natural
          place a user looks when they want to share local data. */}
      <div className="flex justify-center">
        <Button
          type="button"
          size="sm"
          variant="ghost"
          onClick={() => openCreateTorrentDialog()}
        >
          <FolderAddIcon />
          {t('createTorrent.openFromAddTask')}
        </Button>
      </div>
    </div>
  )
}
