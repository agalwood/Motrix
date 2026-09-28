import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
} from '@renderer/components/ui/dropdown-menu'
import { Spinner } from '@renderer/components/ui/spinner'
import { toast } from '@renderer/components/ui/toast'
import { NAT_STATUS_TEXT_KEY, natBucket } from '@renderer/lib/nat-status'
import { transport } from '@renderer/lib/transport'
import { cn } from '@renderer/lib/utils'
import { usePlatformServices } from '@renderer/platform/services'
import { ErrorCode } from '@shared/errors'
import { getNatTroubleshootingUrl } from '@shared/external-urls'
import { Commands } from '@shared/protocol/commands'
import type { NatStatus } from '@shared/types/nat'
import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { Link } from 'react-router'

export function NatStatusIndicator({
  status,
  className,
}: {
  status: NatStatus | null
  className?: string
}) {
  const { bucket, color } = natBucket(status)
  return bucket === 'settingUp' ? (
    <Spinner
      data-slot="nat-status-indicator"
      data-bucket={bucket}
      aria-hidden="true"
      className={cn(
        'size-3 shrink-0 text-muted-foreground motion-reduce:animate-none',
        className
      )}
    />
  ) : (
    <span
      data-slot="nat-status-indicator"
      data-bucket={bucket}
      aria-hidden="true"
      className={cn('size-2 shrink-0 rounded-full', color, className)}
    />
  )
}

/** Both NAT surfaces use the same status explanation and explicit commands. */
export function NatStatusMenu({
  status,
  children,
}: {
  status: NatStatus | null
  children: ReactNode
}) {
  const { t, i18n } = useTranslation()
  const services = usePlatformServices()
  const { bucket } = natBucket(status)
  const detailText = t(
    bucket === 'failed'
      ? 'panel.downloads.stats.natUnavailable'
      : NAT_STATUS_TEXT_KEY[bucket]
  )

  async function runCommand(
    channel: typeof Commands.EnableNat | typeof Commands.DisableNat
  ) {
    const result = (await transport.invoke(channel)) as
      | { ok?: boolean; error?: string }
      | undefined
    if (result?.ok === false && result.error === ErrorCode.IpcRateLimited) {
      toast.add({ title: t('panel.dashboard.nat.rateLimited'), type: 'error' })
    }
  }

  return (
    <DropdownMenu>
      {children}
      <DropdownMenuContent
        align="end"
        className="w-52 max-w-[calc(100vw-2rem)]"
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
            {status?.enabled && bucket !== 'off' && status.retryAttempt > 0 ? (
              <p className="text-muted-foreground">
                {t('panel.downloads.stats.natRetrying', {
                  attempt: status.retryAttempt,
                  max: status.maxRetries,
                })}
              </p>
            ) : null}
          </DropdownMenuLabel>
          <DropdownMenuSeparator />
          {status && (bucket === 'failed' || bucket === 'off') ? (
            <DropdownMenuItem
              onClick={() => void runCommand(Commands.EnableNat)}
            >
              {t(
                bucket === 'failed'
                  ? 'panel.downloads.stats.natRetry'
                  : 'panel.dashboard.nat.actions.enable'
              )}
            </DropdownMenuItem>
          ) : null}
          <DropdownMenuItem render={<Link to="/settings/network" />}>
            {t('panel.downloads.stats.natSettings')}
          </DropdownMenuItem>
          <DropdownMenuItem
            onClick={() =>
              void services.openExternal(
                getNatTroubleshootingUrl(i18n.resolvedLanguage ?? i18n.language)
              )
            }
          >
            {t('panel.downloads.stats.natHelp')}
          </DropdownMenuItem>
          {status?.enabled ? (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                onClick={() => void runCommand(Commands.DisableNat)}
              >
                {t('panel.downloads.stats.natDisable')}
              </DropdownMenuItem>
            </>
          ) : null}
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
