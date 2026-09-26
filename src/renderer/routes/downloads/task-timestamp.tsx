import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@renderer/components/ui/tooltip'
import { useMinuteClock } from '@renderer/hooks/use-minute-clock'
import { cn } from '@renderer/lib/utils'
import { useTranslation } from 'react-i18next'
import { formatTaskTimestamp } from './format-task-timestamp'

export function TaskTimestamp({
  timestamp,
  variant = 'list',
  pending = false,
}: {
  timestamp: number | null
  variant?: 'list' | 'inspector'
  pending?: boolean
}) {
  const { t, i18n } = useTranslation()
  const now = useMinuteClock()
  const formatted = formatTaskTimestamp(timestamp, i18n.language, now)
  const detail =
    formatted?.detailed ??
    t(
      pending
        ? 'panel.downloads.timestamp.notCompleted'
        : 'panel.downloads.timestamp.notRecorded'
    )
  const label = !formatted
    ? '—'
    : variant === 'inspector'
      ? formatted.full
      : formatted.relative
        ? t('panel.downloads.timestamp.relativeDateTime', formatted.relative)
        : formatted.compact
  const className = cn(
    'tabular-nums',
    variant === 'list' ? 'block truncate' : 'ms-auto text-end'
  )
  return (
    <Tooltip>
      <TooltipTrigger
        delay={400}
        tabIndex={-1}
        aria-label={detail}
        className={className}
        render={formatted ? <time dateTime={formatted.iso} /> : <span />}
      >
        {label}
      </TooltipTrigger>
      <TooltipContent side="bottom" align="start" sideOffset={8}>
        {detail}
      </TooltipContent>
    </Tooltip>
  )
}
