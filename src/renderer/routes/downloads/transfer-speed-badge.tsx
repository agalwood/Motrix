import { Badge } from '@renderer/components/ui/badge'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@renderer/components/ui/tooltip'
import { useByteFormat } from '@renderer/hooks/use-byte-format'
import { useGlobalStats } from '@renderer/hooks/use-global-stats'
import { cn } from '@renderer/lib/utils'
import { ArrowDown, ArrowUp } from 'lucide-react'
import { useTranslation } from 'react-i18next'

export function TransferSpeedBadge() {
  const { formatSpeed } = useByteFormat()
  const { t } = useTranslation()
  const { stats } = useGlobalStats()
  const rates = [
    {
      key: 'upSpeed',
      icon: ArrowUp,
      speed: stats?.totalUploadSpeed,
    },
    {
      key: 'downSpeed',
      icon: ArrowDown,
      speed: stats?.totalDownloadSpeed,
    },
  ] as const

  return (
    <Badge
      render={<dl />}
      variant="secondary"
      data-slot="downloads-transfer-rates"
      className="gap-0 px-0"
    >
      {rates.map(({ key, icon: Icon, speed }, index) => {
        const label = t(`panel.downloads.stats.${key}`)
        return (
          <Tooltip key={key}>
            <TooltipTrigger
              delay={400}
              render={
                <div
                  className={cn(
                    'relative flex items-center gap-1.5 px-2',
                    index > 0 &&
                      'before:absolute before:inset-y-0.5 before:left-0 before:w-px before:bg-border/70'
                  )}
                />
              }
            >
              <dt className="flex items-center">
                <Icon
                  aria-hidden="true"
                  className="size-3 text-muted-foreground"
                  strokeWidth={1.75}
                />
                <span className="sr-only">{label}</span>
              </dt>
              <dd dir="ltr" className="whitespace-nowrap tabular-nums">
                {speed == null ? '—' : formatSpeed(speed)}
              </dd>
            </TooltipTrigger>
            <TooltipContent side="top" align="start" sideOffset={8}>
              {label}
            </TooltipContent>
          </Tooltip>
        )
      })}
    </Badge>
  )
}
