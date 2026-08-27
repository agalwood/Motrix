import { VirtualList } from '@renderer/components/desktop-kit/virtual-list/virtual-list'
import { Checkbox } from '@renderer/components/ui/checkbox'
import { cn } from '@renderer/lib/utils'
import type { BaseFileRow } from '@shared/types/file-row'
import { type ReactNode, useMemo } from 'react'
import { useTranslation } from 'react-i18next'

function formatSize(bytes: number): string {
  if (bytes >= 1_073_741_824) {
    return `${(bytes / 1_073_741_824).toFixed(1)} GB`
  }
  if (bytes >= 1_048_576) {
    return `${(bytes / 1_048_576).toFixed(1)} MB`
  }
  if (bytes >= 1_024) {
    return `${(bytes / 1_024).toFixed(1)} KB`
  }
  return `${bytes} B`
}

interface FileListProps<T extends BaseFileRow = BaseFileRow> {
  files: T[]
  selectedIndices: number[]
  onSelectionChange?: (indices: number[]) => void
  readOnly?: boolean
  /** Optional slot rendered in the sticky header's trailing area. */
  headerSlot?: ReactNode
  headerClassName?: string
  /** Optional trailing renderer per row (e.g. progress percent in detail). */
  renderRowTrailing?: (file: T) => ReactNode
}

export function FileList<T extends BaseFileRow = BaseFileRow>({
  files,
  selectedIndices,
  onSelectionChange,
  readOnly = false,
  headerSlot,
  headerClassName,
  renderRowTrailing,
}: FileListProps<T>) {
  const { t } = useTranslation()

  const selectedSet = useMemo(() => new Set(selectedIndices), [selectedIndices])
  const allSelected =
    files.length > 0 && files.every((f) => selectedSet.has(f.index))
  const someSelected = selectedIndices.length > 0 && !allSelected

  const totalSelectedSize = useMemo(
    () =>
      files
        .filter((f) => selectedSet.has(f.index))
        .reduce((acc, f) => acc + f.size, 0),
    [files, selectedSet]
  )

  const summary = `${t('task.torrent.fileSelected', {
    count: selectedIndices.length,
  })} · ${formatSize(totalSelectedSize)}`

  function toggleSelectAll() {
    if (readOnly || !onSelectionChange) return
    if (allSelected) {
      onSelectionChange([])
    } else {
      onSelectionChange(files.map((f) => f.index))
    }
  }

  function toggleFile(index: number) {
    if (readOnly || !onSelectionChange) return
    if (selectedSet.has(index)) {
      onSelectionChange(selectedIndices.filter((i) => i !== index))
    } else {
      onSelectionChange([...selectedIndices, index])
    }
  }

  return (
    <VirtualList<T>
      items={files}
      getId={(f) => String(f.index)}
      rowHeight={32}
      className="h-full w-full"
      renderHeader={() => (
        <div
          className={cn(
            'sticky top-0 z-10 flex items-center gap-2 border-b border-border bg-background px-3 py-2 text-xs text-muted-foreground',
            headerClassName
          )}
        >
          <div className="flex items-center gap-2 flex-1">
            {!readOnly && (
              <Checkbox
                checked={allSelected}
                indeterminate={someSelected}
                onCheckedChange={toggleSelectAll}
                aria-label={t('task.torrent.selectAll')}
              />
            )}
            <span className="flex-1 tabular-nums">{summary}</span>
          </div>
          {headerSlot}
        </div>
      )}
      renderRow={({ item: file }) => {
        const isSelected = selectedSet.has(file.index)
        return (
          <div
            className={cn(
              'flex h-full items-center gap-2 border-b border-border/50 px-3 transition-colors',
              !readOnly && 'hover:bg-accent/40',
              isSelected && 'bg-accent/30'
            )}
          >
            <Checkbox
              checked={isSelected}
              onCheckedChange={() => toggleFile(file.index)}
              disabled={readOnly}
              aria-label={file.path}
            />
            <span
              className="min-w-0 flex-1 truncate text-xs"
              dir="auto"
              title={file.path}
            >
              {file.path}
            </span>
            <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
              {formatSize(file.size)}
            </span>
            {renderRowTrailing?.(file)}
          </div>
        )
      }}
    />
  )
}
