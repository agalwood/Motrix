import { CircleAlertIcon, ServerIcon, ShieldCheckIcon } from 'lucide-react'
import type * as React from 'react'
import { useId } from 'react'
import { useTranslation } from 'react-i18next'
import type {
  ConnectionState,
  ServerIdentity,
} from '@/background/ConnectionManager'
import type { MotrixServerEndpoint } from '@/background/EndpointConfigStore'
import type {
  RemoteBackendPolicyReplacement,
  RemoteBackendPolicyV1,
} from '@/background/RemoteBackendPolicyStore'
import {
  Alert,
  AlertAction,
  AlertDescription,
  AlertTitle,
} from '@/components/ui/alert'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'

function ServerSecurityTooltip({ secure }: { secure: boolean }) {
  const { t } = useTranslation()
  const description = t(
    secure
      ? 'options.servers.statusTransportSecure'
      : 'options.servers.statusTransportPlain'
  )

  return (
    <Tooltip>
      <TooltipTrigger
        type="button"
        aria-label={description}
        className={cn(
          'inline-flex size-5 shrink-0 items-center justify-center rounded-sm outline-none transition-colors hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50 [&>svg]:size-4',
          secure ? 'text-muted-foreground' : 'text-destructive'
        )}
      >
        {secure ? (
          <ShieldCheckIcon aria-hidden="true" />
        ) : (
          <CircleAlertIcon aria-hidden="true" />
        )}
      </TooltipTrigger>
      <TooltipContent className="max-w-80">
        <p>{description}</p>
      </TooltipContent>
    </Tooltip>
  )
}

interface RemoteServerCardProps {
  server: MotrixServerEndpoint
  serverIdentity: ServerIdentity | null
  connectionState: ConnectionState
  paired: boolean
  policy: RemoteBackendPolicyV1 | null
  busy: boolean
  onPolicyChange: (replacement: RemoteBackendPolicyReplacement) => Promise<void>
}

export function RemoteServerCard({
  server,
  serverIdentity,
  connectionState,
  paired,
  policy,
  busy,
  onPolicyChange,
}: RemoteServerCardProps): React.ReactElement {
  const { t } = useTranslation()
  const remoteDownloadSwitchId = useId()
  const policyReplacement = (
    changes: Partial<RemoteBackendPolicyReplacement>
  ): RemoteBackendPolicyReplacement => ({
    remoteDataBoundaryAcceptedAt: policy?.remoteDataBoundaryAcceptedAt ?? null,
    allowRequestCredentials: policy?.allowRequestCredentials ?? false,
    allowCustomHeaders: policy?.allowCustomHeaders ?? false,
    allowPageContent: false,
    allowServerUrlProbe: false,
    allowServerUrlResolve: false,
    allowAutomaticTakeover: false,
    ...changes,
  })

  return (
    <Alert
      aria-label={t('options.servers.statusTitle')}
      className="gap-y-1 pe-4 has-data-[slot=alert-action]:pe-4"
    >
      <ServerIcon />
      <AlertTitle className={cn('truncate', paired && 'pe-40')}>
        {server.name}
      </AlertTitle>
      {paired && (
        <AlertAction className="top-4 flex items-center gap-2">
          <Label htmlFor={remoteDownloadSwitchId} className="whitespace-nowrap">
            {t('options.pairing.remoteConsentTitle')}
          </Label>
          <Switch
            id={remoteDownloadSwitchId}
            aria-label={t('options.pairing.remoteConsentTitle')}
            checked={policy?.remoteDataBoundaryAcceptedAt != null}
            disabled={
              connectionState !== 'connected' || policy === null || busy
            }
            onCheckedChange={(checked) =>
              void onPolicyChange(
                policyReplacement({
                  remoteDataBoundaryAcceptedAt: checked ? Date.now() : null,
                  ...(!checked
                    ? {
                        allowCustomHeaders: false,
                        allowRequestCredentials: false,
                      }
                    : {}),
                })
              )
            }
          />
        </AlertAction>
      )}
      <AlertDescription className="flex flex-col gap-2 [&_p:not(:last-child)]:mb-0">
        <div className="flex items-center gap-1.5">
          <p className="min-w-0 break-all">
            {t('options.servers.statusAuthority', {
              value: server.url,
            })}
          </p>
          <ServerSecurityTooltip secure={server.url.startsWith('wss://')} />
        </div>
        {serverIdentity !== null && (
          <p className="opacity-70">
            {t('options.servers.statusRuntime', {
              runtime: serverIdentity.runtime,
              name: serverIdentity.name,
              version: serverIdentity.version,
            })}
          </p>
        )}
        {paired && <p>{t('options.pairing.remoteConsentBody')}</p>}
        <p>{t('options.takeover.remoteUnavailable')}</p>
        {paired && connectionState !== 'connected' && (
          <p>{t('options.pairing.remoteConsentOffline')}</p>
        )}
        {policy?.remoteDataBoundaryAcceptedAt != null && (
          <div className="flex flex-col gap-3 pt-1">
            <div className="flex items-start justify-between gap-3">
              <div className="flex flex-col gap-0.5">
                <p className="font-medium text-card-foreground">
                  {t('options.pairing.remoteHeadersLabel')}
                </p>
                <p>{t('options.pairing.remoteHeadersHelp')}</p>
              </div>
              <Switch
                aria-label={t('options.pairing.remoteHeadersLabel')}
                checked={policy.allowCustomHeaders}
                disabled={connectionState !== 'connected' || busy}
                onCheckedChange={(checked) =>
                  void onPolicyChange(
                    policyReplacement({
                      allowCustomHeaders: checked,
                      ...(!checked ? { allowRequestCredentials: false } : {}),
                    })
                  )
                }
              />
            </div>
            <div className="flex items-start justify-between gap-3">
              <div className="flex flex-col gap-0.5">
                <p className="font-medium text-card-foreground">
                  {t('options.pairing.remoteCredentialsLabel')}
                </p>
                <p>{t('options.pairing.remoteCredentialsHelp')}</p>
              </div>
              <Switch
                aria-label={t('options.pairing.remoteCredentialsLabel')}
                checked={policy.allowRequestCredentials}
                disabled={
                  connectionState !== 'connected' ||
                  busy ||
                  !policy.allowCustomHeaders
                }
                onCheckedChange={(checked) =>
                  void onPolicyChange(
                    policyReplacement({
                      allowRequestCredentials: checked,
                    })
                  )
                }
              />
            </div>
          </div>
        )}
      </AlertDescription>
    </Alert>
  )
}
