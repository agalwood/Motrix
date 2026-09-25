import { ChevronDownIcon } from '@renderer/components/icons'
import { SPEED_LIMIT_MODES } from '@renderer/components/speed-limit-modes'
import { Badge } from '@renderer/components/ui/badge'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@renderer/components/ui/dropdown-menu'
import { toast } from '@renderer/components/ui/toast'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@renderer/components/ui/tooltip'
import { useByteFormat } from '@renderer/hooks/use-byte-format'
import { useSpeedLimitState } from '@renderer/hooks/use-speed-limit-state'
import { saveSettings } from '@renderer/lib/settings-save'
import { cn } from '@renderer/lib/utils'
import type { TurtleState } from '@shared/types/settings'
import { useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Link } from 'react-router'

export function SpeedLimitBadge() {
  const { t } = useTranslation()
  const { formatSpeedLimit } = useByteFormat()
  const state = useSpeedLimitState()
  const [open, setOpen] = useState(false)
  const [pending, setPending] = useState(false)
  const pendingRef = useRef(false)
  const { Icon } =
    SPEED_LIMIT_MODES.find(({ id }) => id === state.turtle) ??
    SPEED_LIMIT_MODES[0]
  const mode = t(`settings.downloads.speedLimit.turtle_${state.turtle}`)
  const description = t('panel.downloads.speedLimit.currentMode', { mode })
  const reduced =
    state.turtle === 'on' ||
    (state.turtle === 'auto' &&
      ['schedule', 'videoApp', 'adaptive'].includes(state.activeReason))
  const formatLimit = (value: number) =>
    value > 0
      ? formatSpeedLimit(value)
      : t('settings.downloads.speedLimit.unlimited')

  const selectMode = async (turtle: TurtleState) => {
    if (pendingRef.current || turtle === state.turtle) return
    pendingRef.current = true
    setPending(true)
    try {
      await saveSettings({
        speedLimit: { turtle },
      })
    } catch {
      toast.add({
        type: 'error',
        title: t('panel.downloads.speedLimit.saveFailed'),
      })
    } finally {
      pendingRef.current = false
      setPending(false)
    }
  }

  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <Tooltip disabled={open}>
        <TooltipTrigger
          delay={400}
          render={
            <DropdownMenuTrigger
              disabled={pending}
              render={
                <Badge
                  render={<button type="button" />}
                  variant="secondary"
                  data-slot="downloads-speed-limit"
                  data-mode={state.turtle}
                  data-reduced={reduced}
                  aria-label={description}
                  aria-busy={pending}
                  className={cn(
                    'app-no-drag gap-1.5 cursor-default select-none transition-colors hover:bg-accent data-popup-open:bg-accent disabled:opacity-50 focus-visible:ring-1 focus-visible:ring-[#7388a3] dark:focus-visible:ring-[#97aac4]',
                    reduced &&
                      'bg-[#e4ebf3] text-[#435775] hover:bg-[#dce5ef] data-popup-open:bg-[#dce5ef] dark:bg-[#303d50] dark:text-[#bfcede] dark:hover:bg-[#3a485c] dark:data-popup-open:bg-[#3a485c]'
                  )}
                />
              }
            />
          }
        >
          <Icon aria-hidden="true" />
          {mode}
          <ChevronDownIcon aria-hidden="true" className="opacity-55" />
        </TooltipTrigger>
        <TooltipContent side="top" align="start" sideOffset={8}>
          <div className="space-y-1">
            <p className="font-medium">{description}</p>
            <p>
              {t('panel.downloads.speedLimit.uploadLimit', {
                speed: formatLimit(state.effective.upload),
              })}
            </p>
            <p>
              {t('panel.downloads.speedLimit.downloadLimit', {
                speed: formatLimit(state.effective.download),
              })}
            </p>
            {state.turtle === 'auto' && state.activeReason !== 'none' && (
              <p>
                {t(`panel.dashboard.speedLimit.reason.${state.activeReason}`)}
              </p>
            )}
          </div>
        </TooltipContent>
      </Tooltip>
      <DropdownMenuContent
        side="top"
        align="start"
        sideOffset={8}
        aria-label={t('panel.downloads.speedLimit.title')}
        data-menu-density="compact"
        className="w-max min-w-36 max-w-[min(16rem,var(--available-width))]"
      >
        <DropdownMenuRadioGroup
          value={state.turtle}
          onValueChange={(value) => {
            const mode = SPEED_LIMIT_MODES.find(({ id }) => id === value)
            if (mode) void selectMode(mode.id)
          }}
        >
          {SPEED_LIMIT_MODES.map(({ id, Icon }) => (
            <DropdownMenuRadioItem
              key={id}
              value={id}
              disabled={pending}
              showIndicator={false}
              closeOnClick
            >
              <Icon className="size-3.5 text-muted-foreground" aria-hidden />
              {t(`panel.dashboard.speedLimit.turtle.${id}`)}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
        <DropdownMenuSeparator />
        <DropdownMenuItem render={<Link to="/settings/downloads" />}>
          {t('panel.dashboard.speedLimit.settings')}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
