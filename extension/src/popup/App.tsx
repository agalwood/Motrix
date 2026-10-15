import { Activity, AlertTriangle, ScanSearch } from 'lucide-react'
import {
  memo,
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useState,
} from 'react'
import { useTranslation } from 'react-i18next'
import type { ConnectionState } from '@/background/ConnectionManager'
import { Tabs, TabsContent } from '@/components/ui/tabs'
import { BackendSelector } from '@/popup/BackendSelector'
import {
  CompactPopupHeader,
  PopupBottomNavigation,
  type PopupTab,
} from '@/popup/CompactPopupLayout'
import { ConnectionPanel } from '@/popup/ConnectionPanel'
import { ControlPanel } from '@/popup/ControlPanel'
import { DashboardTile } from '@/popup/DashboardTile'
import { DownloadActivity } from '@/popup/DownloadActivity'
import { DownloadConfirmationDialog } from '@/popup/DownloadConfirmationDialog'
import { DownloadDirectoryConnectionProvider } from '@/popup/DownloadDirectoryConnection'
import { MediaPanel } from '@/popup/MediaPanel'
import { PairingPromptDialog } from '@/popup/PairingPromptDialog'
import { QuickAddTaskDialog } from '@/popup/QuickAddTaskDialog'
import { QuickSettingsPanel } from '@/popup/QuickSettingsPanel'
import { RpcNotice } from '@/popup/RpcNotice'
import { SpeedTile } from '@/popup/SpeedTile'
import { useAutoPopupReceipt } from '@/popup/useAutoPopupReceipt'
import { type TaskControlPanel, useControlPanel } from '@/popup/useControlPanel'
import {
  type PopupEndpoint,
  type PopupState,
  usePopupState,
} from '@/popup/usePopupState'
import {
  type QuickSettingsController,
  useQuickSettings,
} from '@/popup/useQuickSettings'
import { extensionBrowser as browser } from '@/shared/browser'
import { supportsBackendConnections } from '@/shared/browserKind'
import { connectionErrorKey } from '@/shared/errorCopy'
import type { PairingState } from '@/shared/integration'
import { hasNativeMessagingSupport } from '@/shared/platformCapabilities'
import { supportsAutomaticTakeover } from '@/shared/takeoverAvailability'

function CompactConnectionNotice({
  text,
}: {
  text: string
}): React.ReactElement {
  return (
    <div
      role="status"
      className="flex h-8 items-center gap-2 border-b border-amber-500/20 bg-amber-500/[0.07] px-3 text-[10px]/4"
    >
      <AlertTriangle
        className="size-3.5 shrink-0 text-amber-600"
        aria-hidden="true"
      />
      <span className="truncate">{text}</span>
    </div>
  )
}

const PopupHeaderSection = memo(function PopupHeaderSection({
  connection,
  pairing,
  attention,
  checking,
  endpoint,
  switching,
  takeoverChecked,
  takeoverDisabled,
  takeoverSupported,
  onEndpointChange,
  onTakeoverChange,
  onOpenSettings,
}: {
  connection: ConnectionState | null
  pairing: PairingState
  attention: boolean
  checking: boolean
  endpoint: PopupEndpoint | null
  switching: boolean
  takeoverChecked: boolean
  takeoverDisabled: boolean
  takeoverSupported: boolean
  onEndpointChange: (endpointId: string) => void
  onTakeoverChange: (checked: boolean) => void
  onOpenSettings: () => void
}): React.ReactElement {
  return (
    <CompactPopupHeader
      backend={
        supportsBackendConnections() ? (
          <BackendSelector
            connection={connection}
            pairing={pairing}
            attention={attention}
            checking={checking}
            endpoint={endpoint}
            busy={switching}
            onEndpointChange={onEndpointChange}
            onConfigureServer={onOpenSettings}
          />
        ) : (
          <span className="text-sm font-semibold">Motrix Extension</span>
        )
      }
      takeoverChecked={takeoverChecked}
      takeoverDisabled={takeoverDisabled}
      takeoverSupported={takeoverSupported}
      onTakeoverChange={onTakeoverChange}
      onOpenSettings={onOpenSettings}
    />
  )
})

const PopupDashboard = memo(function PopupDashboard({
  uploadSpeed,
  downloadSpeed,
  activeTaskCount,
  resourceCount,
  onShowTasks,
  onShowResources,
}: {
  uploadSpeed: number | null
  downloadSpeed: number | null
  activeTaskCount: number | null
  resourceCount: number
  onShowTasks: () => void
  onShowResources: () => void
}): React.ReactElement {
  const { t } = useTranslation()
  return (
    <section
      data-testid="dashboard-tiles"
      aria-label={t('popup.dashboard.title')}
      className="mt-4 grid min-h-20 shrink-0 grid-cols-4 grid-rows-[auto_auto_1fr] gap-x-4 gap-y-2"
    >
      <SpeedTile
        kind="upload"
        label={t('popup.speed.upload')}
        bytesPerSecond={uploadSpeed}
      />
      <SpeedTile
        kind="download"
        label={t('popup.speed.download')}
        bytesPerSecond={downloadSpeed}
      />
      <DashboardTile
        testId="tile-activity"
        label={t('popup.dashboard.activity')}
        value={activeTaskCount ?? '—'}
        icon={Activity}
        iconClassName="text-connection-online"
        ariaLabel={t('popup.dashboard.showTasks')}
        onClick={onShowTasks}
      />
      <DashboardTile
        testId="tile-resources"
        label={t('popup.dashboard.resources')}
        value={resourceCount}
        icon={ScanSearch}
        iconClassName="text-speed-download"
        ariaLabel={t('popup.dashboard.showResources')}
        onClick={onShowResources}
      />
    </section>
  )
})

const PopupContent = memo(function PopupContent({
  tab,
  onTabChange,
  connected,
  state,
  statusState,
  taskController,
  notice,
  needsServer,
  onReconnect,
  onOpenOptions,
  onShowPairing,
  backendKey,
  onMediaCountChange,
  quickSettings,
}: {
  tab: PopupTab
  onTabChange: (tab: PopupTab) => void
  connected: boolean
  state: PopupState
  statusState: PopupState
  taskController: TaskControlPanel
  notice: ReactNode
  needsServer: boolean
  onReconnect: () => void
  onOpenOptions: () => void
  onShowPairing: () => void
  backendKey: string
  onMediaCountChange: (count: number) => void
  quickSettings: QuickSettingsController
}): React.ReactElement {
  const { t } = useTranslation()
  const [quickAddOpen, setQuickAddOpen] = useState(false)
  return (
    <>
      <Tabs
        value={tab}
        onValueChange={(value) => onTabChange(value as PopupTab)}
        className="mt-4 min-h-0 flex-1 gap-0"
      >
        <TabsContent
          value="tasks"
          className={`min-h-0 min-w-0 overflow-x-hidden ${(connected || state.rpc?.health === 'checking' || state.rpc?.health === 'unresponsive') && !state.loading ? 'overflow-y-auto' : 'overflow-y-hidden'}`}
        >
          {!supportsBackendConnections() ? null : (connected ||
              state.rpc?.health === 'checking' ||
              state.rpc?.health === 'unresponsive') &&
            !state.loading ? (
            <ControlPanel
              connection="connected"
              readOnly={
                state.rpc?.health === 'checking' ||
                state.rpc?.health === 'unresponsive'
              }
              controller={taskController}
              canRevealTask={state.capabilities.taskReveal}
              canOpenApp={state.endpoint?.activeEndpointId === 'local'}
              onReconnect={onReconnect}
              notice={notice}
              onNewTask={() => setQuickAddOpen(true)}
            />
          ) : (
            <ConnectionPanel
              title={t('popup.tasks.title')}
              state={statusState}
              {...(!needsServer &&
              (state.pairing === 'stored' || state.pairing === 'none')
                ? { onNewTask: () => setQuickAddOpen(true) }
                : {})}
              onReconnect={needsServer ? onOpenOptions : onReconnect}
              {...(needsServer
                ? { actionLabel: t('popup.backend.configureServer') }
                : { onShowPairing })}
            />
          )}
        </TabsContent>
        <TabsContent
          value="sniffer"
          keepMounted
          className="min-h-0 min-w-0 overflow-x-hidden overflow-y-auto"
        >
          <MediaPanel
            active={tab === 'sniffer'}
            connected={
              connected &&
              !state.loading &&
              state.rpc?.health !== 'checking' &&
              state.rpc?.health !== 'unresponsive'
            }
            pairing={
              supportsBackendConnections() ? state.pairing : 'unavailable'
            }
            submissionKey={backendKey}
            onMediaCountChange={onMediaCountChange}
          />
        </TabsContent>
        <TabsContent
          value="settings"
          className="min-h-0 min-w-0 overflow-x-hidden overflow-y-auto"
        >
          <QuickSettingsPanel
            controller={quickSettings}
            onOpenFullSettings={onOpenOptions}
            className="mt-0"
          />
        </TabsContent>
        {supportsBackendConnections() && <PopupBottomNavigation />}
      </Tabs>
      <QuickAddTaskDialog
        open={quickAddOpen}
        onOpenChange={setQuickAddOpen}
        pairIfNeeded={state.pairing === 'none'}
        onCreated={async () => {
          onTabChange('tasks')
          await taskController.refresh()
        }}
      />
    </>
  )
})

export function App(): React.ReactElement {
  const { t } = useTranslation()
  const { state, switching, reconnect, switchEndpoint, submitPairingCode } =
    usePopupState()
  const quickSettings = useQuickSettings(
    !switching && supportsAutomaticTakeover(state.endpoint)
  )
  const [tab, setTab] = useState<PopupTab>(
    supportsBackendConnections() ? 'tasks' : 'sniffer'
  )
  const [resourceCount, setResourceCount] = useState(0)
  const [endpointError, setEndpointError] = useState<string | null>(null)
  const [pairingCodeError, setPairingCodeError] = useState<string | null>(null)
  const [submittingCode, setSubmittingCode] = useState(false)
  const [dismissedPairingDeadlineMs, setDismissedPairingDeadlineMs] = useState<
    number | null
  >(null)
  const connected =
    supportsBackendConnections() && state.connection === 'connected'
  const rpcPaused =
    state.rpc?.health === 'checking' || state.rpc?.health === 'unresponsive'
  const needsServer =
    !hasNativeMessagingSupport() &&
    (state.endpoint?.activeEndpointId ?? 'local') === 'local'
  const statusState = useMemo(
    () =>
      endpointError === null
        ? state
        : { ...state, lastError: endpointError, lastErrorReason: null },
    [endpointError, state]
  )
  const backendId = state.endpoint?.activeEndpointId ?? 'unresolved'
  const backendRevision =
    state.endpoint?.servers.find((server) => server.id === backendId)
      ?.revision ?? 0
  const backendKey = `${backendId}:${backendRevision}`
  const controller = useControlPanel(
    connected || rpcPaused,
    backendKey,
    rpcPaused
  )
  const autoReceipt = useAutoPopupReceipt(
    backendId,
    backendRevision,
    controller.refresh
  )
  const taskController = useMemo<TaskControlPanel>(
    () => ({
      tasks: controller.tasks,
      loading: controller.loading,
      error: controller.error,
      refresh: controller.refresh,
      pause: controller.pause,
      resume: controller.resume,
      reveal: controller.reveal,
      remove: controller.remove,
    }),
    [
      controller.error,
      controller.loading,
      controller.pause,
      controller.refresh,
      controller.remove,
      controller.resume,
      controller.reveal,
      controller.tasks,
    ]
  )
  const activeTaskCount =
    (connected || rpcPaused) && controller.stats !== null
      ? controller.stats.activeTasks + controller.stats.waitingTasks
      : null

  const openOptions = useCallback((): void => {
    void browser.runtime.openOptionsPage()
  }, [])

  const changeEndpoint = useCallback(
    async (endpointId: string): Promise<void> => {
      setEndpointError(null)
      try {
        await switchEndpoint(endpointId)
      } catch (error) {
        setEndpointError((error as Error).message)
      }
    },
    [switchEndpoint]
  )

  const handleSubmitCode = useCallback(
    async (code: string): Promise<void> => {
      setPairingCodeError(null)
      setSubmittingCode(true)
      try {
        await submitPairingCode(code)
      } catch {
        // Bus errors are developer-facing English; people see locale copy.
        setPairingCodeError(t('errors.connection.generic'))
      } finally {
        setSubmittingCode(false)
      }
    },
    [submitPairingCode, t]
  )

  useEffect(() => {
    if (
      quickSettings.pairingRequired ||
      quickSettings.consentRequired ||
      quickSettings.error?.operation === 'save'
    )
      setTab('settings')
  }, [
    quickSettings.pairingRequired,
    quickSettings.consentRequired,
    quickSettings.error?.operation,
  ])

  const handleTakeoverChange = useCallback(
    (checked: boolean): void => {
      void quickSettings.requestTakeoverEnabled(checked)
    },
    [quickSettings.requestTakeoverEnabled]
  )

  const connectedNotice = useMemo(
    () =>
      state.degraded ? (
        <CompactConnectionNotice text={t('popup.pairing.degradedBody')} />
      ) : statusState.lastError !== null ? (
        <CompactConnectionNotice
          text={t(connectionErrorKey(statusState.lastErrorReason))}
        />
      ) : undefined,
    [state.degraded, statusState.lastError, statusState.lastErrorReason, t]
  )
  const reconnectPopup = useCallback(() => void reconnect(), [reconnect])
  const showPairing = useCallback(() => setDismissedPairingDeadlineMs(null), [])
  const showTasks = useCallback(() => setTab('tasks'), [])
  const showResources = useCallback(() => setTab('sniffer'), [])
  const changeTab = useCallback((nextTab: PopupTab) => setTab(nextTab), [])
  const pairingPrompt =
    state.pairingCode !== null &&
    dismissedPairingDeadlineMs !== state.pairingCode.deadlineMs
      ? state.pairingCode
      : null

  return (
    <DownloadDirectoryConnectionProvider state={state}>
      <main
        data-testid="compact-popup"
        className="box-border flex h-[600px] w-[400px] max-w-[100dvw] flex-col overflow-hidden bg-background p-4 font-sans text-foreground"
      >
        <PopupHeaderSection
          connection={state.loading ? 'connecting' : state.connection}
          pairing={state.pairing}
          attention={
            !!state.rpc?.lastError ||
            state.rpc?.health === 'unresponsive' ||
            (state.lastError !== null &&
              state.attemptIntent !== 'background-probe')
          }
          checking={state.rpc?.health === 'checking'}
          endpoint={state.endpoint}
          switching={switching || !supportsBackendConnections()}
          takeoverChecked={
            quickSettings.takeoverSupported &&
            (quickSettings.takeover?.enabled ?? false)
          }
          takeoverDisabled={
            quickSettings.loading ||
            quickSettings.saving ||
            !quickSettings.takeoverSupported
          }
          takeoverSupported={quickSettings.takeoverSupported}
          onEndpointChange={changeEndpoint}
          onTakeoverChange={handleTakeoverChange}
          onOpenSettings={openOptions}
        />

        {supportsBackendConnections() && (
          <PopupDashboard
            uploadSpeed={
              connected || rpcPaused
                ? (controller.stats?.totalUploadSpeed ?? null)
                : null
            }
            downloadSpeed={
              connected || rpcPaused
                ? (controller.stats?.totalDownloadSpeed ?? null)
                : null
            }
            activeTaskCount={activeTaskCount}
            resourceCount={resourceCount}
            onShowTasks={showTasks}
            onShowResources={showResources}
          />
        )}

        {supportsBackendConnections() && state.endpoint && (
          <DownloadActivity
            key={backendKey}
            endpointId={backendId}
            endpointRevision={backendRevision}
            phase={state.phase}
            onViewTasks={() => {
              setTab('tasks')
              if (!connected) reconnectPopup()
            }}
          />
        )}

        {supportsBackendConnections() && autoReceipt && (
          <p
            role="status"
            className="mt-2 shrink-0 text-xs text-muted-foreground"
          >
            {t('popup.rpc.added', { count: autoReceipt.count })}
          </p>
        )}
        {supportsBackendConnections() && (
          <RpcNotice state={state} onReconnect={reconnectPopup} />
        )}
        <PopupContent
          tab={tab}
          onTabChange={changeTab}
          connected={connected}
          state={state}
          statusState={statusState}
          taskController={taskController}
          notice={connectedNotice}
          needsServer={needsServer}
          onReconnect={reconnectPopup}
          onOpenOptions={openOptions}
          onShowPairing={showPairing}
          backendKey={backendKey}
          onMediaCountChange={setResourceCount}
          quickSettings={quickSettings}
        />

        {supportsBackendConnections() && <DownloadConfirmationDialog />}
        {supportsBackendConnections() && pairingPrompt && (
          <PairingPromptDialog
            prompt={pairingPrompt}
            error={pairingCodeError}
            submitting={submittingCode}
            onSubmit={(code) => void handleSubmitCode(code)}
            onDismiss={() =>
              setDismissedPairingDeadlineMs(pairingPrompt.deadlineMs)
            }
          />
        )}
      </main>
    </DownloadDirectoryConnectionProvider>
  )
}
