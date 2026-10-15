import {
  LaptopIcon,
  PencilIcon,
  PlusIcon,
  ServerIcon,
  Trash2Icon,
} from 'lucide-react'
import type * as React from 'react'
import { useTranslation } from 'react-i18next'
import type { ConnectionState } from '@/background/ConnectionManager'
import {
  type EndpointConfig,
  LOCAL_ENDPOINT_ID,
  type MotrixServerEndpoint,
} from '@/background/EndpointConfigStore'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemMedia,
  ItemTitle,
} from '@/components/ui/item'
import { SettingSection } from '@/options/components/SettingSection'

interface BackendListSectionProps {
  config: EndpointConfig | null
  localBackendAvailable: boolean
  connectionState: ConnectionState
  paired: boolean
  pairingLoading: boolean
  busy: boolean
  onAdd: () => void
  onEdit: (server: MotrixServerEndpoint) => void
  onDelete: (server: MotrixServerEndpoint) => void
  onActivate: (endpointId: string) => Promise<void>
}

export function BackendListSection({
  config,
  localBackendAvailable,
  connectionState,
  paired,
  pairingLoading,
  busy,
  onAdd,
  onEdit,
  onDelete,
  onActivate,
}: BackendListSectionProps): React.ReactElement {
  const { t } = useTranslation()
  const activeEndpointId = config?.activeEndpointId ?? LOCAL_ENDPOINT_ID
  const backendRows: Array<{
    id: string
    name: string
    description: string
    server: MotrixServerEndpoint | null
  }> = [
    ...(localBackendAvailable
      ? [
          {
            id: LOCAL_ENDPOINT_ID,
            name: t('options.endpoint.localName'),
            description: t('options.endpoint.localDescription'),
            server: null,
          },
        ]
      : []),
    ...(config?.servers ?? []).map((server) => ({
      id: server.id,
      name: server.name,
      description: server.url,
      server,
    })),
  ]

  return (
    <SettingSection
      title={t('options.endpoint.currentTitle')}
      description={t('options.endpoint.currentDescription')}
      action={
        <Button
          type="button"
          size="sm"
          disabled={config === null || busy}
          onClick={onAdd}
        >
          <PlusIcon data-icon="inline-start" />
          {t('options.servers.add')}
        </Button>
      }
    >
      <ItemGroup aria-label={t('options.endpoint.listLabel')}>
        {backendRows.map((backend) => {
          const current = backend.id === activeEndpointId
          const server = backend.server
          return (
            <Item
              key={backend.id}
              role="listitem"
              variant={current ? 'muted' : 'outline'}
              size="sm"
              aria-current={current ? 'true' : undefined}
            >
              <ItemMedia variant="icon">
                {backend.server === null ? <LaptopIcon /> : <ServerIcon />}
              </ItemMedia>
              <ItemContent className="min-w-0">
                <ItemTitle>{backend.name}</ItemTitle>
                <ItemDescription title={backend.description}>
                  {backend.description}
                </ItemDescription>
              </ItemContent>
              <ItemActions className="ms-auto max-w-full flex-wrap justify-end">
                {current ? (
                  <>
                    <Badge variant="secondary">
                      {t('options.servers.current')}
                    </Badge>
                    <Badge
                      variant={
                        connectionState === 'connected' ? 'default' : 'outline'
                      }
                    >
                      {t(`options.endpoint.connection.${connectionState}`)}
                    </Badge>
                    <Badge variant={paired ? 'secondary' : 'outline'}>
                      {pairingLoading
                        ? t('options.pairing.loading')
                        : paired
                          ? t('options.pairing.paired')
                          : t('options.pairing.notPaired')}
                    </Badge>
                  </>
                ) : (
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    disabled={config === null || busy}
                    aria-label={t('options.endpoint.activateAria', {
                      name: backend.name,
                    })}
                    onClick={() => void onActivate(backend.id)}
                  >
                    {t('options.endpoint.activate')}
                  </Button>
                )}
                {server !== null && (
                  <>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-sm"
                      disabled={busy}
                      aria-label={t('options.servers.editAria', {
                        name: server.name,
                      })}
                      onClick={() => onEdit(server)}
                    >
                      <PencilIcon />
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-sm"
                      disabled={busy}
                      aria-label={t('options.servers.deleteAria', {
                        name: server.name,
                      })}
                      onClick={() => onDelete(server)}
                    >
                      <Trash2Icon />
                    </Button>
                  </>
                )}
              </ItemActions>
            </Item>
          )
        })}
      </ItemGroup>

      {config !== null && config.servers.length === 0 && (
        <Alert className="gap-y-1">
          <ServerIcon />
          <AlertTitle>{t('options.servers.emptyTitle')}</AlertTitle>
          <AlertDescription>
            {t('options.servers.emptyDescription')}
          </AlertDescription>
        </Alert>
      )}
    </SettingSection>
  )
}
