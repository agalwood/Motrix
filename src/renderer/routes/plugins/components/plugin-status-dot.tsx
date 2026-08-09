import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@renderer/components/ui/tooltip'
import { cn } from '@renderer/lib/utils'
import type { PluginStatus } from '@shared/types/plugin'
import { useTranslation } from 'react-i18next'

const DOT_COLOR: Record<PluginStatus, string> = {
  active: 'bg-emerald-500',
  inactive: 'bg-amber-500',
  disabled: 'bg-muted-foreground/60',
  error: 'bg-destructive',
}

export function PluginStatusDot({
  status,
  enabled,
}: {
  status: PluginStatus
  enabled: boolean
}) {
  const { t } = useTranslation()
  const effective: PluginStatus = enabled ? status : 'disabled'
  const label = t(`plugins.status.${effective}`)
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <div className="p-[3px] border rounded-full bg-background">
            <span
              aria-hidden
              className={cn('block size-2 rounded-full', DOT_COLOR[effective])}
            />
          </div>
        }
      />
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  )
}
