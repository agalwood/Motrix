import { mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import { TaskActivityService, TaskActivityStore } from '@core/activity'
import { Aria2SegmentClient } from '@core/download/aria2-segment-client'
import { Aria2Adapter } from '@core/engine/aria2/aria2-adapter'
import { Aria2ConfigBuilder } from '@core/engine/aria2/aria2-config-builder'
import { Aria2ProcessManager } from '@core/engine/aria2/aria2-process-manager'
import { Aria2RpcClient } from '@core/engine/aria2/aria2-rpc-client'
import { Aria2TrustStore } from '@core/engine/aria2/aria2-trust-store'
import type { DnsFallbackConsumer } from '@core/engine/aria2/dns-fallback'
import { createDnsFallbackConsumer } from '@core/engine/aria2/dns-fallback'
import { JsonRpcProtocol } from '@core/engine/aria2/json-rpc-protocol'
import {
  PollingScheduler,
  type PollingTaskUpdateSource,
} from '@core/engine/aria2/polling-scheduler'
import { translateRawToTask } from '@core/engine/aria2/translate'
import type { Aria2RawStatus } from '@core/engine/aria2/types'
import { WebSocketTransport } from '@core/engine/aria2/web-socket-transport'
import {
  ENGINE_READY_TIMEOUT_MS,
  EngineSupervisor,
} from '@core/engine/engine-supervisor'
import { EventBus } from '@core/events/event-bus'
import { locateFfmpeg } from '@core/ffmpeg/ffmpeg-locator'
import { pathExists } from '@core/fs/path-exists'
import { GeoIPManager } from '@core/geoip/geo-ip-manager'
import { LocaleCoordinator } from '@core/i18n/locale-coordinator'
import {
  createTaskInspectorActivityQuery,
  type RuntimeTransitionInput,
  TaskInspectorActivityRuntime,
  TaskInspectorActivityStore,
  taskInspectorActivityEnvironment,
} from '@core/inspector-activity'
import { newTaskId } from '@core/lib/ids'
import { getLogger } from '@core/logger'
import { registerEngineCompatibilitySubscriber } from '@core/notifications/engine-compatibility-subscriber'
import { registerEngineFailureSubscriber } from '@core/notifications/engine-failure-subscriber'
import { NotificationCenter } from '@core/notifications/notification-center'
import { createNotificationOccurrenceConsumer } from '@core/notifications/occurrence-consumer'
import { wireCommandSystem } from '@core/plugin/commands/wire'
import { GrantsManager } from '@core/plugin/grants/grants-manager'
import { ActivationDispatcher } from '@core/plugin/host/activation-dispatcher'
import {
  PluginHost,
  parsePluginIdleDisposeMs,
} from '@core/plugin/host/plugin-host'
import { PluginInstaller } from '@core/plugin/install/plugin-installer'
import { PluginRegistry } from '@core/plugin/plugin-registry'
import { RegistryClient } from '@core/plugin/registry/registry-client'
import { PluginStateStore } from '@core/plugin/state/plugin-state-store'
import { BuiltinUpdater } from '@core/plugin/update/builtin-updater'
import { AppliedDownloadProxyPolicy } from '@core/proxy/applied-download-proxy-policy'
import { ProxyBridgeManager } from '@core/proxy/proxy-bridge-manager'
import { MotrixDatabase } from '@core/session/motrix-database'
import { SessionManager } from '@core/session/session-manager'
import { SettingsManager } from '@core/settings/settings-manager'
import { SpeedLimitController } from '@core/speed-limit/speed-limit-controller'
import {
  SpeedHistoryStore,
  StatsAggregator,
  TaskSpeedHistoryStore,
  TransferStatsRuntime,
} from '@core/stats'
import {
  pauseTask as pauseTaskAction,
  reAddTask as reAddTaskAction,
  resumeTask as resumeTaskAction,
} from '@core/task/actions'
import { finalizeTask } from '@core/task/actions/finalize-task'
import { removeTask } from '@core/task/actions/remove-task'
import { commitPolledTerminalTransition } from '@core/task/actions/shared'
import { countActiveDownloads } from '@core/task/active-downloads'
import { handleCreateTask } from '@core/task/create-task-handler'
import { DirectResourceValidatorService } from '@core/task/direct-resource-validator'
import { FileCleanupServiceImpl } from '@core/task/file-cleanup-service'
import { FinalNamePickerImpl } from '@core/task/final-name-picker'
import {
  hasEngineTaskDelta,
  mergeEngineTask,
} from '@core/task/merge-engine-task'
import { createFailureLogConsumer } from '@core/task/occurrences/log-consumer'
import { OccurrenceDispatcher } from '@core/task/occurrences/occurrence-dispatcher'
import { shouldEvictFromEngine } from '@core/task/should-evict-from-engine'
import { shouldSkipEngineCompletionFinalize } from '@core/task/should-skip-engine-completion-finalize'
import { shouldTriggerTransitionSave } from '@core/task/should-trigger-transition-save'
import { slimTasksForBroadcast } from '@core/task/slim-task-for-broadcast'
import { TaskManager } from '@core/task/task-manager'
import {
  defaultRecoveryFs,
  TaskRecoveryServiceImpl,
} from '@core/task/task-recovery-service'
import { TaskUpdatePublisher } from '@core/task/task-update-publisher'
import { TorrentMetaStoreImpl } from '@core/task/torrent-meta-store'
import { MagnetTracker } from '@core/torrent/magnet-tracker'
import { shouldSkipForPendingMagnetMetadata } from '@core/torrent/metadata-task-filter'
import { TorrentParser } from '@core/torrent/torrent-parser'
import {
  TrackerManager,
  TrackerProber,
  TrackerStore,
  TrackerSyncer,
} from '@core/tracker'
import type { NatManager } from '@motrix/nat'
import { APP_ID } from '@shared/constants'
import { DEFAULT_LOCALE, type SupportedLocale } from '@shared/constants/locales'
import { Events } from '@shared/protocol/events'
import { REGISTRY_CACHE_FILENAME } from '@shared/schemas/registry'
import { EngineState } from '@shared/types/engine'
import type { AppNotification } from '@shared/types/notification'
import type { AppSettings } from '@shared/types/settings'
import type { DownloadTask } from '@shared/types/task'
import { TaskType } from '@shared/types/task'
import type { TaskOccurrence } from '@shared/types/task-occurrence'
import {
  app,
  type BrowserWindow,
  dialog,
  autoUpdater as nativeAutoUpdater,
  powerMonitor,
  shell,
} from 'electron'
import { autoUpdater } from 'electron-updater'
import { bootstrapBridge, createNativeMessagingInstaller } from './bridge'
import { BridgeManager } from './bridge/bridge-manager'
import { isPackagedLinuxFlatpak } from './bridge/flatpak-environment'
import {
  isElectronSelfUpdateSupported,
  resolvePackagedLinuxSnapEnvironment,
} from './bridge/snap-environment'
import { CliToolService } from './cli/cli-tool-service'
import { resolveExecutable } from './cli/shell-environment'
import { CommandRegistry } from './commands/command-registry'
import { ContextStore } from './commands/context-store'
import { registerAllCommands } from './commands/definitions'
import { KeybindingRegistry } from './commands/keybindings/keybinding-registry'
import type { CommandDeps } from './commands/types'
import {
  DevelopmentUpdateSimulator,
  shouldUseDevelopmentUpdateSimulator,
} from './core/development-update-simulator'
import { UpdateManager } from './core/update-manager'
import { registerUpdateQuitPreparation } from './core/update-quit-preparation'
import { setupExceptionHandler } from './exception-handler'
import { registerApplicationMenuIpc } from './ipc/application-menu'
import { registerCommandHandlers } from './ipc/commands'
import { createRevealInFolderHandler } from './ipc/commands/reveal-in-folder'
import { registerDisclaimerIpc } from './ipc/disclaimer'
import { setupEventForwarding } from './ipc/events'
import { registerNotificationIpc } from './ipc/notifications'
import { registerQueryHandlers } from './ipc/queries'
import { setupLauncher } from './launcher'
import { i18n } from './lib/i18n'
import { setupLogger } from './logger'
import { MainProcessWorkCoordinator } from './main-process-work-coordinator'
import { installAllMenubarContributions } from './menu/contributions'
import { MenuManager } from './menu/menu-manager'
import { MenuRegistry } from './menu/menu-registry'
import { createNatManager } from './nat/nat-manager-factory'
import { createOsNotificationBridge } from './notifications/os-bridge'
import { DisclaimerGate } from './onboarding/disclaimer-gate'
import { setupAppImageIntegration } from './platform/appimage-integration-host'
import { syncAutoLaunch } from './platform/auto-launch'
import { resolveDefaultSaveDirOptions } from './platform/default-save-dir'
import { resolveDesktopBackgroundPolicy } from './platform/desktop-background-policy'
import { removePathRecursive, renameAtomic } from './platform/fs-helpers'
import { setupNativeThemeSync } from './platform/native-theme-sync'
import { setupPowerManager } from './platform/power-manager'
import { createProtocolManager } from './platform/protocol-manager'
import { createElectronPlatformServices } from './platform/services'
import { setupTray } from './platform/tray'
import { createElectronCapabilityHost } from './plugin/capability-host'
import { startDevWatcher } from './plugin/dev-watcher'
import { resolveElectronFfmpegEnvPath } from './plugin/ffmpeg-detect-electron'
import { resolvePluginHostLanguage } from './plugin/host-language'
import { resolvePluginsDir } from './plugin/plugins-dir'
import { createMainProxyApplier } from './proxy/wiring'
import { QuitController } from './quit/quit-controller'
import {
  registerDevShutdownHandler,
  registerTerminationSignalHandlers,
} from './quit/termination-signals'
import {
  LiquidGlassController,
  shouldEnableLiquidGlassByDefault,
} from './window/liquid-glass'
import { initializeRendererUrlPolicy } from './window/renderer-url-policy'
import { WindowManager } from './window/window-manager'
import { resolveMainWindowStartupPlan } from './window/window-startup-plan'

// ─── Platform Early Setup ───────────────────────────────

if (process.platform === 'win32') {
  app.setAppUserModelId(APP_ID)
}

// macOS shows the "Electron wants to use 'Motrix Safe Storage'" keychain
// prompt only when Chromium's OSCrypt touches the keychain AND the running
// binary's code signature doesn't match the keychain item's ACL — i.e. the
// ad-hoc-signed dev binary after an Electron upgrade. Signed release builds
// match their own ACL (and electronFuses.enableCookieEncryption is off), so
// end users never see it. There is no proper macOS runtime switch for this
// (use-mock-keychain is a test-only flag), so we intentionally do nothing
// here on darwin and rely on release signing.
// Linux differs: gnome-keyring/kwallet would prompt in production too. We no
// longer depend on the OS keychain (plugin secrets use the file-backed
// libsodium store), so force Chromium's basic password store to avoid the
// keyring prompt. `password-store=basic` is a documented production switch.
// See docs/specs/macos-keychain-and-signing.md.
if (process.platform === 'linux') {
  app.commandLine.appendSwitch('password-store', 'basic')
}

const platform = createElectronPlatformServices()
const rendererUrlPolicy = initializeRendererUrlPolicy({
  isPackaged: app.isPackaged,
  appPath: app.getAppPath(),
  devServerUrl: app.isPackaged ? null : process.env.VITE_DEV_SERVER_URL,
})

// ─── Logger ─────────────────────────────────────────────

const logDir = path.join(platform.userDataDir, 'logs')
setupLogger({ level: 'info', logDir, isDev: platform.isDev })
const log = getLogger('main')

// ─── Core Services ──────────────────────────────────────

const eventBus = new EventBus({
  onListenerError: (channel, err) =>
    log.warn({ err, channel }, 'event listener threw'),
})
const taskManager = new TaskManager()
// Coalesces the per-commit TaskUpdated fan-out (see
// docs/superpowers/specs/2026-08-07-task-updated-emit-coalescing-design.md).
// Phase 1: only commitTaskUpdate routes through it, via the optional
// publishTaskUpdate/publishTaskUpdateNow deps handed to task actions below.
// The broadcast snapshot is projected through slimTasksForBroadcast
// (option E): static per-task tracker data stays in TaskManager and the
// per-task GetTaskDetail query, but leaves the hot full-list payload.
const taskUpdatePublisher = new TaskUpdatePublisher({
  taskManager: { getAll: () => slimTasksForBroadcast(taskManager.getAll()) },
  eventBus,
})
const publishTaskUpdate = () => taskUpdatePublisher.publish()
const publishTaskUpdateNow = () => taskUpdatePublisher.publishNow()
const statsAggregator = new StatsAggregator()
const speedHistoryStore = new SpeedHistoryStore()
const taskSpeedHistoryStore = new TaskSpeedHistoryStore()
const torrentParser = new TorrentParser()
let windowManager: WindowManager
let transferStats: TransferStatsRuntime | null = null
let taskActivityService: TaskActivityService | null = null
let taskInspectorActivityRuntime: TaskInspectorActivityRuntime | null = null

function requireTaskActivityService(): TaskActivityService {
  if (!taskActivityService) {
    throw new Error('TaskActivityService is not initialized')
  }
  return taskActivityService
}

eventBus.on(Events.TaskUpdated, (...args) => {
  const tasks = args[0]
  if (Array.isArray(tasks)) {
    taskSpeedHistoryStore.append(tasks as readonly DownloadTask[])
  }
})

const settingsPath = path.join(platform.userDataDir, 'settings.json')
log.info({ settingsPath }, 'resolved settings path')
const settingsSnapEnvironment =
  process.platform === 'linux'
    ? resolvePackagedLinuxSnapEnvironment({
        platform: 'linux',
        isPackaged: app.isPackaged,
        resourcesPath: process.resourcesPath,
        env: process.env,
      })
    : null
const settingsFlatpakEnvironment =
  process.platform === 'linux' &&
  isPackagedLinuxFlatpak({
    platform: 'linux',
    isPackaged: app.isPackaged,
    env: process.env,
  })
const defaultSaveDirOptions = resolveDefaultSaveDirOptions({
  snapEnvironment: settingsSnapEnvironment,
  getSystemDownloadsDir: () => app.getPath('downloads'),
  getHomeDir: homedir,
  ensureDirectory: (directory) => mkdirSync(directory, { recursive: true }),
  onSystemDownloadsDirError: (error, fallbackDir) =>
    log.warn(
      { err: error, fallbackDir },
      'system downloads directory unavailable; using home fallback'
    ),
})
const cliToolService = new CliToolService({
  directInstallSupported:
    !settingsFlatpakEnvironment && settingsSnapEnvironment === null,
})
const settingsManager = new SettingsManager(settingsPath, {
  liquidGlassEffectDefault: shouldEnableLiquidGlassByDefault({
    isDev: platform.isDev,
  }),
  ...defaultSaveDirOptions,
  onChange: (old, updated) => {
    eventBus.emit(Events.SettingsChanged, { old, updated })
    // Forward GeoIP changes to the manager so it can swap the in-memory
    // reader when `enabled` flips. The manager guards itself against
    // reentrancy (own update() calls don't loop because they only mutate
    // lastUpdatedAt/databaseVersion, which the change listener ignores).
    if (
      geoipManager &&
      (old.geoip.enabled !== updated.geoip.enabled ||
        old.geoip.source !== updated.geoip.source)
    ) {
      void geoipManager.onSettingsChanged(old.geoip, updated.geoip)
    }
    if (
      windowManager &&
      process.platform === 'darwin' &&
      old.app.liquidGlassEffect !== updated.app.liquidGlassEffect
    ) {
      setTimeout(() => windowManager?.recreate('main'), 100)
    }
    if (
      windowManager &&
      (old.app.lightweightMode !== updated.app.lightweightMode ||
        old.app.runMode !== updated.app.runMode)
    ) {
      // Let the settings IPC response reach its renderer before a newly
      // enabled policy is allowed to release any hidden window.
      setTimeout(() => windowManager?.reconcileWindowRetention(), 100)
    }
    if (
      speedLimitController &&
      JSON.stringify(old.speedLimit) !== JSON.stringify(updated.speedLimit)
    ) {
      void speedLimitController.recompute()
    }
  },
})
const appliedDownloadProxyPolicy = new AppliedDownloadProxyPolicy()

// ─── aria2 Infrastructure ───────────────────────────────

const transport = new WebSocketTransport()
const protocol = new JsonRpcProtocol(transport)
const processManager = new Aria2ProcessManager({
  ownershipFilePath: path.join(platform.userDataDir, 'aria2-owner.json'),
})

log.info({ extraDir: platform.extraResourceDir }, 'resolved extra directory')

const configBuilder = new Aria2ConfigBuilder(
  path.join(platform.extraResourceDir, 'aria2.conf'),
  platform.userDataDir
)
const trustStore = new Aria2TrustStore(platform.userDataDir)

// ─── Database ───────────────────────────────────────────

const motrixDb = new MotrixDatabase(
  path.join(platform.userDataDir, 'motrix.db')
)

// Delivers durably-persisted terminal/diagnosis occurrences to in-process
// consumers (timeline, failure log, notification center); registered
// inside startEngineAndRestore() below, at the "occurrence consumer
// registration" marker. See the notificationCenter construction comment
// in initializeMainProcess (Phase 2) for the full must-reach
// registration/drain ordering rationale.
const occurrenceDispatcher = new OccurrenceDispatcher({
  listUndispatched: () => motrixDb.listUndispatchedOccurrences(),
  markDispatched: (occurrenceId) =>
    motrixDb.markOccurrenceDispatched(occurrenceId),
  log,
})

// ─── Task lifecycle helpers ─────────────────────────────

const finalNamePicker = new FinalNamePickerImpl({
  exists: pathExists,
})
const torrentMetaStore = new TorrentMetaStoreImpl(
  path.join(platform.userDataDir, 'torrents')
)
const fileCleanupService = new FileCleanupServiceImpl({
  removePathRecursive,
})

// ─── Late-Initialized (assigned in app.on('ready')) ─────

let rpcClient: Aria2RpcClient
let supervisor: EngineSupervisor
let proxyBridge: ProxyBridgeManager
let speedLimitController: SpeedLimitController
let sessionManager: SessionManager
let pollingScheduler: PollingScheduler
let aria2Adapter: Aria2Adapter
// Constructed in Phase 2 below (F4); see that construction site's comment
// for the full must-reach registration/drain ordering rationale.
let notificationCenter: NotificationCenter
// Constructed and registered in startEngineAndRestore; its task retry is
// late-bound by buildCommandHandlers to the ReAddTasks deps bundle.
let dnsFallbackConsumer: DnsFallbackConsumer | undefined
let dnsFallbackRetry: ((taskId: string) => Promise<unknown>) | undefined
let trayHandle: ReturnType<typeof setupTray> | null = null
let natManager: NatManager | null = null
let trackerManager: TrackerManager | null = null
let menuManager: MenuManager | null = null
let osNotificationBridge: { dispose(): void } | null = null
let geoipManager: GeoIPManager | null = null
let pluginHost: PluginHost | null = null
let devWatcherHandle: { close(): Promise<void> } | null = null
let bridgeManager: BridgeManager | null = null
let magnetTracker: MagnetTracker | null = null
let segmentClient: Aria2SegmentClient | null = null
let disposeIpcIngress: (() => void) | null = null
let pendingDisclaimerGate: DisclaimerGate | null = null
const mainProcessWork = new MainProcessWorkCoordinator()
const pollingNotificationUnsubscribers: Array<() => void> = []
// Media (hls/dash/mux) segment downloads run on the shared aria2 daemon and
// write under this root. The poll loop suppresses minting DownloadTasks for any
// row whose dir is here — a gid-timing-independent backstop against the
// segment-gid add/remove races that otherwise leak phantom "seg" tasks.
let mediaTmpRoot: string | null = null
let resolvedApplicationLocale: SupportedLocale = DEFAULT_LOCALE

// ─── Cleanup (shared by exception handler & quit) ───────

let cleanupPromise: Promise<void> | null = null

function performCleanup(): Promise<void> {
  // Fence engine exit handling before the first await. Windows may terminate
  // aria2 as soon as session end begins, before graceful cleanup reaches it.
  supervisor?.prepareForShutdown()

  // Release a first-run bootstrap waiting for legal consent before asking the
  // work coordinator to drain that bootstrap. This must happen synchronously
  // or declining/closing the disclaimer can deadlock shutdown.
  pendingDisclaimerGate?.cancel()
  pendingDisclaimerGate = null

  if (cleanupPromise) return cleanupPromise
  cleanupPromise = (async () => {
    const safely = async (
      label: string,
      action: () => void | Promise<void>
    ) => {
      try {
        await action()
      } catch (err) {
        log.warn({ err, label }, 'cleanup step failed')
      }
    }

    // Disable native menu ingress in the same synchronous shutdown turn.
    // Stale Electron MenuItem references are still guarded by mainProcessWork.
    menuManager?.disable()

    // Removing existing handlers and gating bootstrap/IPC must happen in the
    // same turn. Awaiting the synchronous removal first would yield a microtask
    // in which a Phase 2 continuation could install handlers after removal.
    const ingressClose = safely('ipc-ingress', () => disposeIpcIngress?.())
    disposeIpcIngress = null

    // Gate the ready bootstrap, IPC, startup restore, and detached shell work
    // synchronously. Cancellation-capable teardown must begin before awaiting
    // the drain: startup can be blocked on the engine/plugin/session that only
    // those teardown operations can release.
    const acceptedWorkDrain = mainProcessWork.stopAndDrain()
    await ingressClose
    const cancellationDrain = Promise.all([
      safely('polling', () => pollingScheduler?.stopAndDrain()),
      // The bridge owns long-lived HLS/DASH/mux jobs. Closing it cancels media
      // work and drains accepted bridge handlers.
      safely('bridge', () => bridgeManager?.stop()),
      safely('rpc-notifications', () => {
        for (const unsubscribe of pollingNotificationUnsubscribers.splice(0)) {
          unsubscribe()
        }
        aria2Adapter?.dispose()
      }),
      safely('dev-watcher', async () => {
        const handle = devWatcherHandle
        devWatcherHandle = null
        await handle?.close()
      }),
      safely('plugin-host', async () => {
        const host = pluginHost
        pluginHost = null
        await host?.shutdown()
      }),
      safely('magnet', () => magnetTracker?.stopAndDrain()),
      safely('speed-limit', () => speedLimitController?.stop()),
      safely('geoip', () => geoipManager?.stop()),
      safely('nat', () => natManager?.stop()),
    ])
    // Tracker edits pause active tasks while changing bt-tracker. Drain their
    // unconditional resume compensation while both Session persistence and
    // engine RPC are still available.
    await safely('tracker', () => trackerManager?.stopAndDrain())
    await Promise.all([
      cancellationDrain,
      safely('session', () => sessionManager?.stopAndDrain()),
      safely('engine', () => supervisor?.stop()),
    ])
    await safely('proxy-bridge', () => proxyBridge?.close())
    await safely('main-process-work', () => acceptedWorkDrain)
    await safely('task-inspector-activity', () =>
      taskInspectorActivityRuntime?.dispose()
    )
    await safely('transfer-stats', () => {
      if (!transferStats) return
      const flushed = transferStats.dispose()
      transferStats = null
      if (!flushed) {
        log.warn('transfer statistics final checkpoint failed')
      }
    })
    await safely('database', () => {
      if (motrixDb?.database.open) motrixDb.close()
    })
  })()
  return cleanupPromise
}

// ─── Window Manager & Protocol (must register before ready) ─

function loadWindowUrl(win: BrowserWindow, route: string) {
  const [pathname = '', query = ''] = route.split('?')
  const params = new URLSearchParams(query)
  params.set('locale', resolvedApplicationLocale)
  const localizedRoute = `${pathname}?${params.toString()}`
  rendererUrlPolicy.loadWindow(win, localizedRoute)
}

// Send an IPC event to the add-task window without racing the renderer
// load. useExternalHydration only subscribes after React mounts (one
// useEffect tick after did-finish-load), so dispatching SetAddTaskMode
// immediately after windowManager.open('add-task') drops the event on
// cold-start protocol clicks. Strategy:
//   1. If the page is still loading → wait for did-finish-load.
//   2. Defer 100ms so React reconciliation + useEffect run and the
//      renderer's transport.on(...) subscriptions are attached.
function dispatchWhenReady(
  win: BrowserWindow,
  channel: string,
  payload: unknown
) {
  const dispatchLog = getLogger('dispatch')
  const send = (reason: string) => {
    setTimeout(() => {
      if (!win.isDestroyed()) {
        dispatchLog.info({ channel, reason }, 'webContents.send firing')
        win.webContents.send(channel, payload)
      } else {
        dispatchLog.warn({ channel, reason }, 'window destroyed before send')
      }
    }, 100)
  }
  const loading = win.webContents.isLoading()
  dispatchLog.info({ channel, loading }, 'dispatchWhenReady entered')
  if (loading) {
    win.webContents.once('did-finish-load', () => send('did-finish-load'))
  } else {
    send('already-loaded')
  }
}

// Each new add-task BrowserWindow gets a `closed` listener that resets
// protocolManager's dialog state. Without this, after the first .torrent
// open + close, dialogActive stays true and subsequent opens fall through
// to the queue-increment path (TorrentQueueSizeChanged) instead of
// ProtocolTorrentFile — which leaves the freshly precreated window stuck
// on the Links tab without meta/files. WeakSet so destroyed windows are
// GC'd and we hook each fresh BrowserWindow exactly once.
const protocolHookedWindows = new WeakSet<BrowserWindow>()

function hookAddTaskCloseReset(win: BrowserWindow) {
  if (protocolHookedWindows.has(win)) return
  protocolHookedWindows.add(win)
  win.once('closed', () => {
    protocolManager?.resetDialogState()
  })
}

const protocolManager = createProtocolManager({
  getWindow: () => windowManager?.get('main') ?? null,
  settingsManager,
  torrentParser,
  // In an AppImage, appimage-integration owns the scheme defaults; don't let
  // Electron's setAsDefaultProtocolClient race it (see ProtocolManagerDeps).
  isAppImage: process.platform === 'linux' && Boolean(process.env.APPIMAGE),
  // External URL clicks (magnet/http(s)/ftp and
  // motrix://new-task?uri=...) open add-task with Links prefilled.
  onOpenAddTask: (params) => {
    if (!windowManager) return
    // show() handles positioning (centers on main when visible). Calling
    // without options skips its built-in setTimeout(100ms) — we route
    // through dispatchWhenReady so cold-start clicks land after
    // useExternalHydration has subscribed.
    windowManager.show('add-task')
    const win = windowManager.get('add-task')
    if (!win || win.isDestroyed()) return
    hookAddTaskCloseReset(win)
    dispatchWhenReady(win, Events.SetAddTaskMode, params)
  },
  // .torrent file association (and queue increments) ship a parsed
  // TorrentMeta to the add-task window — too rich for AddTaskUrlParams,
  // so this routes through ProtocolTorrentFile with the same
  // wait-for-ready guarantee.
  deliverToAddTask: (channel, payload) => {
    if (!windowManager) return
    windowManager.show('add-task')
    const win = windowManager.get('add-task')
    if (!win || win.isDestroyed()) return
    hookAddTaskCloseReset(win)
    dispatchWhenReady(win, channel, payload)
  },
  // motrix://plugins/<id> — navigation-only by contract
  // (.claude/rules/plugin-registry.md): open the marketplace detail route in
  // the main window. Dispatching directly (not via eventBus) keeps cold-start
  // deeplinks independent of setupEventForwarding registration order, and
  // NavigateTo is replay-buffered in the preload for the pre-subscribe gap.
  onOpenPluginDetail: (pluginId) => {
    if (!windowManager) return
    windowManager.show('main')
    const win = windowManager.get('main')
    if (!win || win.isDestroyed()) return
    dispatchWhenReady(win, Events.NavigateTo, `/plugins/${pluginId}`)
  },
})

setupExceptionHandler({
  isDev: platform.isDev,
  getWindow: () => windowManager?.get('main') ?? null,
  onFatalError: performCleanup,
})

const launcher = setupLauncher({
  onProtocolUrl: (url) => protocolManager.handle(url),
  onTorrentFile: (filePath) => {
    protocolManager.handleTorrentFile(filePath)
  },
  onShowWindow: () => {
    windowManager?.show('main')
  },
})

function runShellAsyncWork(
  label: string,
  operation: () => Promise<void>
): void {
  if (!mainProcessWork.isAccepting()) return
  void mainProcessWork
    .run(async () => {
      if (!mainProcessWork.isAccepting()) return
      await operation()
    })
    .catch((err) => {
      // stopAndDrain can win the small isAccepting() → run() race.
      if (
        !mainProcessWork.isAccepting() &&
        err instanceof Error &&
        err.message === 'AsyncWorkTracker is stopped'
      ) {
        return
      }
      log.warn({ err, label }, 'detached shell work failed')
    })
}

// ─── Polling Callback ───────────────────────────────────

async function handlePolledTasks(
  rawTasks: Aria2RawStatus[],
  source: PollingTaskUpdateSource
): Promise<void> {
  let dirty = false
  for (const raw of rawTasks) {
    if (shouldSkipForPendingMagnetMetadata(raw, magnetTracker)) {
      continue
    }
    // Segment downloads run on the shared aria2 daemon. Skip phantom
    // DownloadTask minting for gids that belong to active segment downloads.
    // The SegmentDownloader's own completion handling is independent — it
    // subscribes via Aria2SegmentClient's fan-out callbacks, so this skip
    // does NOT affect segment download progress or completion.
    if (segmentClient?.isSegmentGid(raw.gid)) {
      continue
    }
    // Backstop for the segment-gid add/remove timing races: a segment can be
    // live in aria2 but momentarily absent from segmentClient.active (between
    // addUri's RPC reply and active.add, or between active.delete and aria2
    // actually dropping the group on forceRemove). Segment downloads ALWAYS
    // write under mediaTmpRoot, so suppress minting for any such row — this is
    // independent of skip-set timing and kills the phantom "seg" task leak.
    if (mediaTmpRoot && raw.dir.startsWith(mediaTmpRoot)) {
      continue
    }
    // A remove/GID swap can complete after this poll's RPC captured the old
    // row but before reconciliation runs. Do not reinterpret that explicitly
    // retired ownership as a brand-new aria2 orphan.
    if (taskManager.isEngineTaskIdRetired(raw.gid)) {
      continue
    }

    const translated = translateRawToTask(raw)
    const existing = taskManager.getByEngineTaskId(raw.gid)
    if (existing) {
      const merged = mergeEngineTask(existing, translated)
      if (hasEngineTaskDelta(existing, merged)) {
        let publishedTerminal = false
        if (existing.status !== merged.status) {
          log.info(
            {
              gid: raw.gid,
              taskId: existing.id,
              from: existing.status,
              to: merged.status,
            },
            'task status changed'
          )
          // A poll-detected transition into Completed/Error is committed
          // through the occurrence-aware durable path INSTEAD OF the
          // batch requestSave() below — this task gets its own single-task
          // write (task row + occurrence row, one transaction) rather than
          // waiting on (or duplicating) the batch flush. Awaited inline
          // and published only on success: a terminal status that reached
          // the renderer without its row on disk would revert on the next
          // restart with no occurrence ever recorded. Terminal-vs-not is
          // owned by commitPolledTerminalTransition itself — a non-terminal
          // destination comes back as 'not-terminal' with nothing written.
          const outcome = await commitPolledTerminalTransition(
            existing.status,
            merged,
            {
              persistTaskWithOccurrence,
              occurrenceDispatcher,
              publish: (task) => taskManager.set(task.id, task),
              runTaskMutation: <T>(
                taskIds: readonly string[],
                operation: () => Promise<T>
              ) =>
                taskInspectorActivityRuntime
                  ? taskInspectorActivityRuntime.runTaskMutation(
                      taskIds,
                      operation
                    )
                  : operation(),
              log,
            }
          )
          // Nothing was published and nothing is durable: leave the prior
          // in-memory state (and its aria2 row) alone so the next poll
          // observes the same delta and retries.
          if (outcome === 'persist-failed') continue
          publishedTerminal = outcome === 'published'
          if (
            outcome === 'not-terminal' &&
            shouldTriggerTransitionSave(existing.status, merged.status)
          ) {
            // Capture mirror snapshot before aria2_motrix may zero fields.
            // requestSave coalesces with neighboring transitions in the
            // same poll tick (e.g. several tasks flipping Queued →
            // Downloading on the first active poll) so this stays cheap.
            void sessionManager
              .requestSave()
              .catch((err) =>
                log.warn({ err, taskId: existing.id }, 'transition save failed')
              )
          }
          if (
            shouldEvictFromEngine(existing.status, merged.status, existing.type)
          ) {
            // Either BT/Magnet seeding just satisfied its ratio/time target,
            // or the task just landed in Error (see shouldEvictFromEngine).
            // For Error this is in-session hygiene — the task row is already
            // durable via commitPolledTerminalTransition, and the restore
            // shield in SessionManager is what stops the per-boot duplicate
            // notification. Order matters:
            //   1. requestSave so announceList / isPrivate / file
            //      structure are durable — adoptByMetadata reads these
            //      to rebuild task.bt for the Trackers/Files tabs after
            //      the aria2 row is gone. Coalescing matters here: a burst
            //      of same-tick Error transitions (host down → 50 tasks
            //      fail at once) folds into one save instead of N full
            //      flushes.
            //   2. removeDownloadResult to purge aria2.db's
            //      `download_history` + session row so the next launch
            //      doesn't reload it.
            // Promise chained so save→remove run sequentially without
            // blocking the polling loop. See SessionManager.restore Pass 2.
            runShellAsyncWork('terminal engine eviction', async () => {
              try {
                await sessionManager.requestSave()
                if (!mainProcessWork.isAccepting()) return
                await aria2Adapter.removeDownloadResult(merged.engineTaskId)
              } catch (err) {
                log.warn(
                  {
                    err,
                    taskId: existing.id,
                    gid: merged.engineTaskId,
                  },
                  'terminal engine eviction failed'
                )
              }
            })
          }
        }
        // Sync task_files whenever the engine reports a non-empty file
        // list — covers BT/magnet metadata arrival, fresh tasks, AND
        // legacy tasks restored from a prior session where the auto-sync
        // trigger never ran, plus placeholder rows written by older magnet
        // swaps. The helper validates structural completeness before its
        // early-exit, so the steady-state cost remains ~one prepared query.
        if (merged.fileCount > 0) {
          runShellAsyncWork('task-files sync', () =>
            syncTaskFilesIfIncomplete(existing.id, merged.engineTaskId)
          )
        }
        if (!publishedTerminal) taskManager.set(existing.id, merged)
        dirty = true
      }
    } else {
      const id = newTaskId()
      const discoveredTask: DownloadTask = { ...translated, id }
      const persistParent = (): Promise<void> => persistTask(discoveredTask)
      try {
        if (taskInspectorActivityRuntime) {
          await taskInspectorActivityRuntime.parentTaskCreated(
            discoveredTask,
            persistParent
          )
        } else {
          await persistParent()
        }
      } catch (err) {
        // Nothing has been published yet. Leave the engine row ownerless so
        // the next poll retries the complete parent write with no Activity FK
        // race and no in-memory task that would disappear after restart.
        log.warn(
          { err, gid: raw.gid, taskId: id },
          'engine task adoption failed'
        )
        continue
      }
      taskManager.set(id, discoveredTask)
      log.info(
        { gid: raw.gid, taskId: id, name: translated.name },
        'new task discovered from engine'
      )
      // The complete parent is durable now, so FK-backed sidecars can be
      // written immediately instead of waiting for a later batch save.
      if (translated.fileCount > 0) {
        runShellAsyncWork('task-files orphan sync', () =>
          syncTaskFilesIfIncomplete(id, raw.gid)
        )
      }
      dirty = true
    }
  }
  // Publish the full task snapshot (the publisher snapshots getAll() at
  // flush time — the same array this tick just reconciled) so the renderer
  // applies it directly without an IPC round-trip back for ListTasks.
  // Skip publication when nothing changed.
  const tasks = taskManager.getAll()
  if (source === 'authoritative-poll') {
    await taskInspectorActivityRuntime?.recordAuthoritativeReconnectAnchors(
      tasks
    )
  }
  taskInspectorActivityRuntime?.recordSamples(tasks)
  if (dirty) publishTaskUpdate()
}

async function syncTaskFilesIfIncomplete(
  taskId: string,
  engineTaskId: string
): Promise<void> {
  try {
    const persisted = motrixDb.getTaskFiles(taskId)
    // Magnet confirmation persists selected indices immediately, before the
    // replacement aria2 task has exposed real paths. Treat those placeholder
    // rows as missing so the first authoritative file list replaces them.
    if (persisted.length > 0 && persisted.every((file) => file.path !== '')) {
      return
    }
    // task_files has FK on task_metadata.motrix_id. The metadata row is
    // written by the periodic SessionManager.save() (15s default) — for
    // a freshly-created task, polling fires the file sync each tick from
    // T0 onwards, but the metadata row only lands at T0+15s at the
    // earliest. Until then any insert into task_files trips
    // SQLITE_CONSTRAINT_FOREIGNKEY. Bail out quietly here; the next tick
    // after the first auto-save flush will succeed.
    if (motrixDb.getTask(taskId) === null) return
    const live = await aria2Adapter.getTaskFiles(engineTaskId)
    if (!mainProcessWork.isAccepting()) return
    if (live.length === 0) return
    motrixDb.replaceTaskFiles(
      taskId,
      live.map((f) => ({
        fileIndex: f.index,
        path: f.path,
        size: f.size,
        selected: f.selected,
      }))
    )
    eventBus.emit(Events.TaskFilesUpdated, { taskId })
  } catch (err) {
    log.warn({ err, taskId }, 'task_files initial sync failed')
  }
}

function rebaseTaskFilePaths(
  taskId: string,
  sourceRoot: string,
  finalRoot: string
): void {
  const rows = motrixDb.getTaskFiles(taskId)
  let changed = false
  const rebased = rows.map((row) => {
    if (!row.path) return row
    const relative = path.relative(sourceRoot, row.path)
    if (relative.startsWith('..') || path.isAbsolute(relative)) return row
    changed = true
    return {
      ...row,
      path: relative === '' ? finalRoot : path.join(finalRoot, relative),
    }
  })
  if (!changed) return
  motrixDb.replaceTaskFiles(taskId, rebased)
  eventBus.emit(Events.TaskFilesUpdated, { taskId })
}

// ─── Task persistence / finalize wiring ─────────────────

/**
 * `finalizeTask` and `TaskRecoveryService` expect a `taskManager` with
 * per-task `persist(task)` semantics. Our real `TaskManager` is
 * in-memory; durable persistence runs through `SessionManager.save()`
 * in batch. The shim writes the task back into `TaskManager` so polling
 * and subsequent reads see the mutation, and relies on the session
 * auto-save loop to flush to sqlite. Callers never await sqlite I/O on
 * the hot path.
 */
// Update the in-memory task and flush to motrix.db. finalizeTask /
// TaskRecoveryService call this on discrete state changes (completion, reseed,
// error, adopt), so persistence must NOT depend on the periodic auto-save —
// especially now that the auto-save is gated off while the engine is idle, and
// Downloading→Completed is not in TRANSITION_SAVE_PAIRS. This is also the
// hard durability barrier before rename/reseed side effects: saveTask() is
// serialized and rejects on SQLite failure, whereas requestSave() deliberately
// logs-and-resolves for fire-and-forget UI/polling snapshots.
function persistTask(task: DownloadTask): Promise<void> {
  return sessionManager.persistTask(task)
}

/**
 * Same durable barrier as `persistTask`, but additionally appends the task's
 * terminal occurrence (when non-null) to the outbox in the SAME SQLite
 * transaction. Passed as `persistTaskWithOccurrence` to every commit path
 * that can reach Completed/Error (finalize, recovery, magnet tracker, the
 * generic task-action deps) INSTEAD OF `persistTask`.
 */
function persistTaskWithOccurrence(
  task: DownloadTask,
  occurrence: TaskOccurrence | null
): Promise<void> {
  return sessionManager.persistTaskWithOccurrence(task, occurrence)
}

/**
 * Settings shim exposing the `{ bt: { seedTime, seedRatio } }` shape
 * `finalizeTask` expects. Reads the live `EngineSettings` so user
 * changes via the Settings UI are honored on every reseed (the
 * function is invoked per-finalize, not memoized).
 *
 * Units match aria2's RPC contract: `seedTime` is minutes, `seedRatio`
 * is a unit-less share ratio.
 */
function getFinalizeSettings(): {
  bt: { seedTime: number; seedRatio: number }
} {
  const engine = settingsManager.getEngine()
  return {
    bt: { seedTime: engine.seedTime, seedRatio: engine.seedRatio },
  }
}

function buildFinalizeDeps(adapter: Aria2Adapter) {
  const activityRecorder = requireTaskActivityService()
  return {
    taskManager: {
      getById: (id: string) => taskManager.getById(id),
      getAll: () => taskManager.getAll(),
      set: (id: string, task: DownloadTask) => taskManager.set(id, task),
      setReservedEngineTaskOwner: (
        id: string,
        task: DownloadTask,
        engineTaskId: string
      ) => taskManager.setReservedEngineTaskOwner(id, task, engineTaskId),
      reserveEngineTaskId: (engineTaskId: string) =>
        taskManager.reserveEngineTaskId(engineTaskId),
      releaseEngineTaskIdReservation: (engineTaskId: string) =>
        taskManager.releaseEngineTaskIdReservation(engineTaskId),
      retireEngineTaskIdReservation: (engineTaskId: string) =>
        taskManager.retireEngineTaskIdReservation(engineTaskId),
      persist: persistTask,
    },
    persistTaskWithOccurrence,
    occurrenceDispatcher,
    publishTaskUpdate,
    publishTaskUpdateNow,
    adapter,
    fs: { renameAtomic, removePathRecursive },
    torrentMetaStore,
    rebaseTaskFilePaths,
    settings: { get: getFinalizeSettings },
    eventBus,
    activityRecorder,
    recordTransition: (input: RuntimeTransitionInput) =>
      taskInspectorActivityRuntime?.recordTransition(input),
    runTaskMutation: <T>(
      taskIds: readonly string[],
      operation: () => Promise<T>
    ) =>
      taskInspectorActivityRuntime
        ? taskInspectorActivityRuntime.runTaskMutation(taskIds, operation)
        : operation(),
    log,
  }
}

// ─── Engine Start & Session Restore ─────────────────────

// Resolved once the startup sequence (engine start → SessionManager.restore()
// → TaskRecoveryService → event/polling wiring) has fully settled — on both
// success AND failure paths (see the .finally at the call site, which is the
// only resolver). createTask paths (UI IPC + bridge submits) await this
// before dispatching to the engine: a create that races restore() puts its
// gid into aria2, restore's clear() then wipes the freshly-registered task,
// and Pass 1 re-adopts the gid as an engine orphan — name keeps the `.motrix`
// placeholder, source flips to 'user', sourceMeta is lost, and the taskId
// already acked to the extension points at a task that no longer exists.
async function startEngineAndRestore(
  sessionSaveInterval: number,
  adapter: Aria2Adapter
) {
  log.info({ binaryPath: platform.aria2BinaryPath }, 'resolved aria2 binary')

  // Engine-incident notifications (Task 13): wired BEFORE supervisor.start()
  // — same must-reach ordering as the occurrence consumers registered
  // below; see the notificationCenter construction comment in
  // initializeMainProcess (Phase 2) for the full rationale. Grace-clean
  // stale engine-scoped ledger rows FIRST (no replay source for an
  // EngineFailurePayload survives a boot — its incidentId is only unique
  // within the boot that produced it), THEN subscribe.
  registerEngineFailureSubscriber({
    motrixDb,
    eventBus,
    notificationCenter,
    log,
  })
  registerEngineCompatibilitySubscriber({
    eventBus,
    notificationCenter,
    log,
  })

  // ─── occurrence consumer registration ─────────────────
  // F5: registered here, BEFORE supervisor.start() and its two early
  // returns below. See the notificationCenter construction comment in
  // initializeMainProcess (Phase 2) for the full must-reach ordering
  // rationale.
  occurrenceDispatcher.register('task-inspector-activity-timeline', (occ) =>
    taskInspectorActivityRuntime?.recordOccurrence(occ)
  )
  const failureLogConsumer = createFailureLogConsumer(log)
  occurrenceDispatcher.register(
    failureLogConsumer.name,
    failureLogConsumer.consume
  )
  const notificationConsumer = createNotificationOccurrenceConsumer({
    center: notificationCenter,
    getTaskName: (id) => taskManager.getById(id)?.name ?? null,
  })
  occurrenceDispatcher.register(
    notificationConsumer.name,
    notificationConsumer.consume
  )
  dnsFallbackConsumer = createDnsFallbackConsumer({
    getDnsMode: () => settingsManager.get().engine.dnsMode,
    getTaskStatus: (id) => taskManager.getById(id)?.status ?? null,
    getTaskName: (id) => taskManager.getById(id)?.name ?? null,
    applyAsyncDns: (asyncDns) => supervisor.applyAsyncDns(asyncDns),
    reAddTask: (id) =>
      dnsFallbackRetry
        ? dnsFallbackRetry(id)
        : Promise.reject(new Error('dns fallback task retry not bound')),
    notify: (input) => notificationCenter.notify(input),
    log: getLogger('dns-fallback'),
  })
  occurrenceDispatcher.register(
    dnsFallbackConsumer.name,
    dnsFallbackConsumer.consume
  )

  try {
    await supervisor.start(platform.aria2BinaryPath)
  } catch (err) {
    log.error({ err }, 'engine start failed')
    // F5: must-reach drain — see the notificationCenter construction
    // comment in initializeMainProcess (Phase 2) for the full rationale.
    await occurrenceDispatcher.drainAtStartup()
    return
  }

  if (supervisor.getState() !== EngineState.Ready) {
    log.error(
      { state: supervisor.getState(), error: supervisor.getLastError() },
      'engine not ready, skipping session restore'
    )
    // F5: same must-reach guarantee as the start()-throw branch above.
    await occurrenceDispatcher.drainAtStartup()
    return
  }

  try {
    await appliedDownloadProxyPolicy.runWithSnapshot(
      async (_snapshot, lease) => {
        await sessionManager.restore(lease.assertCurrent)
        await sessionManager.recoverLegacyTaskLost(lease.assertCurrent)
      }
    )

    // Plan B: re-prime MagnetTracker's in-memory cache from the
    // restored db state so polling skips magnet metadata GIDs and
    // quarantine tombstones survive across restart.
    magnetTracker?.primeFromDatabase()

    // Backfill task_files for restored BT tasks that never had a chance
    // to sync (legacy tasks created before the auto-sync trigger landed,
    // or tasks where the prior session crashed before the trigger ran).
    // Fire-and-forget per task — TaskFilesUpdated events refresh the UI
    // when each completes; we don't block startup.
    for (const task of taskManager.getAll()) {
      if (!task.bt) continue
      if (task.fileCount === 0) continue
      runShellAsyncWork('startup task-files sync', () =>
        syncTaskFilesIfIncomplete(task.id, task.engineTaskId)
      )
    }

    // Run startup recovery BEFORE polling/event subscriptions open.
    // TaskRecoveryService scans tasks whose `transitionPhase !== Idle`
    // (or `status === Finalizing`) and replays the correct recovery
    // action (rename, reseed, adopt, mark completed/error) so the
    // renderer observes a self-healed state as soon as updates start
    // flowing. See design spec §6.6.
    const finalizeDepsFactory = () => buildFinalizeDeps(adapter)
    const recoveryService = new TaskRecoveryServiceImpl({
      taskManager: {
        getAll: () => taskManager.getAll(),
        set: (id: string, task: DownloadTask) => taskManager.set(id, task),
        persist: persistTask,
      },
      persistTaskWithOccurrence,
      occurrenceDispatcher,
      db: motrixDb,
      adapter: {
        listActiveAndWaiting: () => adapter.listActiveAndWaiting(),
      },
      fs: defaultRecoveryFs,
      finalizeTask: (taskId) => finalizeTask(taskId, finalizeDepsFactory()),
      activityRecorder: requireTaskActivityService(),
      recordTransition: (input: RuntimeTransitionInput) =>
        taskInspectorActivityRuntime?.recordTransition(input),
      runTaskMutation: <T>(
        taskIds: readonly string[],
        operation: () => Promise<T>
      ) =>
        taskInspectorActivityRuntime
          ? taskInspectorActivityRuntime.runTaskMutation(taskIds, operation)
          : operation(),
      log,
    })

    const recoveredAnchorOrigins =
      taskInspectorActivityRuntime?.captureRecoveredAnchorOrigins(
        taskManager.getAll()
      )
    const report = await recoveryService.recoverOnStartup()
    if (taskInspectorActivityRuntime && recoveredAnchorOrigins) {
      await taskInspectorActivityRuntime.recordRecoveredAnchors(
        taskManager.getAll(),
        recoveredAnchorOrigins
      )
    }
    log.info(
      { report, restoredTaskCount: taskManager.getAll().length },
      'startup_recovery_done'
    )
    if (report.warnings.length > 0 || report.errors.length > 0) {
      eventBus.emit(Events.ToastShow, {
        key: 'task.recovery.toast',
        params: { count: report.totalScanned },
      })
    }

    // Shutdown may have gated work while restore/recovery was awaiting SQLite
    // or filesystem operations. Do not install fresh producers after cleanup
    // already unsubscribed and stopped polling; the tracked startup promise
    // still settles so accepted queries can drain before Activity/DB teardown.
    if (!mainProcessWork.isAccepting()) return

    // The renderer can mount before Phase 3 starts and its first ListTasks IPC
    // can either wait on this restore or race handler registration entirely.
    // Publish the authoritative post-recovery snapshot as well as releasing
    // the query barrier so both paths converge on the restored task list.
    // publishNow: startup's first paint must not wait out the window.
    publishTaskUpdateNow()

    // Subscribe to engine completion events so newly-finished tasks
    // are finalized (rename `.motrix` → final name; BT re-adds with
    // `bt-seed-unverified=true`). These trigger AFTER recovery so
    // in-flight finalizes from a previous run are settled first and
    // we don't race a second finalize on the same task.
    adapter.onBtDownloadComplete((engineTaskId) => {
      runShellAsyncWork('BT finalize', async () => {
        const task = taskManager.getByEngineTaskId(engineTaskId)
        if (!task) return
        // Re-entry guard. After finalizeBt re-adds the seeding gid with
        // `bt-seed-unverified=true`, aria2 marks every piece complete at
        // add time and immediately re-fires onBtDownloadComplete for the
        // brand-new gid. Without this guard, the handler runs finalizeBt
        // again on the SAME motrix task — forceRemove(newGid),
        // addTorrent → newer gid, which itself re-fires the event,
        // ad infinitum. The chain only breaks when something throws
        // (rename-to-self, FK violation in task_progress, etc.), and the
        // last gid that survives the storm is the one that ends up
        // seeding from upload_length=0 — explaining the user-reported
        // "Completed → Seeding → Completed restart loop": each restart
        // resumes the freshly-added survivor whose progress row has
        // never accumulated any uploaded bytes.
        //
        // Sentinel "this task is past finalize":
        //   • Renamed already (diskPath stripped of .motrix), AND
        //   • Not currently in the middle of a finalize cycle
        //     (status !== Finalizing && transitionPhase === Idle).
        if (shouldSkipEngineCompletionFinalize(task)) {
          log.debug(
            {
              taskId: task.id,
              engineTaskId,
              status: task.status,
              transitionPhase: task.transitionPhase,
            },
            'skip finalize for already-finalized or in-flight BT task'
          )
          return
        }
        try {
          await finalizeTask(task.id, finalizeDepsFactory())
        } catch (err) {
          log.error({ err, taskId: task.id }, 'finalizeTask failed (BT)')
        }
      })
    })

    adapter.onDownloadComplete((engineTaskId) => {
      runShellAsyncWork('HTTP finalize', async () => {
        const task = taskManager.getByEngineTaskId(engineTaskId)
        if (!task) return
        // BT tasks emit `onDownloadComplete` again after seeding finishes;
        // route only HTTP/FTP here. BT finalize runs via onBtDownloadComplete.
        if (task.type !== TaskType.Http && task.type !== TaskType.Ftp) {
          return
        }
        if (shouldSkipEngineCompletionFinalize(task)) return
        try {
          await finalizeTask(task.id, finalizeDepsFactory())
        } catch (err) {
          log.error({ err, taskId: task.id }, 'finalizeTask failed (HTTP)')
        }
      })
    })

    sessionManager.startAutoSave(sessionSaveInterval * 1000)
    // Gate the periodic save on engine activity. The scheduler derives
    // active/idle from aria2 getGlobalStat.numActive and broadcasts it here;
    // the save only flushes in-progress byte counts (which change only while
    // active), so idle ⇒ stop rewriting the whole task history every interval.
    eventBus.on(Events.EngineActiveChanged, (active) => {
      sessionManager.setEngineActive(Boolean(active))
    })

    pollingNotificationUnsubscribers.push(
      rpcClient.onDownloadStart((event) => {
        pollingScheduler.handleNotification('aria2.onDownloadStart', event)
      }),
      rpcClient.onDownloadPause((event) => {
        pollingScheduler.handleNotification('aria2.onDownloadPause', event)
      }),
      rpcClient.onDownloadComplete((event) => {
        pollingScheduler.handleNotification('aria2.onDownloadComplete', event)
      }),
      rpcClient.onDownloadStop((event) => {
        pollingScheduler.handleNotification('aria2.onDownloadStop', event)
      }),
      rpcClient.onDownloadError((event) => {
        pollingScheduler.handleNotification('aria2.onDownloadError', event)
      }),
      rpcClient.onBtDownloadComplete((event) => {
        pollingScheduler.handleNotification('aria2.onBtDownloadComplete', event)
      })
    )

    // Deliver anything the outbox still holds: rows a prior run persisted
    // but never dispatched, plus everything restore()/recovery just wrote
    // through SessionManager (which has no dispatcher of its own).
    await occurrenceDispatcher.drainAtStartup()

    pollingScheduler.start()
  } catch (err) {
    log.error({ err }, 'post-engine setup failed')
  }
}

// ─── Startup Sequence ───────────────────────────────────

async function initializeMainProcess(): Promise<void> {
  // ── Phase 1: Show window ASAP ─────────────────────────────
  // Only the minimum work needed before the window can open:
  // settings (for window bounds/run mode) and WindowManager.

  await settingsManager.load()
  if (!mainProcessWork.isAccepting()) return

  let pluginLocaleTargets: {
    registry: PluginRegistry
    capabilityHost: { setLocale(locale: SupportedLocale): void }
  } | null = null
  let localeContextStore: ContextStore | null = null
  const localeCoordinator = new LocaleCoordinator({
    initialLocale: resolvedApplicationLocale,
    onAppliedLocale: (locale) => {
      // Window routes expose only a fully-published locale. A window created
      // during prepare starts on the previous locale and converges through
      // the buffered LocaleChanged event after commit.
      resolvedApplicationLocale = locale
    },
    applyLocale: async (locale, isCurrent) => {
      const targets = pluginLocaleTargets
      if (targets) {
        await targets.registry.setHostLanguageTransaction(locale, {
          beforeCommit: async () => {
            await i18n.changeLanguage(locale)
          },
          commitHostLocale: () => {
            targets.capabilityHost.setLocale(locale)
          },
          rollbackHostLocale: async (previousLanguage) => {
            targets.capabilityHost.setLocale(previousLanguage)
            await i18n.changeLanguage(previousLanguage)
          },
          shouldCommit: isCurrent,
        })
      } else {
        await i18n.changeLanguage(locale)
      }
      if (!isCurrent()) return
      localeContextStore?.merge({ locale })
    },
    emitLocaleChanged: (language) => {
      eventBus.emit(Events.LocaleChanged, { language })
    },
  })

  const enqueueLocaleUpdate = (
    language: string,
    emitChange: boolean
  ): Promise<void> =>
    localeCoordinator.update(resolvePluginHostLanguage(language), emitChange)

  await enqueueLocaleUpdate(settingsManager.getApp().language, false)
  eventBus.on(Events.SettingsChanged, (payload: unknown) => {
    const { old, updated } = payload as {
      old: AppSettings
      updated: AppSettings
    }
    if (old.app.language === updated.app.language) return
    runShellAsyncWork('locale update', () =>
      enqueueLocaleUpdate(updated.app.language, true)
    )
  })

  // Apply env-driven settings overrides for e2e harnesses.
  //
  // - MOTRIX_RPC_PORT lets each test pick a free random port so it
  //   doesn't clash with a developer's running aria2 instance.
  // - MOTRIX_DEFAULT_SAVE_DIR redirects aria2's output away from the user's
  //   platform Downloads directory (SettingsManager.seedSentinels uses that
  //   when defaultSaveDir is empty), preventing test files from leaking into
  //   the developer's real download directory.
  //
  // Both are persisted into the (tmp) settings file under
  // MOTRIX_USER_DATA, which is itself per-test. They are merged into
  // a single update() call so the settings file is written once
  // rather than twice on startup.
  const enginePatch: Partial<{ rpcPort: number }> = {}
  const appPatch: Partial<{ defaultSaveDir: string }> = {}

  const rpcPortOverride = process.env.MOTRIX_RPC_PORT
  if (rpcPortOverride) {
    const port = Number.parseInt(rpcPortOverride, 10)
    if (Number.isFinite(port) && port > 0 && port < 65536) {
      enginePatch.rpcPort = port
    }
  }

  const defaultSaveDirOverride = process.env.MOTRIX_DEFAULT_SAVE_DIR
  if (defaultSaveDirOverride) {
    appPatch.defaultSaveDir = defaultSaveDirOverride
  }

  if (Object.keys(enginePatch).length > 0 || Object.keys(appPatch).length > 0) {
    await settingsManager.update({
      ...(Object.keys(enginePatch).length > 0 && { engine: enginePatch }),
      ...(Object.keys(appPatch).length > 0 && { app: appPatch }),
    })
    if (!mainProcessWork.isAccepting()) return
  }

  const engineSettings = settingsManager.getEngine()

  const gate = new DisclaimerGate({ settings: settingsManager })
  pendingDisclaimerGate = gate.isAccepted() ? null : gate
  const liquidGlass = new LiquidGlassController({ settingsManager })
  windowManager = new WindowManager({
    settingsManager,
    preloadPath: path.join(__dirname, '../preload/preload.cjs'),
    loadUrl: loadWindowUrl,
    liquidGlass,
    rendererUrlPolicy,
    resolveOpenTarget: (requested) =>
      !gate.isAccepted() && requested !== 'onboarding'
        ? 'onboarding'
        : requested,
    onSessionEnd: prepareForSessionEnd,
    retentionPolicy: {
      releaseMainOnDismiss: () => {
        const appSettings = settingsManager.getApp()
        return resolveDesktopBackgroundPolicy({
          lightweightMode: appSettings.lightweightMode,
          platform: process.platform,
          runMode: appSettings.runMode,
        }).releaseMainWindowWhenHidden
      },
      prewarmAddTask: () => !settingsManager.getApp().lightweightMode,
    },
  })
  // Apply the persisted theme before opening windows. Renderer-drawn Windows
  // controls inherit the same theme through CSS without native overlay sync.
  setupNativeThemeSync(eventBus, settingsManager)
  // Install forwarding before the onboarding window becomes interactive.
  // SetDisclaimerLanguage persists before its asynchronous locale transaction
  // completes; an immediate AcceptDisclaimer can open the main window in that
  // interval. Early forwarding guarantees the eventual LocaleChanged reaches
  // either the onboarding window or the newly-opened main window (whose
  // preload buffers it until React subscribes).
  setupEventForwarding(eventBus, windowManager)

  // Best-effort OS notification bridge (Task 16, spec §6): windowManager and
  // settingsManager are both live at this point, which is all it depends on
  // — it subscribes directly to eventBus and doesn't need the engine or
  // notificationCenter (constructed later, in Phase 2 below — see the F4
  // hoist comment) to exist yet, since it only reacts to NotificationAdded
  // once emitted.
  osNotificationBridge = createOsNotificationBridge({
    subscribe: (channel, listener) =>
      eventBus.on(channel, (...args: unknown[]) =>
        listener(args[0] as AppNotification)
      ),
    getMainWindow: () => windowManager?.get('main') ?? null,
    getAppSettings: () => settingsManager.getApp(),
    translate: i18n.t.bind(i18n),
    navigateToTask: (taskId) =>
      eventBus.emit(Events.NavigateTo, `/downloads/all?task=${taskId}`),
    log,
  })

  // OS logout/shutdown: skip the quit dialog so session end is never blocked.
  powerMonitor.on('shutdown', prepareForSessionEnd)

  if (gate.isAccepted()) {
    const runMode = settingsManager.getApp().runMode
    const backgroundPolicy = resolveDesktopBackgroundPolicy({
      lightweightMode: settingsManager.getApp().lightweightMode,
      platform: process.platform,
      runMode,
    })
    const mainWindowPlan = resolveMainWindowStartupPlan({
      openedAtLogin: launcher.wasOpenedAtLogin,
      runMode,
      releaseWhenHidden: backgroundPolicy.releaseMainWindowWhenHidden,
    })
    if (mainWindowPlan.create) {
      windowManager.open('main', { show: mainWindowPlan.show })
    }
  } else {
    const disposeDisclaimerIpc = registerDisclaimerIpc({
      gate,
      settings: settingsManager,
      windowManager,
      canContinue: () => mainProcessWork.isAccepting(),
      quitApp: () => requestForcedQuit('disclaimer-declined'),
    })
    disposeIpcIngress = disposeDisclaimerIpc

    const onboardingWindow = windowManager.open('onboarding')
    onboardingWindow.once('closed', () => {
      if (!gate.isAccepted()) {
        requestForcedQuit('disclaimer-window-closed')
      }
    })

    const decision = await gate.waitForDecision()
    disposeDisclaimerIpc()
    if (disposeIpcIngress === disposeDisclaimerIpc) {
      disposeIpcIngress = null
    }
    if (pendingDisclaimerGate === gate) {
      pendingDisclaimerGate = null
    }
    if (decision !== 'accepted' || !mainProcessWork.isAccepting()) return
  }

  if (!mainProcessWork.isAccepting()) return
  syncAutoLaunch(settingsManager.getApp().launchAtStartup)
  protocolManager.register()

  // Linux AppImage self-integration (desktop entry, icon, URL-scheme handlers).
  // No-op on other platforms/packagings; deferred so the one-time consent
  // dialog never blocks startup.
  runShellAsyncWork('appimage-integration', () =>
    setupAppImageIntegration({
      getMagnetEnabled: () => settingsManager.getApp().protocols.magnet,
    })
  )

  // ── Phase 2: Initialize services while renderer loads ─────
  // The renderer needs time to load JS bundles and render React.
  // Use that window to set up IPC handlers and core services.

  rpcClient = new Aria2RpcClient(transport, protocol, engineSettings.rpcSecret)
  aria2Adapter = new Aria2Adapter(rpcClient)
  const adapter = aria2Adapter
  proxyBridge = new ProxyBridgeManager()
  supervisor = new EngineSupervisor(
    eventBus,
    settingsManager,
    processManager,
    configBuilder,
    trustStore,
    rpcClient,
    adapter,
    proxyBridge,
    appliedDownloadProxyPolicy
  )

  // Construct SpeedLimitController immediately after supervisor so
  // setEffectiveLimitsProvider is registered before the first
  // supervisor.start() inside startEngineAndRestore().
  speedLimitController = new SpeedLimitController({
    getSettings: () => settingsManager.get().speedLimit,
    applyLimits: (limits) => supervisor.applySpeedLimits(limits),
    getEngineState: () => supervisor.getState(),
    emit: (channel, payload) => eventBus.emit(channel, payload),
  })
  supervisor.setEffectiveLimitsProvider(() =>
    speedLimitController.getEffective()
  )
  speedLimitController.start()

  // When the engine reaches Ready (cold-start or reconnect), force a
  // limit push so aria2 starts with the correct effective limits.
  // EngineRecovered is emitted by EngineSupervisor on every
  // Ready-state transition (see EngineSupervisor.setState).
  eventBus.on(
    Events.EngineRecovered as Parameters<typeof eventBus.on>[0],
    () => {
      void speedLimitController.onEngineReady()
    }
  )

  motrixDb.init()
  const activityEnvironment = taskInspectorActivityEnvironment(process.env)
  const activeTaskInspectorActivityRuntime = new TaskInspectorActivityRuntime(
    new TaskInspectorActivityStore(motrixDb.database),
    eventBus,
    {
      ...activityEnvironment.runtime,
      onError: (err, context) => {
        log.warn(
          { err, ...context },
          'task inspector activity persistence failed'
        )
      },
    }
  )
  taskInspectorActivityRuntime = activeTaskInspectorActivityRuntime
  const activeTaskInspectorActivityQuery = createTaskInspectorActivityQuery(
    activeTaskInspectorActivityRuntime,
    activityEnvironment.query
  )
  const activeTaskActivityService = new TaskActivityService(
    new TaskActivityStore(motrixDb.database),
    eventBus,
    {
      onError: (err, context) => {
        log.warn({ err, ...context }, 'task activity persistence failed')
      },
    }
  )
  taskActivityService = activeTaskActivityService
  const activeTransferStats = new TransferStatsRuntime(
    motrixDb.database,
    eventBus,
    {
      onError: (err) => {
        log.warn({ err }, 'transfer statistics persistence failed')
      },
    }
  )
  transferStats = activeTransferStats

  // ─── Plugin runtime ─────────────────────────────────────
  const { pluginsDir, builtinDir } = await resolvePluginsDir(platform)
  if (!mainProcessWork.isAccepting()) return
  const pluginStateStore = new PluginStateStore(motrixDb.database)
  const pluginBootstrapLocale = resolvedApplicationLocale
  // Signed builtin hot-update overlay dir (2026-07-18 design §5). Declared
  // here (ahead of the RegistryClient/builtin-updater construction further
  // down) because PluginRegistry needs it immediately for overlay-aware
  // manifest resolution.
  const overlayDir = path.join(platform.userDataDir, 'builtin-updates')
  const devPath = process.env.MOTRIX_PLUGIN_DEV_PATH
  const pluginRegistry = new PluginRegistry({
    pluginsDir,
    builtinDir,
    overlayDir,
    stateStore: pluginStateStore,
    hostVersion: app.getVersion(),
    hostLanguage: pluginBootstrapLocale,
    devPath,
  })
  await pluginRegistry.discover()
  if (!mainProcessWork.isAccepting()) return
  const pluginCapHost = await createElectronCapabilityHost({
    appVersion: app.getVersion(),
    hostLanguage: pluginBootstrapLocale,
    db: motrixDb.database,
    userDataDir: app.getPath('userData'),
    pluginsDir,
    settingsManager,
    // TODO Task 22: wire settingsManager.snapshot()?.plugins?.[pluginId] ?? {}
    configReader: (_pluginId) => ({}),
    // TODO Plan F: derive from manifest contributes.configuration schema
    secretFieldsFor: (_pluginId) => new Set(),
    manifestCommandIdsFor: (pluginId) => {
      const cmds = pluginRegistry.get(pluginId)?.manifest.contributes.commands
      return new Set(cmds?.map((c) => c.id) ?? [])
    },
    localeSnapshotFor: (pluginId) =>
      pluginRegistry.getLocaleDictionaries(pluginId),
  })
  pluginLocaleTargets = {
    registry: pluginRegistry,
    capabilityHost: pluginCapHost,
  }
  // Settings may change while plugin discovery/capability construction awaits.
  // Reconcile after attaching targets so manifests and runtime snapshots cannot
  // remain on the stale bootstrap locale.
  await localeCoordinator.reconcile()
  if (!mainProcessWork.isAccepting()) return
  const pluginGrants = new GrantsManager({
    registry: pluginRegistry,
    eventBus,
  })
  const activePluginHost = new PluginHost({
    registry: pluginRegistry,
    stateStore: pluginStateStore,
    capabilityHost: pluginCapHost,
    workerScriptPath: path.join(
      __dirname,
      '../core/plugin/host/quick-js-worker.cjs'
    ),
    appVersion: app.getVersion(),
    runtime: 'electron',
    hostLanguage: resolvedApplicationLocale,
    pluginGrants,
    idleDisposeMs: parsePluginIdleDisposeMs(
      process.env.MOTRIX_PLUGIN_IDLE_DISPOSE_MS
    ),
  })
  pluginHost = activePluginHost
  // Spec §I30 — real-time grant revocation. On a grants change, deactivate
  // the plugin so the next activation rebuilds its bridge with the new
  // effective permissions. Existing in-flight calls finish; new ones see
  // `plugin.capability.unavailable`.
  eventBus.on(Events.PluginGrantsChanged, (...args: unknown[]) => {
    const p = args[0] as { pluginId: string } | undefined
    if (!p?.pluginId) return
    if (pluginHost?.isActive(p.pluginId)) {
      void pluginHost.deactivate(p.pluginId)
    }
  })
  // Wire Plan D: cross-plugin command safeguards (schema cache + rate limit
  // + caller throttle + chain depth + audit) and bind the invoker to the
  // capability host. Must run AFTER registry.discover() so manifest schemas
  // can be compiled at install time.
  wireCommandSystem({
    registry: pluginRegistry,
    host: activePluginHost,
    capabilityHost: pluginCapHost,
    pluginsDir,
  })

  const pluginActivation = new ActivationDispatcher(
    pluginRegistry,
    activePluginHost
  )
  try {
    await pluginActivation.dispatch({ kind: 'startup' })
  } catch (err) {
    if (!mainProcessWork.isAccepting()) {
      await activePluginHost.shutdown()
      return
    }
    throw err
  }
  if (!mainProcessWork.isAccepting()) {
    await activePluginHost.shutdown()
    return
  }

  if (devPath) {
    runShellAsyncWork('dev watcher start', async () => {
      const handle = await startDevWatcher(
        devPath,
        pluginRegistry,
        activePluginHost,
        app.getVersion()
      )
      if (!mainProcessWork.isAccepting()) {
        await handle.close()
        return
      }
      devWatcherHandle = handle
    })
  }

  const pluginInstaller = new PluginInstaller({
    pluginsDir,
    registry: pluginRegistry,
    stateStore: pluginStateStore,
    capabilityHost: pluginCapHost,
    hostVersion: app.getVersion(),
  })

  // Media (hls/dash/mux) segment downloads write under this root. Compute it
  // here so SessionManager.restore() can skip aria2-restored segment downloads
  // (phantom-task guard); the bridge bootstrap reuses the same value for the
  // coordinator's tmpRoot and the poll loop's suppression.
  const mediaTmpDir = path.join(app.getPath('temp'), 'motrix-media')
  mediaTmpRoot = mediaTmpDir
  sessionManager = new SessionManager(
    taskManager,
    rpcClient,
    motrixDb,
    adapter,
    mediaTmpDir,
    undefined,
    undefined,
    () => {
      const snapshot = appliedDownloadProxyPolicy.snapshot()
      return snapshot
        ? { ...snapshot, userAgent: settingsManager.getEngine().userAgent }
        : null
    }
  )
  pollingScheduler = new PollingScheduler(
    rpcClient,
    eventBus,
    (stats) => {
      statsAggregator.update(stats)
      speedHistoryStore.append(stats)
      // PollingScheduler.stop() cancels future polls but cannot abort an RPC
      // already in flight. The nullable lifecycle reference prevents a late
      // completion from recording after Transfer has been disposed.
      transferStats?.record(stats)
      eventBus.emit(Events.StatsUpdated, stats)
    },
    handlePolledTasks
  )

  const natStack = createNatManager({
    eventBus,
    settingsManager,
    isEngineReady: () => supervisor.getState() === EngineState.Ready,
  })
  natManager = natStack.manager
  log.info('NatManager constructed')

  const startupGeoipManager = new GeoIPManager({
    settingsManager,
    eventBus,
    dbPath: path.join(platform.userDataDir, 'geoip', 'GeoLite2-Country.mmdb'),
  })
  geoipManager = startupGeoipManager
  await startupGeoipManager.start()
  if (!mainProcessWork.isAccepting()) {
    await startupGeoipManager.stop()
    return
  }
  log.info('GeoIPManager started')

  // MagnetTracker owns the metadata-only magnet flow used when the user
  // wants to choose files after magnet metadata resolves. It persists
  // pending metadata fetches to MotrixDatabase so they survive restart
  // (Plan B), and mirrors them into TaskManager so the Downloads list
  // shows a row in fetching_metadata state immediately on submit.
  const activeMagnetTracker = new MagnetTracker(
    rpcClient,
    eventBus,
    settingsManager,
    motrixDb,
    taskManager,
    torrentParser,
    activeTaskActivityService,
    {
      publishTaskUpdate,
      publishTaskUpdateNow,
      parentTaskCreated: (task, persistParent) =>
        activeTaskInspectorActivityRuntime.parentTaskCreated(
          task,
          persistParent
        ),
      recordTransition: (input) =>
        activeTaskInspectorActivityRuntime.recordTransition(input),
      deleteParentTask: (taskId, deleteParent) =>
        activeTaskInspectorActivityRuntime.deleteParentTask(
          taskId,
          deleteParent
        ),
      runTaskMutation: (taskIds, operation) =>
        activeTaskInspectorActivityRuntime.runTaskMutation(taskIds, operation),
      runExclusivePersistence: (operation) =>
        sessionManager.runExclusivePersistence(operation),
      torrentMetaDir: path.join(platform.userDataDir, 'torrents'),
      occurrenceDispatcher,
    }
  )
  magnetTracker = activeMagnetTracker

  // UpdateManager owns the renderer-facing snapshot while retaining raw
  // updater events for diagnostics. Downloads and installation remain
  // user-triggered even when the optional launch check is enabled.
  // electron-builder writes app-update.yml only for distributable
  // targets (dmg/zip/nsis) — dir builds and dev runs cannot update
  // themselves, so report 'unsupported' instead of letting
  // checkForUpdates surface a raw ENOENT for the missing file.
  const hasUpdateMetadata =
    app.isPackaged &&
    (await pathExists(path.join(process.resourcesPath, 'app-update.yml')))
  const updateSimulatorEnabled = shouldUseDevelopmentUpdateSimulator({
    isPackaged: app.isPackaged,
    value: process.env.MOTRIX_UPDATE_SIMULATOR,
  })
  const developmentUpdateSimulator = updateSimulatorEnabled
    ? new DevelopmentUpdateSimulator({
        currentVersion: app.getVersion(),
        onQuitAndInstall: () => app.quit(),
      })
    : null
  const updateBackend = developmentUpdateSimulator ?? autoUpdater
  const updatesSupported =
    updateSimulatorEnabled ||
    isElectronSelfUpdateSupported({
      hasUpdateMetadata,
      isPackaged: app.isPackaged,
      snapEnvironment: settingsSnapEnvironment,
    })
  if (developmentUpdateSimulator) {
    log.info('development update simulator enabled')
    registerUpdateQuitPreparation({
      updater: developmentUpdateSimulator,
      markForceQuit: () => quitController.markForceQuit(),
      setWillQuit: (value) => windowManager?.setWillQuit(value),
    })
  }
  if (!mainProcessWork.isAccepting()) return
  const updateManager = new UpdateManager({
    eventBus,
    updater: updateBackend,
    currentVersion: app.getVersion(),
    channel: settingsManager.getApp().updateChannel,
    supported: updatesSupported,
  })

  const trackerStorePath = path.join(platform.userDataDir, 'tracker.json')
  const trackerStore = new TrackerStore(trackerStorePath)
  const trackerSyncer = new TrackerSyncer()
  const trackerProber = new TrackerProber()
  trackerManager = new TrackerManager(
    settingsManager,
    rpcClient,
    eventBus,
    trackerSyncer,
    trackerProber,
    trackerStore,
    {
      pauseTask: (taskId) =>
        pauseTaskAction(taskId, {
          taskManager,
          adapter,
          eventBus,
          log,
          persistTask,
          persistTaskWithOccurrence,
          occurrenceDispatcher,
          recordTransition: (input) =>
            activeTaskInspectorActivityRuntime.recordTransition(input),
          runTaskMutation: (taskIds, operation) =>
            activeTaskInspectorActivityRuntime.runTaskMutation(
              taskIds,
              operation
            ),
          publishTaskUpdate,
          publishTaskUpdateNow,
        }),
      resumeTask: (taskId) =>
        resumeTaskAction(taskId, {
          taskManager,
          adapter,
          eventBus,
          log,
          persistTask,
          persistTaskWithOccurrence,
          occurrenceDispatcher,
          recordTransition: (input) =>
            activeTaskInspectorActivityRuntime.recordTransition(input),
          runTaskMutation: (taskIds, operation) =>
            activeTaskInspectorActivityRuntime.runTaskMutation(
              taskIds,
              operation
            ),
          publishTaskUpdate,
          publishTaskUpdateNow,
        }),
    },
    (settings) => proxyBridge.resolveForFetch(settings)
  )

  const proxyApplier = createMainProxyApplier(
    supervisor,
    trackerManager,
    proxyBridge
  )
  const initialProxySettings = settingsManager.getProxy()
  const proxyReady = mainProcessWork
    .run(() =>
      appliedDownloadProxyPolicy.applyTransition(() =>
        proxyApplier.applyAll(initialProxySettings)
      )
    )
    .catch((err) => log.warn({ err }, 'initial proxy apply failed'))

  if (
    updatesSupported &&
    !updateSimulatorEnabled &&
    settingsManager.getApp().checkForUpdatesOnLaunch
  ) {
    runShellAsyncWork('automatic update check', async () => {
      await proxyReady
      if (!mainProcessWork.isAccepting()) return
      await updateManager.check()
    })
  }

  const contextStore = new ContextStore()
  contextStore.merge({ locale: resolvedApplicationLocale })
  localeContextStore = contextStore

  const commandRegistry = new CommandRegistry()
  const menuRegistry = new MenuRegistry()
  const keybindingRegistry = new KeybindingRegistry()

  const commandDeps: CommandDeps = {
    taskManager,
    settingsManager,
    adapter,
    windowManager,
    eventBus,
    log,
    updateManager,
    protocolManager,
    fileCleanupService,
    torrentMetaStore,
    motrixDatabase: motrixDb,
    taskPersistence: sessionManager,
    magnetTracker: activeMagnetTracker,
    persistTask,
    persistTaskWithOccurrence,
    occurrenceDispatcher,
    recordTransition: (input) =>
      activeTaskInspectorActivityRuntime.recordTransition(input),
    deleteParentTasks: (taskIds, deleteParents) =>
      activeTaskInspectorActivityRuntime.deleteParentTasks(
        taskIds,
        deleteParents
      ),
    runTaskMutation: (taskIds, operation) =>
      activeTaskInspectorActivityRuntime.runTaskMutation(taskIds, operation),
    publishTaskUpdate,
    publishTaskUpdateNow,
  }

  registerAllCommands(commandRegistry, commandDeps)
  installAllMenubarContributions(menuRegistry)

  menuManager = new MenuManager({
    commandRegistry,
    menuRegistry,
    keybindingRegistry,
    contextStore,
    commandDeps,
    trackAsyncWork: (operation) => mainProcessWork.run(operation),
    onCommandError: (err) => {
      if (!mainProcessWork.isAccepting()) return
      log.warn({ err }, 'menu command tracking failed')
    },
    onApplicationMenuSet: () => {
      if (process.platform !== 'win32' && process.platform !== 'linux') return
      for (const win of windowManager.getAllWindows()) {
        win.setAutoHideMenuBar(false)
        win.setMenuBarVisibility(false)
      }
    },
  })
  menuManager.install()

  const nativeMessagingInstaller = createNativeMessagingInstaller()
  const createBridgeRuntime = async () => {
    const bridgeReAddDeps = {
      taskManager,
      adapter,
      eventBus,
      log,
      persistTask,
      persistTaskWithOccurrence,
      occurrenceDispatcher,
      recordTransition: (input: RuntimeTransitionInput) =>
        activeTaskInspectorActivityRuntime.recordTransition(input),
      runTaskMutation: <T>(
        taskIds: readonly string[],
        operation: () => Promise<T>
      ) =>
        activeTaskInspectorActivityRuntime.runTaskMutation(taskIds, operation),
      publishTaskUpdate,
      publishTaskUpdateNow,
      torrentMetaStore,
      getDirectResourceProxyOptions: () => {
        const snapshot = appliedDownloadProxyPolicy.snapshot()
        return snapshot
          ? { ...snapshot, userAgent: settingsManager.getEngine().userAgent }
          : null
      },
      directResourceProxyPolicy: appliedDownloadProxyPolicy,
    }
    const createTaskDeps = {
      adapter,
      directResourceValidator: new DirectResourceValidatorService(),
      directResourceProxyPolicy: appliedDownloadProxyPolicy,
      settingsManager,
      finalNamePicker,
      torrentMetaStore,
      taskManager,
      eventBus,
      publishTaskUpdate,
      activityRecorder: activeTaskActivityService,
      persistTask,
      parentTaskCreated: (
        task: DownloadTask,
        persistParent: () => void | Promise<void>
      ) =>
        activeTaskInspectorActivityRuntime.parentTaskCreated(
          task,
          persistParent
        ),
      rollbackTaskCreation: (taskId: string) =>
        sessionManager.runExclusivePersistence(() =>
          activeTaskInspectorActivityRuntime.deleteParentTask(taskId, () => {
            motrixDb.deleteTask(taskId)
          })
        ),
      runTaskMutation: <T>(
        taskIds: readonly string[],
        operation: () => Promise<T>
      ) =>
        activeTaskInspectorActivityRuntime.runTaskMutation(taskIds, operation),
      // Cold-start gate: engine ready AND startup restore settled. Without
      // the second wait, a submit racing restore() gets clobbered by its
      // clear() + orphan re-adopt (see mainProcessWork.waitForStartup()).
      waitForEngineReady: async () => {
        await supervisor.waitUntilReady(ENGINE_READY_TIMEOUT_MS)
        await mainProcessWork.waitForStartup()
      },
      assertEngineReady: () => supervisor.assertReady(),
      reuseExistingBt: (taskId: string) =>
        reAddTaskAction(taskId, bridgeReAddDeps),
    }
    // Deps for the deleteFiles-aware task/remove (Spec 4) — a SEPARATE path
    // from the extension download/cancel closure below (which is always
    // deleteWithFiles:false). Shares the full RemoveTaskDeps bundle.
    const removeTaskDeps = {
      taskManager,
      adapter,
      log,
      fileCleanupService,
      torrentMetaStore,
      eventBus,
      db: motrixDb,
      magnetTracker: activeMagnetTracker,
      taskPersistence: sessionManager,
      publishTaskUpdate,
      publishTaskUpdateNow,
      // Media task removal must tear down the coordinator run (segment
      // downloaders + ffmpeg), or removing the row orphans them. Lazy over
      // bridgeManager.current — the coordinator lives in the bridge runtime.
      cancelMedia: (taskId: string) =>
        bridgeManager?.current?.cancelMedia(taskId) ?? Promise.resolve(),
      deleteParentTasks: (
        taskIds: readonly string[],
        deleteParents: () => void | Promise<void>
      ) =>
        activeTaskInspectorActivityRuntime.deleteParentTasks(
          taskIds,
          deleteParents
        ),
      runTaskMutation: <T>(
        taskIds: readonly string[],
        operation: () => Promise<T>
      ) =>
        activeTaskInspectorActivityRuntime.runTaskMutation(taskIds, operation),
    }
    // Deps for the media-aware pause/resume core action driven by the bridge
    // control-plane. getMediaSegmentGids is lazy over bridgeManager.current
    // (same as the IPC command path in commands.ts).
    const mediaActionDeps = {
      taskManager,
      adapter,
      eventBus,
      log,
      persistTask,
      persistTaskWithOccurrence,
      occurrenceDispatcher,
      recordTransition: (input: RuntimeTransitionInput) =>
        activeTaskInspectorActivityRuntime.recordTransition(input),
      runTaskMutation: <T>(
        taskIds: readonly string[],
        operation: () => Promise<T>
      ) =>
        activeTaskInspectorActivityRuntime.runTaskMutation(taskIds, operation),
      getMediaSegmentGids: (id: string) =>
        bridgeManager?.current?.getMediaSegmentGids(id) ?? [],
      publishTaskUpdate,
      publishTaskUpdateNow,
    }
    const ffmpegBinariesDir = path.join(platform.userDataDir, 'binaries')
    // Resolve the configured/user-provided FFmpeg path without executing it.
    // Running `ffmpeg -version` here would trigger Gatekeeper for quarantined
    // user binaries during app startup, before any media task needs FFmpeg.
    const resolveFfmpegLocation = () =>
      locateFfmpeg(
        {
          manualPath: settingsManager.getMedia().ffmpegBinaryPath,
          userDataBinariesDir: ffmpegBinariesDir,
          platform: process.platform,
          envPath: resolveElectronFfmpegEnvPath(),
        },
        (candidate) => resolveExecutable(candidate, process.env)
      )
    const ff = await resolveFfmpegLocation()
    const segmentAria2Client = new Aria2SegmentClient(rpcClient)
    segmentClient = segmentAria2Client
    const revealInFolder = createRevealInFolderHandler({
      shell,
      getTask: (taskId) => taskManager.getById(taskId),
    })
    const bridgeDataDirLockRecoveryAuthority =
      launcher.bridgeDataDirLockRecoveryAuthority
    if (bridgeDataDirLockRecoveryAuthority === null) {
      throw new Error('bridge single-instance ownership unavailable')
    }
    // mediaTmpDir / mediaTmpRoot were computed once at bootstrap (above) so
    // SessionManager.restore() and the poll loop share the exact same root.
    return bootstrapBridge({
      getMainWindow: () => windowManager?.get('main') ?? null,
      motrixVersion: app.getVersion(),
      ffmpegAvailable: ff.available,
      enabled: true,
      // Read fresh on every factory invocation (including a hot restart from
      // BridgeManager.restart()), so a `bridge.fixedPort`/`instanceId` change
      // takes effect without a full app restart.
      bridgeSettings: settingsManager.get().bridge,
      bridgeDataDirLockRecoveryAuthority,
      eventBus,
      createTaskDeps,
      activityRecorder: activeTaskActivityService,
      // Startup barrier: hold extension submits (all kinds — direct, magnet,
      // hls/dash/mux) until restore/recovery settle. The extension reconnects
      // within ~0.5s of app launch, well inside the restore window.
      waitForReady: () => mainProcessWork.waitForStartup(),
      removeTask: async (taskId: string) => {
        if (!taskManager.getById(taskId)) return
        await removeTask(taskId, { deleteWithFiles: false }, removeTaskDeps)
      },
      // Bridge magnet → MagnetTracker metadata-only fetch (file dialog + no
      // duplicate BT record), attributed source='bridge' so progress
      // notifications still reach the extension. Mirrors Commands.CreateTask.
      submitMagnetForFileSelection: (uri, saveDir, sourceMeta) =>
        activeMagnetTracker.submit(uri, saveDir, {
          source: 'bridge',
          sourceMeta,
        }),
      isMagnetFileSelectionEnabled: () =>
        settingsManager.getApp().magnetFileSelection,
      finalNamePicker,
      defaultSaveDir: settingsManager.getApp().defaultSaveDir,
      readHandlerDeps: {
        taskManager,
        statsAggregator,
        supervisor,
      },
      writeHandlerDeps: {
        taskManager,
        pauseTask: (taskId: string) => pauseTaskAction(taskId, mediaActionDeps),
        resumeTask: (taskId: string) =>
          resumeTaskAction(taskId, mediaActionDeps),
        removeTask: (taskId: string, { deleteFiles }) =>
          removeTask(taskId, { deleteWithFiles: deleteFiles }, removeTaskDeps),
        createTask: (req) => handleCreateTask(req, createTaskDeps),
        parseTorrentFileCount: async (base64: string) =>
          (await torrentParser.parse(base64)).files.length,
        revealTask: (taskId) => revealInFolder({ taskId }),
      },
      ffmpegBinaryPath: ff.binaryPath,
      resolveFfmpegBinaryPath: async () =>
        (await resolveFfmpegLocation()).binaryPath,
      publishTaskUpdate,
      publishTaskUpdateNow,
      taskManager,
      segmentAria2: segmentAria2Client,
      tmpRoot: mediaTmpDir,
      // Media completion durable-save (the coordinator's persist hook) —
      // media tasks bypass the poll loop's transition saves entirely.
      persistTask,
      persistTaskWithOccurrence,
      occurrenceDispatcher,
      parentTaskCreated: (task, persistParent) =>
        activeTaskInspectorActivityRuntime.parentTaskCreated(
          task,
          persistParent
        ),
      recordTransition: (input) =>
        activeTaskInspectorActivityRuntime.recordTransition(input),
      runTaskMutation: (taskIds, operation) =>
        activeTaskInspectorActivityRuntime.runTaskMutation(taskIds, operation),
      trackAsyncWork: (operation) => mainProcessWork.run(operation),
      pluginRegistry,
      // biome-ignore lint/style/noNonNullAssertion: pluginHost is assigned before bridgeManager.start()
      pluginHost: pluginHost!,
    })
  }
  bridgeManager = new BridgeManager(createBridgeRuntime, () =>
    nativeMessagingInstaller.unregister()
  )

  const registryClient = new RegistryClient({
    cachePath: path.join(platform.userDataDir, REGISTRY_CACHE_FILENAME),
  })
  const builtinUpdater = new BuiltinUpdater({
    overlayDir,
    hostVersion: app.getVersion(),
  })
  runShellAsyncWork('builtin updater orphan cleanup', () =>
    builtinUpdater.cleanupOrphans()
  )

  // Notification pipeline boot ordering — canonical explanation; every
  // other mention of this rationale in this file is a one-line pointer
  // back here:
  //
  // 1. `notificationCenter` is constructed here in Phase 2 (F4), not
  //    inside startEngineAndRestore (Phase 3) — it only depends on
  //    motrixDb/eventBus/log, none of which depend on the engine, so there
  //    is no reason its IPC channels (and therefore the renderer's
  //    badge/list queries) should stay dark for the entire Phase-3
  //    engine-start window, or worse, never come up at all when the engine
  //    never reaches Ready.
  // 2. registerEngineFailureSubscriber and the notification occurrence
  //    consumer still wire up inside startEngineAndRestore (Task 13 / F5),
  //    consuming this instance via closure — but BEFORE supervisor.start()
  //    and BOTH of its early-return branches (start() throwing, or landing
  //    in a non-Ready state). That is why occurrenceDispatcher's
  //    drainAtStartup() is called from those two early-return branches
  //    too, not only after a successful Ready: it still redelivers
  //    whatever must-reach task occurrence the outbox is holding from a
  //    prior boot even when the engine itself never comes up this boot.
  //    These consumers only close over module-level bindings that don't
  //    depend on the engine, so nothing about registering them early is
  //    unsafe. (The Node/server shell has no engine-readiness gate at all
  //    — this ordering makes the Electron shell's must-reach behavior
  //    converge with it instead of diverging on a failed boot.)
  notificationCenter = new NotificationCenter({
    store: motrixDb,
    emit: eventBus.emit.bind(eventBus),
    log,
  })
  const disposeNotificationIpc = registerNotificationIpc({
    notificationCenter,
    trackAsyncWork: (operation) => mainProcessWork.run(operation),
  })

  // The main window can mount before the full IPC ingress is ready. The
  // application-menu bridge subscribes and immediately publishes the current
  // snapshot so an early renderer query is reconciled without losing state.
  const disposeApplicationMenuIpc = registerApplicationMenuIpc({
    menuManager: menuManager as MenuManager,
    windowManager,
    trackAsyncWork: (operation) => mainProcessWork.run(operation),
  })

  const disposeCommandHandlers = registerCommandHandlers({
    cliToolService,
    supervisor,
    dnsFallback: { reset: () => dnsFallbackConsumer?.reset() },
    bindTaskRetry: (fn) => {
      dnsFallbackRetry = fn
    },
    sessionManager,
    settingsManager,
    protocolManager,
    windowManager,
    natManager,
    torrentParser,
    adapter,
    taskManager,
    updateManager,
    // Startup barrier for UI-initiated creates (AddTask window, motrix://
    // protocol, .torrent file-open) — same restore race as bridge submits.
    waitForTasksReady: () => mainProcessWork.waitForStartup(),
    trackAsyncWork: (operation) => mainProcessWork.run(operation),
    trackerManager,
    contextStore,
    finalNamePicker,
    torrentMetaStore,
    fileCleanupService,
    eventBus,
    notificationCenter,
    motrixDatabase: motrixDb,
    geoipManager,
    proxyApplier,
    appliedDownloadProxyPolicy,
    pluginRegistry,
    pluginStateStore,
    // biome-ignore lint/style/noNonNullAssertion: assigned before registerCommandHandlers
    pluginHost: pluginHost!,
    pluginInstaller,
    pluginGrants,
    capabilityHost: pluginCapHost,
    userDataDir: platform.userDataDir,
    pluginsDir,
    pluginActivation,
    // biome-ignore lint/style/noNonNullAssertion: assigned just above in this block
    bridgeManager: bridgeManager!,
    magnetTracker: activeMagnetTracker,
    activityRecorder: activeTaskActivityService,
    persistTask,
    persistTaskWithOccurrence,
    occurrenceDispatcher,
    recordTransition: (input) =>
      activeTaskInspectorActivityRuntime.recordTransition(input),
    deleteParentTasks: (taskIds, deleteParents) =>
      activeTaskInspectorActivityRuntime.deleteParentTasks(
        taskIds,
        deleteParents
      ),
    runTaskMutation: (taskIds, operation) =>
      activeTaskInspectorActivityRuntime.runTaskMutation(taskIds, operation),
    parentTaskCreated: (task, persistParent) =>
      activeTaskInspectorActivityRuntime.parentTaskCreated(task, persistParent),
    publishTaskUpdate,
    publishTaskUpdateNow,
    registryClient,
    hostVersion: app.getVersion(),
    builtinUpdater,
    overlayDir,
  })
  const disposeQueryHandlers = registerQueryHandlers({
    cliToolService,
    taskManager,
    statsAggregator,
    speedHistoryStore,
    transferStats: activeTransferStats,
    taskActivityService: activeTaskActivityService,
    taskSpeedHistoryStore,
    taskInspectorActivityRuntime: activeTaskInspectorActivityQuery,
    waitForTasksReady: () => mainProcessWork.waitForStartup(),
    trackAsyncWork: (operation) => mainProcessWork.run(operation),
    supervisor,
    settingsManager,
    natManager,
    trackerManager,
    engineAdapter: adapter,
    motrixDatabase: motrixDb,
    geoipManager,
    pluginRegistry,
    registryClient,
    pluginGrants,
    pluginsDir,
    capabilityHost: pluginCapHost,
    hostVersion: app.getVersion(),
    userDataDir: platform.userDataDir,
    speedLimitController,
    updateManager,
  })
  disposeIpcIngress = () => {
    disposeCommandHandlers()
    disposeQueryHandlers()
    disposeNotificationIpc()
    disposeApplicationMenuIpc()
  }

  // Plugin log stream: forward every ring-buffer entry to renderers as
  // `${Events.PluginLog}:<pluginId>`. Renderers subscribe to that suffixed
  // channel via `window.motrix.on(`event:pluginLog:${id}`, ...)`. We never
  // unsubscribe — the host lives for the app lifetime.
  pluginCapHost.subscribeLog((pluginId, entry) => {
    windowManager.broadcast(`${Events.PluginLog}:${pluginId}`, entry)
  })

  setupPowerManager(eventBus)
  // menuManager is assigned and install()ed above — non-null by this point
  const activeMenuManager = menuManager as MenuManager
  trayHandle = setupTray({
    eventBus,
    settingsManager,
    menuManager: activeMenuManager,
    protocolManager,
    extraResourceDir: platform.extraResourceDir,
    toggleMainWindow: () => windowManager.toggle('main'),
  })

  launcher.flushDeferred()

  // ── Phase 3: Background tasks (no blocking) ───────────────
  // NAT discovery, engine start, and add-task window creation
  // all run in the background — none of them need to complete
  // before the user can see and interact with the main window.

  const startupNatManager = natManager
  if (settingsManager.get().nat.enabled && startupNatManager) {
    runShellAsyncWork('NAT manager start', () => startupNatManager.start())
  }

  const startupTrackerManager = trackerManager
  if (startupTrackerManager) {
    runShellAsyncWork('tracker manager init', () =>
      startupTrackerManager.init()
    )
  }

  void mainProcessWork
    .startStartup(async () => {
      // Finish the non-engine proxy scopes before startup commits the exact
      // aria2 route. This prevents a late non-Ready apply result from
      // overwriting the Ready snapshot.
      await proxyReady
      return startEngineAndRestore(engineSettings.sessionSaveInterval, adapter)
    })
    .catch((err) => {
      log.error({ err }, 'engine start/restore failed')
    })

  const bridgeEnabled = settingsManager.getApp().browserBridgeEnabled
  const startupBridgeManager = bridgeManager
  if (startupBridgeManager) {
    runShellAsyncWork(bridgeEnabled ? 'bridge start' : 'bridge cleanup', () =>
      bridgeEnabled
        ? startupBridgeManager.start()
        : startupBridgeManager.setEnabled(false)
    )
  }

  setTimeout(() => {
    if (!mainProcessWork.isAccepting()) return
    if (settingsManager.getApp().lightweightMode) return
    log.info('precreating add-task window')
    windowManager.precreate('add-task')
  }, 2000)
}

app.on('ready', () => {
  void mainProcessWork.run(initializeMainProcess).catch((err) => {
    if (
      !mainProcessWork.isAccepting() &&
      err instanceof Error &&
      err.message === 'AsyncWorkTracker is stopped'
    ) {
      return
    }
    log.error({ err }, 'main process initialization failed')
  })
})

// ─── Shutdown ───────────────────────────────────────────

const t = i18n.t.bind(i18n)

async function showQuitConfirmation(activeCount: number): Promise<{
  confirmed: boolean
  dontAskAgain: boolean
}> {
  try {
    const { response, checkboxChecked } = await dialog.showMessageBox({
      type: 'question',
      buttons: [t('common.cancel'), t('quit.confirm.quitButton')],
      defaultId: 0,
      cancelId: 0,
      message: t('quit.confirm.message', { count: activeCount }),
      detail: t('quit.confirm.detail'),
      checkboxLabel: t('quit.confirm.dontAskAgain'),
      checkboxChecked: false,
    })
    return { confirmed: response === 1, dontAskAgain: checkboxChecked }
  } catch {
    return { confirmed: true, dontAskAgain: false } // fail-open
  }
}

function beginShutdown(): void {
  // quitController.phase is already 'shutting-down' (set synchronously before
  // this call). app.quit() below re-fires before-quit synchronously; the guard
  // there relies on the phase already being terminal.
  supervisor?.prepareForShutdown()
  // Drain a pending coalesced TaskUpdated while consumers are still attached.
  taskUpdatePublisher.flush()
  windowManager?.setWillQuit(true) // FIRST — never before/during the dialog
  // Tear down renderer ingress before removing ipcMain handlers. Service
  // shutdown emits final state-change events (for example NAT stopped), and a
  // still-live renderer can react by invoking queries after their handlers
  // have been removed.
  windowManager?.destroyAll()
  trayHandle?.destroy()
  menuManager?.dispose()
  osNotificationBridge?.dispose()

  void performCleanup()
    .catch(() => {})
    .finally(() => app.quit())
}

function prepareForSessionEnd(): void {
  // This callback runs from Windows query-session-end/session-end and the
  // cross-platform powerMonitor shutdown event. Mark the child exit expected
  // synchronously; the ordinary quit flow performs the graceful stop later.
  supervisor?.prepareForShutdown()
  quitController.markSessionEnding()
}

const quitController = new QuitController({
  getWarnBeforeQuit: () => settingsManager.getApp().warnBeforeQuit,
  getActiveCount: () => countActiveDownloads(taskManager.getAll()),
  confirm: showQuitConfirmation,
  persistDisableWarn: () =>
    settingsManager.update({ app: { warnBeforeQuit: false } }).then(() => {}),
  beginShutdown,
})

registerUpdateQuitPreparation({
  updater: nativeAutoUpdater,
  markForceQuit: () => quitController.markForceQuit(),
  setWillQuit: (value) => windowManager?.setWillQuit(value),
})

const requestForcedQuit = (reason: string) => {
  log.info({ reason }, 'received forced quit request')
  quitController.requestForcedQuit()
}

registerTerminationSignalHandlers(requestForcedQuit)
if (rendererUrlPolicy.isDevelopmentServer) {
  registerDevShutdownHandler(() => requestForcedQuit('dev-runner'))
}

app.on('before-quit', (event) => {
  // (1) terminal re-entry from beginShutdown()'s app.quit() — must proceed.
  if (quitController.phase === 'shutting-down') return
  // (2) from here we drive quit manually.
  event.preventDefault()
  // (3) dialog already open — ignore re-entrant quit requests.
  if (quitController.phase === 'confirming') return
  // (4) idle → let the controller decide.
  quitController.requestQuit()
})

// ─── Lifecycle ──────────────────────────────────────────

app.on('window-all-closed', () => {
  // Keep running — main window is just hidden
})

app.on('activate', () => {
  windowManager?.show('main')
})
