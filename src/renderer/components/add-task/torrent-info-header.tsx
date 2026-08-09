import { Button } from '@renderer/components/ui/button'
import type { AddTaskFormValues } from '@shared/schemas/add-task'
import { X } from 'lucide-react'
import { useWatch } from 'react-hook-form'
import { useTranslation } from 'react-i18next'

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  const k = 1024
  const units = ['KB', 'MB', 'GB', 'TB']
  let i = -1
  let v = n
  do {
    v /= k
    i++
  } while (v >= k && i < units.length - 1)
  return `${v.toFixed(1)} ${units[i]}`
}

interface TorrentInfoHeaderProps {
  onClear: () => void
}

export function TorrentInfoHeader({ onClear }: TorrentInfoHeaderProps) {
  const { t } = useTranslation()
  const meta = useWatch<AddTaskFormValues, 'torrentMeta'>({
    name: 'torrentMeta',
  })
  if (!meta) return null

  return (
    <div className="flex items-center gap-2 py-1">
      <span className="shrink-0 text-xs text-muted-foreground">
        {t('common.name')}
      </span>
      <span
        className="min-w-0 flex-1 truncate text-sm font-medium text-foreground [direction:rtl] [text-align:left]"
        title={meta.name}
      >
        {meta.name}
      </span>
      <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
        {formatBytes(meta.totalSize)}
      </span>
      <Button
        type="button"
        variant="ghost"
        size="icon"
        onClick={onClear}
        aria-label={t('task.add.clearSelection')}
        className="h-6 w-6"
      >
        <X className="h-3.5 w-3.5" aria-hidden="true" />
      </Button>
    </div>
  )
}
