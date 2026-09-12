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
import { Spinner } from '@renderer/components/ui/spinner'
import { useNatStatus } from '@renderer/hooks/use-nat-status'
import { type NatBucket, natBucket } from '@renderer/lib/nat-status'
import { transport } from '@renderer/lib/transport'
import { cn } from '@renderer/lib/utils'
import { usePlatformServices } from '@renderer/platform/services'
import { getNatTroubleshootingUrl } from '@shared/external-urls'
import { Commands } from '@shared/protocol/commands'
import { useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { Link } from 'react-router'

const TEXT_KEY: Record<NatBucket, string> = {
  active: 'panel.downloads.stats.natActive',
  settingUp: 'panel.downloads.stats.natSettingUp',
  failed: 'panel.downloads.stats.natMapping',
  off: 'panel.downloads.stats.natMapping',
}

export function NatBadge() {
  return __MOTRIX_TARGET__ === 'electron' ? <ElectronNatBadge /> : null
}

function ElectronNatBadge() {
  const { t, i18n } = useTranslation()
  const services = usePlatformServices()
  const status = useNatStatus()
  const { bucket } = natBucket(status)
  const color = bucket === 'active' ? 'bg-green-500' : 'bg-muted-foreground'
  const badgeText = t(TEXT_KEY[bucket])
  const detailText =
    bucket === 'failed' ? t('panel.downloads.stats.natUnavailable') : badgeText

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

  if (!status?.enabled || bucket === 'off') return null

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        nativeButton={false}
        render={
          <Badge
            variant="secondary"
            className="cursor-pointer select-none"
            aria-label={badgeText}
          />
        }
      >
        {bucket === 'settingUp' ? (
          <Spinner
            aria-hidden="true"
            className="mr-1.5 size-3 text-muted-foreground motion-reduce:animate-none"
          />
        ) : (
          <span
            aria-hidden="true"
            className={cn('size-2 rounded-full mr-2', color)}
          />
        )}
        {badgeText}
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        className="w-60 max-w-[calc(100vw-2rem)]"
      >
        <DropdownMenuGroup>
          <DropdownMenuLabel className="space-y-1 whitespace-normal text-xs font-normal">
            <p className="font-medium text-foreground">{detailText}</p>
            {bucket === 'active' || bucket === 'failed' ? (
              <p className="leading-relaxed text-muted-foreground">
                {t(
                  bucket === 'active'
                    ? 'panel.downloads.stats.natActiveDesc'
                    : 'panel.downloads.stats.natUnavailableDesc'
                )}
              </p>
            ) : null}
            {status.retryAttempt > 0 ? (
              <p className="text-muted-foreground">
                {t('panel.downloads.stats.natRetrying', {
                  attempt: status.retryAttempt,
                  max: status.maxRetries,
                })}
              </p>
            ) : null}
          </DropdownMenuLabel>
          <DropdownMenuSeparator />
          {bucket === 'failed' ? (
            <DropdownMenuItem onClick={handleEnable}>
              {t('panel.downloads.stats.natRetry')}
            </DropdownMenuItem>
          ) : null}
          <DropdownMenuItem render={<Link to="/settings/network" />}>
            {t('panel.downloads.stats.natSettings')}
          </DropdownMenuItem>
          <DropdownMenuItem onClick={handleHelp}>
            {t('panel.downloads.stats.natHelp')}
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem onClick={handleDisable}>
            {t('panel.downloads.stats.natDisable')}
          </DropdownMenuItem>
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
