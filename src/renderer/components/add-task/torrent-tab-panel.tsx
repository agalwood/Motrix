import type { ParsedTorrentFile } from '@renderer/lib/parse-torrent-file'
import type { AddTaskFormValues } from '@shared/schemas/add-task'
import { useCallback } from 'react'
import { useFormContext, useWatch } from 'react-hook-form'
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

  const handleClear = useCallback(() => {
    setValue('torrentMeta' as never, undefined as never, { shouldDirty: true })
    setValue('base64' as never, undefined as never, { shouldDirty: true })
    setValue('magnetUri' as never, undefined as never, { shouldDirty: true })
    setValue('selectedFiles' as never, [] as never, { shouldDirty: true })
  }, [setValue])

  return meta ? (
    <TorrentFilePanel onClear={handleClear} />
  ) : (
    <DropZone onFilesLoaded={onFilesLoaded} />
  )
}
