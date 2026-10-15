import { CircleAlertIcon } from 'lucide-react'
import type * as React from 'react'
import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { LOCAL_ENDPOINT_ID } from '@/background/EndpointConfigStore'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Separator } from '@/components/ui/separator'
import { Spinner } from '@/components/ui/spinner'
import { BackendListSection } from '@/options/integration/BackendListSection'
import { BackendPairingSection } from '@/options/integration/BackendPairingSection'
import { PairingDialog } from '@/options/integration/PairingDialog'
import { RemoteServerCard } from '@/options/integration/RemoteServerCard'
import { ServerEditorDialog } from '@/options/integration/ServerEditorDialog'
import { useIntegrationSettings } from '@/options/integration/useIntegrationSettings'
import { SettingPanel } from '@/options/SettingPanel'
import { supportsBackendConnections } from '@/shared/browserKind'
import type { PairingAction } from '@/shared/pairingNavigation'
import { hasNativeMessagingSupport } from '@/shared/platformCapabilities'

export function IntegrationTab({
  pairingAction = null,
  onPairingActionHandled,
}: {
  pairingAction?: PairingAction | null
  onPairingActionHandled?: () => void
} = {}): React.ReactElement | null {
  const { t } = useTranslation()
  const localBackendAvailable = hasNativeMessagingSupport()
  const [pairDialogOpen, setPairDialogOpen] = useState(false)
  const [pairAfterAdd, setPairAfterAdd] = useState(false)
  const handledAction = useRef<PairingAction | null>(null)
  const {
    config,
    connectionState,
    serverIdentity,
    activeEndpointId,
    activeServer,
    isRemote,
    paired,
    pairingLoading,
    busy,
    remotePolicyBusy,
    remotePolicy,
    error,
    editorOpen,
    setEditorOpen,
    editingServer,
    serverToDelete,
    setServerToDelete,
    openAddServer,
    openEditServer,
    handleEndpointChange,
    handleReconnect,
    handleForget,
    replaceRemotePolicy,
    handleSaveServer,
    handleDeleteServer,
    refreshAfterPairing,
  } = useIntegrationSettings()
  const localBackendUnavailable =
    !localBackendAvailable && activeEndpointId === LOCAL_ENDPOINT_ID
  const selectedEndpointName =
    activeServer?.name ??
    t(
      localBackendAvailable
        ? 'options.endpoint.localName'
        : 'popup.backend.server'
    )

  useEffect(() => {
    if (pairingAction === null) {
      handledAction.current = null
      return
    }
    if (config === null || handledAction.current === pairingAction) return
    handledAction.current = pairingAction
    onPairingActionHandled?.()
    if (pairingAction === 'add-server') {
      setPairAfterAdd(true)
      openAddServer()
    } else if (localBackendAvailable) {
      void handleEndpointChange(LOCAL_ENDPOINT_ID, true)
        .then(() => setPairDialogOpen(true))
        .catch(() => {
          // The integration controller displays the activation error.
        })
    }
  }, [
    pairingAction,
    config,
    localBackendAvailable,
    onPairingActionHandled,
    openAddServer,
    handleEndpointChange,
  ])

  if (!supportsBackendConnections()) return null

  return (
    <>
      <SettingPanel>
        {error !== null && (
          <Alert variant="destructive" className="gap-y-1">
            <CircleAlertIcon />
            <AlertTitle>{t('options.common.saveError')}</AlertTitle>
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}

        <BackendListSection
          config={config}
          localBackendAvailable={localBackendAvailable}
          connectionState={connectionState}
          paired={paired}
          pairingLoading={pairingLoading}
          busy={busy}
          onAdd={openAddServer}
          onEdit={openEditServer}
          onDelete={setServerToDelete}
          onActivate={handleEndpointChange}
        />

        <Separator className="my-5" />

        <BackendPairingSection
          selectedEndpointName={selectedEndpointName}
          localBackendUnavailable={localBackendUnavailable}
          isRemote={isRemote}
          pairingLoading={pairingLoading}
          paired={paired}
          ready={config !== null}
          busy={busy}
          onPair={() => setPairDialogOpen(true)}
          onReconnect={handleReconnect}
          onForget={handleForget}
        >
          {isRemote && activeServer !== null && (
            <RemoteServerCard
              server={activeServer}
              serverIdentity={serverIdentity}
              connectionState={connectionState}
              paired={paired}
              policy={remotePolicy}
              busy={busy || remotePolicyBusy}
              onPolicyChange={replaceRemotePolicy}
            />
          )}
        </BackendPairingSection>
      </SettingPanel>

      <ServerEditorDialog
        open={editorOpen}
        server={editingServer}
        onOpenChange={(open) => {
          setEditorOpen(open)
          if (!open) setPairAfterAdd(false)
        }}
        onSave={async (values) => {
          await handleSaveServer(values, pairAfterAdd)
          if (pairAfterAdd) setPairDialogOpen(true)
        }}
      />

      <PairingDialog
        open={pairDialogOpen}
        remote={isRemote}
        onOpenChange={setPairDialogOpen}
        onPaired={refreshAfterPairing}
      />

      <AlertDialog
        open={serverToDelete !== null}
        onOpenChange={(open) => {
          if (!open) setServerToDelete(null)
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t('options.servers.deleteTitle')}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t(
                serverToDelete?.id === activeEndpointId
                  ? localBackendAvailable
                    ? 'options.servers.deleteActiveDescription'
                    : 'options.servers.deleteActiveServerOnlyDescription'
                  : 'options.servers.deleteDescription',
                { name: serverToDelete?.name ?? '' }
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('options.common.cancel')}</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              disabled={busy}
              onClick={() => void handleDeleteServer()}
            >
              {busy && <Spinner data-icon="inline-start" />}
              {t('options.servers.delete')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}
