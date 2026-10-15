import { ChevronDown, Laptop, Server, Settings2 } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { ConnectionState } from '@/background/ConnectionManager'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { cn } from '@/lib/utils'
import { LOCAL_ENDPOINT_ID, type PopupEndpoint } from '@/popup/usePopupState'
import type { PairingState } from '@/shared/integration'
import { hasNativeMessagingSupport } from '@/shared/platformCapabilities'

interface BackendSelectorProps {
  connection: ConnectionState | null
  endpoint: PopupEndpoint | null
  pairing?: PairingState
  attention?: boolean
  checking?: boolean
  busy: boolean
  onEndpointChange: (endpointId: string) => void
  onConfigureServer: () => void
}

const PENDING_STATES = new Set<ConnectionState>([
  'bootstrapping',
  'connecting',
  'handshaking',
  'awaiting-code',
])

function statusClass(
  connection: ConnectionState | null,
  pairing: PairingState,
  attention: boolean,
  checking: boolean
): string {
  if (checking) return 'bg-connection-pending animate-pulse'
  if (attention) return 'bg-connection-offline'
  if (connection === 'connected') return 'bg-connection-online'
  if (connection && PENDING_STATES.has(connection)) {
    return 'bg-connection-pending animate-pulse'
  }
  if (connection === 'denied' || pairing === 'unavailable' || attention)
    return 'bg-connection-offline'
  return pairing === 'stored'
    ? 'bg-connection-paired'
    : 'bg-muted-foreground/50'
}

export function BackendSelector({
  connection,
  pairing = 'loading',
  attention = false,
  checking = false,
  endpoint,
  busy,
  onEndpointChange,
  onConfigureServer,
}: BackendSelectorProps): React.ReactElement {
  const { t } = useTranslation()
  const localBackendAvailable = hasNativeMessagingSupport()
  const activeEndpointId = endpoint?.activeEndpointId ?? LOCAL_ENDPOINT_ID
  const activeServer = endpoint?.servers.find(
    (candidate) => candidate.id === activeEndpointId
  )
  const backendName =
    activeServer?.name ??
    t(localBackendAvailable ? 'popup.backend.app' : 'popup.backend.server')
  const statusLabel = t(
    checking
      ? 'popup.rpc.checking'
      : attention
        ? 'errors.connection.generic'
        : pairing === 'unavailable'
          ? 'popup.integration.pairingUnavailable'
          : connection === 'disconnected' && pairing === 'stored'
            ? 'popup.integration.pairedStatus'
            : connection === 'disconnected' && pairing === 'none'
              ? 'options.pairing.notPaired'
              : `popup.status.${connection ?? 'disconnected'}`
  )

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-8 w-full min-w-0 justify-start gap-2 rounded-[8px] px-2.5 text-sm shadow-xs"
            title={`${backendName} · ${statusLabel}`}
            aria-label={`${t('popup.backend.choose')}: ${backendName}, ${statusLabel}`}
            disabled={busy}
          />
        }
      >
        <span
          aria-hidden="true"
          className={cn(
            'size-2 shrink-0 rounded-full',
            statusClass(connection, pairing, attention, checking)
          )}
        />
        <span className="min-w-0 flex-1 truncate text-start font-normal">
          {backendName}
        </span>
        <ChevronDown
          className="size-4 text-muted-foreground"
          data-icon="inline-end"
          aria-hidden="true"
        />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="min-w-60">
        <DropdownMenuRadioGroup
          value={activeEndpointId}
          onValueChange={onEndpointChange}
        >
          <DropdownMenuLabel>{t('popup.backend.choose')}</DropdownMenuLabel>
          {localBackendAvailable && (
            <DropdownMenuRadioItem value={LOCAL_ENDPOINT_ID}>
              <Laptop aria-hidden="true" />
              <span className="flex min-w-0 flex-1 flex-col">
                <span>{t('popup.backend.app')}</span>
                <span className="truncate text-xs text-muted-foreground">
                  {t('popup.backend.appDescription')}
                </span>
              </span>
            </DropdownMenuRadioItem>
          )}
          {endpoint?.servers.map((configuredServer) => (
            <DropdownMenuRadioItem
              key={configuredServer.id}
              value={configuredServer.id}
            >
              <Server aria-hidden="true" />
              <span className="flex min-w-0 flex-1 flex-col">
                <span>{configuredServer.name}</span>
                <span className="truncate text-xs text-muted-foreground">
                  {configuredServer.url}
                </span>
              </span>
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
        <DropdownMenuSeparator />
        <DropdownMenuGroup>
          <DropdownMenuItem onClick={onConfigureServer}>
            <Settings2 aria-hidden="true" />
            {t('popup.backend.configureServer')}
          </DropdownMenuItem>
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
