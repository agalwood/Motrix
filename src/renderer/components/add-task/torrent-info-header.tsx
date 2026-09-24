import { Button } from '@renderer/components/ui/button'
import { useByteFormat } from '@renderer/hooks/use-byte-format'
import type { AddTaskFormValues } from '@shared/schemas/add-task'
import { X } from 'lucide-react'
import { useWatch } from 'react-hook-form'
import { useTranslation } from 'react-i18next'

interface TorrentInfoHeaderProps {
  onClear: () => void
}

export function TorrentInfoHeader({ onClear }: TorrentInfoHeaderProps) {
  const { formatBytes } = useByteFormat()

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
