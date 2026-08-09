import { DirectoryPicker } from '@renderer/components/desktop-kit/directory-picker'
import { FileList } from '@renderer/components/file-list/file-list'
import type { AddTaskFormValues } from '@shared/schemas/add-task'
import type { TorrentFileInfo } from '@shared/types/torrent'
import { useCallback } from 'react'
import { useFormContext, useWatch } from 'react-hook-form'
import { useTranslation } from 'react-i18next'
import { AdvancedPanel } from './advanced-panel'
import { FileTypeFilters } from './file-type-filters'
import { TorrentInfoHeader } from './torrent-info-header'

interface TorrentFilePanelProps {
  onClear: () => void
}

export function TorrentFilePanel({ onClear }: TorrentFilePanelProps) {
  const { t } = useTranslation()
  const { setValue } = useFormContext<AddTaskFormValues>()
  const meta = useWatch<AddTaskFormValues, 'torrentMeta'>({
    name: 'torrentMeta',
  })
  const selected = useWatch<AddTaskFormValues, 'selectedFiles'>({
    name: 'selectedFiles',
  })

  const handleSelection = useCallback(
    (ids: number[]) => {
      setValue('selectedFiles' as never, ids as never, {
        shouldDirty: true,
        shouldValidate: true,
      })
    },
    [setValue]
  )

  if (!meta) return null

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-2">
      <TorrentInfoHeader onClear={onClear} />

      <div className="flex min-h-[200px] max-h-[calc(100vh-380px)] min-w-0 overflow-hidden rounded-md border border-border">
        <FileList<TorrentFileInfo>
          files={meta.files}
          selectedIndices={selected ?? []}
          onSelectionChange={handleSelection}
          headerSlot={<FileTypeFilters />}
        />
      </div>
      <DirectoryPicker
        name="saveDir"
        variant="compact"
        prefixLabel={t('task.add.saveTo')}
        placeholder={t('task.add.saveDirEmpty')}
      />
      <AdvancedPanel />
    </div>
  )
}
