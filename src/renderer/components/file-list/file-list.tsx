import { VirtualList } from '@renderer/components/desktop-kit/virtual-list/virtual-list'
import { Checkbox } from '@renderer/components/ui/checkbox'
import { useByteFormat } from '@renderer/hooks/use-byte-format'
import { cn } from '@renderer/lib/utils'
import { extractExtension } from '@shared/lib/path-ext'
import type { BaseFileRow } from '@shared/types/file-row'
import { type ReactNode, useMemo } from 'react'
import { useTranslation } from 'react-i18next'

interface FileListProps<T extends BaseFileRow = BaseFileRow> {
  files: T[]
  selectedIndices: number[]
  onSelectionChange?: (indices: number[]) => void
  readOnly?: boolean
  scrollbar?: 'native' | 'custom'
  className?: string
  /** Optional slot rendered in the sticky header's trailing area. */
  headerSlot?: ReactNode
  headerClassName?: string
  showColumnHeaders?: boolean
  /** Optional trailing renderer per row (e.g. progress percent in detail). */
  renderRowTrailing?: (file: T) => ReactNode
  rowTrailingLabel?: string
  renderRowSize?: (file: T) => ReactNode
}

export function FileList<T extends BaseFileRow = BaseFileRow>({
  files,
  selectedIndices,
  onSelectionChange,
  readOnly = false,
  scrollbar = 'native',
  className,
  headerSlot,
  headerClassName,
  showColumnHeaders = true,
  renderRowTrailing,
  rowTrailingLabel,
  renderRowSize,
}: FileListProps<T>) {
  const { formatBytes } = useByteFormat()

  const { t } = useTranslation()
  const minWidth = renderRowTrailing ? 'min-w-[384px]' : 'min-w-[320px]'

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
  })} · ${formatBytes(totalSelectedSize)}`

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
      scrollbar={scrollbar}
      items={files}
      getId={(f) => String(f.index)}
      rowHeight={32}
      className={cn('h-full w-full', className)}
      renderHeader={() => (
        <div
          className={cn(
            'sticky top-0 z-10 border-b border-border bg-background px-3 py-2 text-xs text-muted-foreground',
            minWidth,
            headerClassName
          )}
        >
          <div className="flex items-center gap-2">
            {!readOnly && (
              <Checkbox
                checked={allSelected}
                indeterminate={someSelected}
                onCheckedChange={toggleSelectAll}
                aria-label={t('task.torrent.selectAll')}
              />
            )}
            <span className="min-w-0 flex-1 tabular-nums">{summary}</span>
            {headerSlot}
          </div>
          {showColumnHeaders && (
            <div className="mt-2 flex items-center gap-2 font-medium">
              <span className="size-4 shrink-0" aria-hidden="true" />
              <span className="min-w-0 flex-1 truncate">
                {t('task.torrent.column.name')}
              </span>
              <span className="w-14 shrink-0 truncate">
                {t('task.torrent.column.type')}
              </span>
              <span className="w-18 shrink-0 truncate text-end">
                {t('task.torrent.column.size')}
              </span>
              {renderRowTrailing && (
                <span className="w-14 shrink-0 truncate text-end">
                  {rowTrailingLabel}
                </span>
              )}
            </div>
          )}
        </div>
      )}
      renderRow={({ item: file }) => {
        const isSelected = selectedSet.has(file.index)
        const extension = extractExtension(file.path)
        const fileType = extension.slice(1) || '—'
        return (
          <div
            className={cn(
              'flex h-full items-center gap-2 border-b border-border/50 px-3 transition-colors',
              minWidth,
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
            <span
              className="w-14 shrink-0 truncate text-xs text-muted-foreground"
              dir="ltr"
              title={fileType}
            >
              {fileType}
            </span>
            <span className="w-18 shrink-0 truncate text-end text-xs tabular-nums text-muted-foreground">
              {renderRowSize ? renderRowSize(file) : formatBytes(file.size)}
            </span>
            {renderRowTrailing && (
              <span className="w-14 shrink-0 truncate text-end">
                {renderRowTrailing(file)}
              </span>
            )}
          </div>
        )
      }}
    />
  )
}
