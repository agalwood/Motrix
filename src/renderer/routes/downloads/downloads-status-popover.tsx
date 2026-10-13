import { ChevronUpIcon, TransferDownIcon } from '@renderer/components/icons'
import { Badge } from '@renderer/components/ui/badge'
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@renderer/components/ui/popover'
import { useByteFormat } from '@renderer/hooks/use-byte-format'
import { useEngineDisplayStatus } from '@renderer/hooks/use-engine-display-status'
import { useGlobalStats } from '@renderer/hooks/use-global-stats'
import { cn } from '@renderer/lib/utils'
import { useTranslation } from 'react-i18next'
import { EngineBadge } from './engine-badge'
import { NatBadge } from './nat-badge'
import { SpeedLimitBadge } from './speed-limit-badge'
import { TransferSpeedBadge } from './transfer-speed-badge'

export function DownloadsStatusPopover() {
  const { t } = useTranslation()
  const { formatSpeed } = useByteFormat()
  const { stats } = useGlobalStats()
  const { state, connection } = useEngineDisplayStatus()
  const title = t('panel.downloads.stats.title')
  const speed = stats?.totalDownloadSpeed

  return (
    <Popover>
      <PopoverTrigger
        render={
          <Badge
            render={<button type="button" />}
            variant="secondary"
            data-slot="downloads-status-trigger"
            aria-label={title}
            title={title}
            className="app-no-drag ms-auto min-w-0 shrink cursor-default gap-1.5 transition-colors hover:bg-accent data-popup-open:bg-accent"
          />
        }
      >
        <span
          aria-hidden="true"
          className={cn(
            'size-1.5 shrink-0 rounded-full',
            state === 'failed'
              ? 'bg-red-500'
              : connection
                ? 'bg-amber-500'
                : state === 'ready'
                  ? 'bg-green-500'
                  : state === 'starting' || state === 'reconnecting'
                    ? 'bg-blue-500'
                    : 'bg-gray-500'
          )}
        />
        <TransferDownIcon
          aria-hidden="true"
          className="text-muted-foreground"
        />
        <span dir="ltr" className="truncate tabular-nums">
          {speed == null ? '—' : formatSpeed(speed)}
        </span>
        <ChevronUpIcon aria-hidden="true" className="opacity-55" />
      </PopoverTrigger>
      <PopoverContent
        aria-label={title}
        side="top"
        align="end"
        sideOffset={8}
        className="@container/downloads-status w-64 max-w-[calc(100vw-2rem)] max-h-(--available-height) space-y-3 overflow-y-auto p-3 data-open:animate-none data-closed:animate-none transition-[opacity,scale] duration-150 ease-out data-starting-style:opacity-0 data-starting-style:scale-95 data-ending-style:opacity-0 data-ending-style:scale-95 motion-reduce:transition-none"
      >
        <p className="text-xs font-medium text-muted-foreground">{title}</p>
        <TransferSpeedBadge expanded />
        <div className="flex flex-wrap items-center justify-between gap-2 border-t pt-3">
          <span className="text-xs text-muted-foreground">
            {t('panel.downloads.speedLimit.title')}
          </span>
          <SpeedLimitBadge />
        </div>
        <div className="flex flex-wrap items-center gap-2 border-t pt-3">
          <NatBadge />
          <EngineBadge />
        </div>
      </PopoverContent>
    </Popover>
  )
}
