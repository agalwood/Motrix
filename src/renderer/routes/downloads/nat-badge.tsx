import { Badge } from '@renderer/components/ui/badge'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@renderer/components/ui/dropdown-menu'
import { useNatStatus } from '@renderer/hooks/use-nat-status'
import {
  isNatRetrying,
  isNatRunning,
  type NatBucket,
  natBucket,
} from '@renderer/lib/nat-status'
import { transport } from '@renderer/lib/transport'
import { cn } from '@renderer/lib/utils'
import { usePlatformServices } from '@renderer/platform/services'
import { getNatTroubleshootingUrl } from '@shared/external-urls'
import { Commands } from '@shared/protocol/commands'
import { useCallback } from 'react'
import { useTranslation } from 'react-i18next'

const TEXT_KEY: Record<NatBucket, string> = {
  active: 'panel.downloads.stats.natActive',
  settingUp: 'panel.downloads.stats.natSettingUp',
  failed: 'panel.downloads.stats.natFailed',
  off: 'panel.downloads.stats.natOff',
}

export function NatBadge() {
  return __MOTRIX_TARGET__ === 'electron' ? <ElectronNatBadge /> : null
}

function ElectronNatBadge() {
  const { t, i18n } = useTranslation()
  const services = usePlatformServices()
  const status = useNatStatus()
  const { bucket, color } = natBucket(status)
  const badgeText = t(TEXT_KEY[bucket])
  const detailText =
    status && isNatRetrying(status)
      ? t('panel.downloads.stats.natRetrying', {
          attempt: status.retryAttempt,
          max: status.maxRetries,
        })
      : badgeText
  const running = isNatRunning(status)

  const handleEnable = useCallback(() => {
    void transport.invoke(Commands.EnableNat)
  }, [])
  const handleDisable = useCallback(() => {
    void transport.invoke(Commands.DisableNat)
  }, [])
  const troubleshootingUrl = getNatTroubleshootingUrl(
    i18n.resolvedLanguage ?? i18n.language
  )
  const handleHelp = useCallback(() => {
    void services.openExternal(troubleshootingUrl)
  }, [services, troubleshootingUrl])

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        nativeButton={false}
        render={
          <Badge
            variant="secondary"
            className="cursor-pointer select-none"
            aria-label={detailText}
          />
        }
      >
        <span className={cn('flex size-2 rounded-full mr-2', color)} />
        {badgeText}
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-[8rem]">
        <DropdownMenuGroup>
          <DropdownMenuLabel className="flex items-center gap-2 text-xs font-normal">
            <span className={cn('size-2 rounded-full', color)} />
            {detailText}
          </DropdownMenuLabel>
          <DropdownMenuSeparator />
          {running ? (
            <DropdownMenuItem onClick={handleDisable}>
              {t('panel.downloads.stats.natDisable')}
            </DropdownMenuItem>
          ) : (
            <DropdownMenuItem onClick={handleEnable}>
              {t('panel.downloads.stats.natEnable')}
            </DropdownMenuItem>
          )}
          {bucket === 'failed' ? (
            <DropdownMenuItem onClick={handleHelp}>
              {t('panel.downloads.stats.natHelp')}
            </DropdownMenuItem>
          ) : null}
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
