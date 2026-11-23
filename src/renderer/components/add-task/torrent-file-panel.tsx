import { DirectoryPicker } from '@renderer/components/desktop-kit/directory-picker'
import { FileList } from '@renderer/components/file-list/file-list'
import type { AddTaskFormValues } from '@shared/schemas/add-task'
import type { TorrentFileInfo } from '@shared/types/torrent'
import { useWatch } from 'react-hook-form'
import { useTranslation } from 'react-i18next'
import { AdvancedPanel } from './advanced-panel'
import { FileTypeFilters } from './file-type-filters'
import { TorrentInfoHeader } from './torrent-info-header'
import { useTorrentFileSelection } from './use-torrent-file-selection'

interface TorrentFilePanelProps {
  onClear: () => void
}

export function TorrentFilePanel({ onClear }: TorrentFilePanelProps) {
  const { t } = useTranslation()
  const handleSelection = useTorrentFileSelection()
  const meta = useWatch<AddTaskFormValues, 'torrentMeta'>({
    name: 'torrentMeta',
  })
  const selected = useWatch<AddTaskFormValues, 'selectedFiles'>({
    name: 'selectedFiles',
  })

  if (!meta) return null

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-2">
      <TorrentInfoHeader onClear={onClear} />

      <div className="flex min-h-50 max-h-[calc(100vh-380px)] min-w-0 overflow-hidden rounded-md border border-border **:data-[slot=scroll-area-viewport]:focus-visible:ring-0">
        <FileList<TorrentFileInfo>
          key={meta.infoHash}
          scrollbar="custom"
          showColumnHeaders={false}
          files={meta.files}
          selectedIndices={selected ?? []}
          onSelectionChange={handleSelection}
          headerSlot={<FileTypeFilters />}
        />
      </div>
      <DirectoryPicker
        name="saveDir"
        variant="compact"
        showHistory
        prefixLabel={t('task.add.saveTo')}
        placeholder={t('task.add.saveDirEmpty')}
      />
      <AdvancedPanel />
    </div>
  )
}
