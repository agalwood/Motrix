// YouTube MAIN-world sniffer (Chromium development build only — excluded from
// Chrome/Edge Web Store and Firefox builds by the virtual build-variant module).
import youtubeSnifferScriptPath from 'virtual:motrix-youtube-sniffer-script'
// Import from the `/browser` entry so vscode-jsonrpc's browser RAL is installed
// at SW startup. vscode-jsonrpc v9 requires a platform RAL before any
// MdxpConnection is created; without it the first inbound WS frame throws
// "No runtime abstraction layer installed". The `/browser` entry re-exports the
// full public API, so this also provides `Methods`.
import { Methods } from '@motrix/mdxp/browser'
import { BgAdapterRegistry } from '@/background/AdapterRegistry'
import { createAutoPopup } from '@/background/autoPopup'
import { BackendOperationCoordinator } from '@/background/BackendOperationCoordinator'
import {
  BadgeController,
  makeBadgeNotify,
} from '@/background/badge/BadgeController'
import { BadgeErrorStore } from '@/background/badge/BadgeErrorStore'
import { createConnectionDiagnosticsHandler } from '@/background/ConnectionDiagnostics'
import { ConnectionGate } from '@/background/ConnectionGate'
import type { ConnectionState } from '@/background/ConnectionManager'
import { ConnectionManager } from '@/background/ConnectionManager'
import { MediaCredentialStore } from '@/background/capture/MediaCredentialStore'
import {
  createConfirmedDownloadActions,
  requestConfirmedDownload,
} from '@/background/confirmedDownload'
import { createContextMenuDownloadRunner } from '@/background/contextMenu/download'
import {
  registerContextMenu,
  updateContextMenuTitle,
} from '@/background/contextMenu/register'
import { DownloadSubmissionService } from '@/background/DownloadSubmissionService'
import { createDownloadConfirmation } from '@/background/downloadConfirmation'
import { createDownloadDirectoriesHandler } from '@/background/downloadDirectories'
import { EndpointCatalogService } from '@/background/EndpointCatalogService'
import { EndpointConfigStore } from '@/background/EndpointConfigStore'
import { HandoffEndpointTracker } from '@/background/handoff/guard'
import { registerChromiumInterception } from '@/background/interception/chromium'
import { registerFirefoxInterception } from '@/background/interception/firefox'
import { registerWebRequestEarlyTakeover } from '@/background/interception/webRequestEarly'
import { makeLocaleChangeHandler } from '@/background/localeSync'
import { initLogLevel, log } from '@/background/log'
import { makeLogLevelChangeHandler } from '@/background/logLevelSync'
import { MediaReportLimiter } from '@/background/MediaReportLimiter'
import { MediaStore } from '@/background/MediaStore'
import { MediaThumbnailBroker } from '@/background/MediaThumbnailBroker'
import { MessageBus } from '@/background/MessageBus'
import {
  createManualTaskHandler,
  isExtensionPageSender,
} from '@/background/manualTask'
import { CredentialStore } from '@/background/mbp1/credential-store'
import { MAX_RUNS_PER_SESSION } from '@/background/mbp1/pairing-flow'
import { PinStore } from '@/background/mbp1/pin-store'
import { normalizeMediaReport } from '@/background/mediaTrust'
import { NotificationsConfigStore } from '@/background/NotificationsConfigStore'
import { registerNetworkMediaCapture } from '@/background/networkMediaCapture'
import { createNotificationSettingsHandlers } from '@/background/notificationSettings'
import { createNotify } from '@/background/notify'
import { PairingEndpointService } from '@/background/PairingEndpointService'
import { createPairingCodeSource } from '@/background/pairing-code-source'
import { PairNudge } from '@/background/pairNudge'
import { createPopupDownloadHandlers } from '@/background/popupDownloads'
import { clearRemoteBackendPoliciesForAuthority } from '@/background/RemoteBackendPolicyStore'
import { SafariNotificationTransport } from '@/background/SafariNotificationTransport'
import { recoverStorageBeforeEndpointAutostart } from '@/background/storage-migrations'
import { TakeoverConfigStore } from '@/background/TakeoverConfigStore'
import { createTakeoverSettingsHandlers } from '@/background/takeoverSettings'
import { requestTaskReveal } from '@/background/taskReveal'
import { UrlResolutionDispatcher } from '@/background/UrlResolutionDispatcher'
// crxjs ?script&iife is a build-time virtual import; TypeScript does not understand
// the query-string syntax, but Vite/crxjs resolves it to the compiled IIFE path string
// at bundle time so executeScript({ files: [snifferScriptPath] }) uses the real path.
// @ts-expect-error TS2307 — query-string import not in tsconfig types
import snifferScriptPath from '@/content/sniffer-entry?script&iife'
// ISOLATED-world relay: receives postMessage from the MAIN-world sniffer and
// forwards results to the background via chrome.runtime.sendMessage.
// @ts-expect-error TS2307 — query-string import not in tsconfig types
import relayScriptPath from '@/content/sniffer-relay?script&iife'
import { type Browser, extensionBrowser as browser } from '@/shared/browser'
import { isWebStoreBuild } from '@/shared/buildFlags'
import {
  CONTROL_PANEL_ACTIVITY_EVENT,
  type ControlPanelActivityEvent,
} from '@/shared/controlPanelEvents'
import { initI18n } from '@/shared/i18n'
import { newDownloadOperationId } from '@/shared/integration'
import { shouldExcludeHost } from '@/shared/media'
import { SAFARI_EXTENSION_ID } from '@/shared/safariNative'

// Build-time constant injected by vite (see vite.config.ts `define`).

const manifest = browser.runtime.getManifest()
const extensionId = browser.runtime.id

// Register passive discovery before constructing any Backend connection
// machinery. Resource collection is useful while Motrix is offline and must
// survive an unrelated connection startup failure.
const mediaStore = new MediaStore()
const mediaCredentialStore = new MediaCredentialStore()
const mediaReportLimiter = new MediaReportLimiter()
const mediaThumbnailBroker = new MediaThumbnailBroker({ store: mediaStore })
registerNetworkMediaCapture({
  store: mediaStore,
  credentialStore: mediaCredentialStore,
  webStore: isWebStoreBuild(),
  includeExtraHeaders: __BROWSER__ === 'chromium',
})
browser.tabs.onRemoved.addListener((tabId) => {
  mediaReportLimiter.clear(tabId)
  mediaThumbnailBroker.clear(tabId)
})
browser.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.url) {
    mediaReportLimiter.clear(tabId)
    mediaThumbnailBroker.clear(tabId)
  }
})

const endpointConfigStore = new EndpointConfigStore()
const backendOperationCoordinator = new BackendOperationCoordinator()
const handoffEndpoints = new HandoffEndpointTracker(
  endpointConfigStore,
  backendOperationCoordinator
)
const takeoverConfigStore = new TakeoverConfigStore()
const autoPopup = createAutoPopup(takeoverConfigStore)
const downloadConfirmation = createDownloadConfirmation(
  async (target, binding) => {
    await endpointLifecycleReady
    const guard = await handoffEndpoints.capture(target.origin)
    if (
      !guard ||
      guard.endpointId !== binding.endpointId ||
      (guard.endpointRevision ?? 0) !== binding.endpointRevision
    )
      return null
    return createConfirmedDownloadActions(confirmedDownloadDeps, target, guard)
  }
)
const notificationsConfigStore = new NotificationsConfigStore()
const badgeErrorStore = new BadgeErrorStore()
const gate = new ConnectionGate()
const adapterRegistry = new BgAdapterRegistry()
const resolutionDispatcher = new UrlResolutionDispatcher({
  registry: adapterRegistry,
})

// One credential root and one lifecycle authority are shared by profile
// writes, connection attempts, pairing status, and retirement cleanup.
const credentialStore = new CredentialStore()
const pinStore = new PinStore()
let manager: ConnectionManager
const endpointCatalogService = new EndpointCatalogService(
  endpointConfigStore,
  {
    retire: async (authority) => {
      await credentialStore.revokeAuthority(authority)
      await ConnectionGate.forAuthority(authority).clear()
      await clearRemoteBackendPoliciesForAuthority(authority)
    },
  },
  {
    coordinator: backendOperationCoordinator,
    beforeConnectionChange: () => {
      downloadConfirmation.cancelAll()
      handoffEndpoints.invalidate()
      manager.stopForEndpointChange()
    },
    afterConnectionChange: () => {
      // The lifecycle queue is still held here. Schedule the connection after
      // this callback returns so it cannot wait on its own lease operation.
      void manager.autostart().catch(() => {
        log.warn('backend connection restart failed after endpoint change')
      })
    },
  }
)

// Badge/lifecycle callbacks close over `manager` lazily and cannot run until
// after the synchronous construction below completes.
const badge = new BadgeController({
  getState: () => manager.getState(),
  hasActiveTasks: () => manager.hasActiveTasks(),
  errorStore: badgeErrorStore,
})
const platformNotify = createNotify(notificationsConfigStore, (source) =>
  manager.isNotificationSourceCurrent(source)
)
const notify = makeBadgeNotify(platformNotify, badge)

// See pairing-code-source.ts for why this deadline has to live here rather
// than only in the popup: `PairingFlow` cannot cancel a pending provider
// call, so the provider must enforce `request.timeoutMs` itself.
const pairingCode = createPairingCodeSource()

manager = new ConnectionManager({
  endpointConfigStore,
  backendOperationCoordinator,
  endpointLifecycleService: endpointCatalogService,
  gate,
  adapterRegistry,
  resolutionDispatcher,
  notify,
  pairingCodeSource: pairingCode.provider,
  credentialStore,
  pinStore,
  clientInfo: {
    kind: 'extension',
    name: 'motrix-extension',
    version: manifest.version,
    // Keep runtime.id for local message-sender checks; the wire claim must
    // match the bundle ID independently attested by the native service.
    extensionId: __BROWSER__ === 'safari' ? SAFARI_EXTENSION_ID : extensionId,
    browser: __BROWSER__,
    // userAgent is the closest "browser version" string available in a
    // service-worker context; Plan 03b refines this into a parsed
    // major.minor via UA-Client-Hints where available.
    browserVersion: navigator.userAgent,
    locale: browser.i18n?.getUILanguage?.() ?? 'en',
  },
})
const pairingEndpointService = new PairingEndpointService(
  endpointConfigStore,
  { credentialStore, pinStore, browser: __BROWSER__ },
  {
    coordinator: backendOperationCoordinator,
    onActiveUnpair: async (authority) => {
      handoffEndpoints.invalidate()
      manager.stopForEndpointChange()
      await ConnectionGate.forAuthority(authority).clear()
    },
  }
)

const submissions = new DownloadSubmissionService({
  popup: autoPopup,
  manager,
  isPaired: () => pairingEndpointService.isActivePaired(),
  captureGuard: () => handoffEndpoints.capture('context-menu'),
  storage: browser.storage.session,
})

// Start recovery immediately, while keeping every MV3 listener registration
// synchronous below. Message dispatch and non-message handoff entry points
// await this same promise, so no reconnect or durable backend operation can
// race the retired-token tombstone or an interrupted authority retirement.
const endpointLifecycleReady = recoverStorageBeforeEndpointAutostart({
  recoverPendingEndpointCleanup: () =>
    endpointCatalogService.recoverPendingCleanup(),
}).catch(() => {
  log.warn('pre-autostart storage recovery failed; autostart suppressed')
  throw new Error('background startup unavailable')
})
// A recovered catalogue is ready for dispatch even while Motrix is offline or
// its handshake is pending. Awaiting autostart in the shared barrier held ALL
// popup/content messages until the network attempt completed (#28).
// Observe recovery rejection without starting a connection; the original
// promise remains rejected so every later entry point still fails closed.
void endpointLifecycleReady
  .then(
    () => manager.autostart(),
    () => undefined
  )
  .catch(() => {
    log.warn('backend autostart failed after storage recovery')
  })

manager.onStateChange((s) => {
  log.info('connection state →', s)
  if (s === 'connected') void platformNotify.flush()
})
manager.onStateChange(() => void badge.refresh())
manager.onActivityChange(() => {
  void badge.refresh()
  // Best-effort wake-up for an open popup. There is normally no receiver while
  // the popup is closed, and that expected rejection must not reach the SW.
  const event: ControlPanelActivityEvent = {
    kind: CONTROL_PANEL_ACTIVITY_EVENT,
  }
  void browser.runtime.sendMessage(event).catch(() => undefined)
})
void badge.refresh() // initial paint / re-apply a persisted error after SW restart

const bus = new MessageBus({
  beforeDispatch: () => endpointLifecycleReady,
})
bus.on(
  'bg.runConnectionDiagnostics',
  createConnectionDiagnosticsHandler({
    getConfig: () => endpointConfigStore.get(),
    getPairingStatus: (endpointId) =>
      pairingEndpointService.getStatus(endpointId),
  })
)
bus.on(
  'bg.getDownloadDirectories',
  createDownloadDirectoriesHandler({
    extensionId,
    extensionBaseUrl: browser.runtime.getURL(''),
    captureGuard: () => handoffEndpoints.capture('context-menu'),
    manager,
  })
)
bus.on('bg.getState', () =>
  pairingEndpointService.readActiveSnapshot(() => {
    const lastError = manager.getLastError()
    const server = manager.getServerIdentity()
    const errorReason = manager.getLastErrorReason()
    const retryAtMs = manager.getLastErrorRetryAtMs()
    // State-machine invariant 1: the prompt payload exists iff the manager is
    // in `awaiting-code` — a dead attempt's prompt never reaches a surface.
    const pending = manager.getPendingPairingCode()
    const capabilities = manager.getServerCapabilities()
    // `recoveryExhaustedUnattended` gets its own presentable copy in the
    // popup (see ConnectionStatusPanel) — omit the raw developer-facing
    // `lastError` sentence in that case rather than showing both.
    const recoveryExhaustedUnattended =
      errorReason === 'recoveryExhaustedUnattended'
    return {
      rpc: manager.getRpcStatus(),
      state: manager.getState(),
      phase: manager.getConnectionPhase(),
      attemptIntent: manager.getLastAttemptIntent(),
      // One branch for both fields: message and reason are companion facts
      // (set together in ConnectionManager), so they ship together or not at
      // all — a second predicate here is where they could drift apart.
      ...(lastError === null || recoveryExhaustedUnattended
        ? {}
        : {
            lastError,
            ...(errorReason === null ? {} : { lastErrorReason: errorReason }),
          }),
      ...(server === null ? {} : { server }),
      ...(pending === null
        ? {}
        : {
            pairingCode: {
              run: pending.request.run,
              maxRuns: MAX_RUNS_PER_SESSION,
              attemptsRemaining: pending.request.attemptsRemaining,
              deadlineMs: pending.deadlineMs,
            },
          }),
      ...(errorReason === 'backoffLocked' && retryAtMs !== null
        ? { backoff: { retryAtMs } }
        : {}),
      ...(manager.getDegraded() === true ? { degraded: true } : {}),
      capabilities: {
        taskReveal: capabilities?.taskReveal === true,
        downloadDirectories: capabilities?.downloadDirectories === true,
      },
      ...(recoveryExhaustedUnattended
        ? { recoveryExhaustedUnattended: true }
        : {}),
    }
  })
)
bus.on('bg.getDownloadOperations', ({ endpointId, endpointRevision }) =>
  submissions.list(endpointId, endpointRevision)
)
bus.on('bg.reconnect', async () => {
  await manager.clearGateAndStart()
  return { ok: true } as const
})
bus.on('bg.viewTasks', async () => {
  await manager.ensureReady({ intent: 'view-tasks' })
  return { ok: true } as const
})
bus.on('bg.clearBadgeError', async () => {
  // The popup sends this once when opened: resume due summaries without a timer.
  void platformNotify.flush()
  await badge.clearError()
  return { ok: true } as const
})
bus.on('bg.getEndpointConfig', async () => endpointConfigStore.get())
bus.on('bg.activateEndpoint', async ({ endpointId }) => {
  const { config } = await endpointCatalogService.activate(endpointId)
  return { config }
})
bus.on('bg.addServer', async (input) => {
  return endpointCatalogService.addServer(input)
})
bus.on('bg.updateServer', async ({ endpointId, expected, changes }) => {
  const result = await endpointCatalogService.updateServer(
    endpointId,
    expected,
    changes
  )
  return result
})
bus.on('bg.removeServer', async ({ endpointId, expected }) => {
  return endpointCatalogService.removeServer(endpointId, expected)
})
bus.on('bg.getPairingStatus', async ({ endpointId }) => {
  return pairingEndpointService.getStatus(endpointId)
})
bus.on('bg.hasPairedBackend', async () => ({
  paired: await pairingEndpointService.hasPairedBackend(),
}))
bus.on('bg.getRemoteBackendPolicy', async () => ({
  policy: await manager.getRemoteBackendPolicy(),
}))
bus.on('bg.replaceRemoteBackendPolicy', async (replacement) => ({
  policy: await manager.replaceRemoteBackendPolicy(replacement),
}))
const takeoverSettings = createTakeoverSettingsHandlers(
  takeoverConfigStore,
  () => pairingEndpointService.hasPairedBackend()
)
bus.on('bg.patchTakeoverEnabled', takeoverSettings.patchEnabled)
bus.on('bg.patchDownloadMode', ({ downloadMode }) =>
  takeoverConfigStore.patchDownloadMode(downloadMode)
)
bus.on('bg.patchTaskPanelPreference', ({ openTaskPanelAfterSubmit }) =>
  takeoverConfigStore.patchTaskPanelPreference(openTaskPanelAfterSubmit)
)
bus.on('bg.patchSiteExclusion', ({ domain, excluded }) =>
  takeoverConfigStore.patchSiteExclusion(domain, excluded)
)
bus.on('bg.getPopupReceipt', async ({ windowId }, sender) => {
  if (
    sender.id !== browser.runtime.id ||
    sender.url !== browser.runtime.getURL('popup.html')
  )
    return null
  return autoPopup.receipt(windowId)
})
bus.on('bg.getTakeoverConfig', async () => takeoverConfigStore.get())
bus.on('bg.setTakeoverConfig', takeoverSettings.set)
const notificationSettings = createNotificationSettingsHandlers({
  extensionId: browser.runtime.id,
  pageURLs: ['options.html', 'popup.html'].map((path) =>
    browser.runtime.getURL(path)
  ),
  native: new SafariNotificationTransport(),
  isSafari: () => __BROWSER__ === 'safari',
  browserNotificationsSupported: () =>
    typeof browser.notifications?.create === 'function',
  store: notificationsConfigStore,
})
bus.on('bg.getNotificationsConfig', notificationSettings.get)
bus.on('bg.setNotificationsConfig', notificationSettings.set)
bus.on('bg.getNotificationCapability', notificationSettings.capability)
bus.on('bg.testNotification', notificationSettings.test)
bus.on('bg.openNotificationSettings', notificationSettings.openSettings)
bus.on('bg.unpair', async ({ endpointId }) => {
  const { active } = await pairingEndpointService.unpair(endpointId)
  if (active) void refreshMenuTitle()
  return { ok: true } as const
})
// Does nothing itself — the response body is irrelevant. What matters is
// that this handler runs at all: an inbound runtime message resets the MV3
// service worker's own idle timer, which is the only thing this exists for.
// The popup calls it every ~20s while the pairing code-entry prompt is open,
// so the worker survives that window instead of being torn down mid-pairing.
bus.on('bg.pairHeartbeat', async () => ({ ok: true }) as const)
bus.on('bg.listPairCandidates', async () => {
  const candidates = await manager.listPairCandidates({ allowLaunch: true })
  return { candidates }
})
bus.on('bg.chooseCandidate', async ({ port }) => {
  manager.choosePairCandidate(port)
  // Fire-and-forget: a first-pair session can take minutes end to end (it
  // waits on the user's code entry), so this returns once the attempt has
  // started, not once it finishes. The popup tracks progress — and the
  // pairingCode prompt that follows — by polling bg.getState, the same way
  // it already tracks a plain reconnect.
  void manager.clearGateAndStart()
  return { ok: true } as const
})
bus.on('bg.submitPairingCode', async ({ code }) => {
  // State-machine invariant 2: outside `awaiting-code`, any pending record
  // belongs to a dead attempt — a code is never fed to a dead flow. The
  // ok:false is a business outcome, NOT a bus fault; an `error` field here
  // would make `send()`'s isErrorResponse duck test throw and misfile it.
  if (manager.getState() !== 'awaiting-code' || !pairingCode.submit(code)) {
    return { ok: false } as const
  }
  return { ok: true } as const
})
bus.on('bg.listAdapters', async () => ({
  adapters: adapterRegistry.list().map((a) => ({
    id: a.id,
    version: a.version,
    urlPatterns: a.urlPatterns,
  })),
}))
// popup → background → WS control-plane (paired session)
bus.on('bg.taskList', async (params) =>
  manager.request(Methods.TaskList, params)
)
bus.on('bg.taskGet', async (params) => manager.request(Methods.TaskGet, params))
bus.on('bg.taskPause', async (params) =>
  manager.request(Methods.TaskPause, params)
)
bus.on('bg.taskResume', async (params) =>
  manager.request(Methods.TaskResume, params)
)
bus.on('bg.taskReveal', async (params) => requestTaskReveal(manager, params))
bus.on('bg.taskRemove', async (params) =>
  manager.request(Methods.TaskRemove, params)
)
bus.on('bg.statsGet', async (params) =>
  manager.request(Methods.StatsGet, params)
)
bus.on('bg.engineStatus', async (params) =>
  manager.request(Methods.EngineStatus, params)
)
bus.on('bg.submitDownload', async (params, sender) => {
  if (!isExtensionPageSender(sender, extensionId, browser.runtime.getURL('')))
    throw new Error('download.rejected')
  return submissions.run(
    {
      idempotencyKey: params.idempotencyKey ?? newDownloadOperationId(),
      source: 'direct',
      resourceKey: JSON.stringify([
        params.selection,
        params.meta,
        params.saveDir,
      ]),
    },
    async () => params
  )
})
bus.on(
  'bg.createManualTask',
  createManualTaskHandler({
    extensionId,
    extensionBaseUrl: browser.runtime.getURL(''),
    submitDownload: (params, options) =>
      submissions.run(
        {
          pairIfNeeded: options.pairIfNeeded,
          directory: options.directory,
          idempotencyKey: params.idempotencyKey ?? newDownloadOperationId(),
          source: 'manual',
          resourceKey: JSON.stringify([
            params.selection,
            params.meta,
            params.saveDir,
          ]),
        },
        async () => params
      ),
  })
)
bus.on('bg.cancelDownload', async (params) => {
  await manager.cancelDownload(params.taskId)
  return { ok: true } as const
})

function senderDocumentKey(value: string | undefined): string | null {
  if (!value) return null
  try {
    const url = new URL(value)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
    url.hash = ''
    return url.toString()
  } catch {
    return null
  }
}

// content sniffer → background: store reported media items for the sender's tab
bus.on('bg.mediaDetected', async (payload, sender) => {
  const messageSender = sender as Browser.runtime.MessageSender
  const senderTab = messageSender.tab
  const tabId = senderTab?.id
  const senderTopUrl = senderTab?.url
  if (typeof tabId === 'number' && typeof senderTopUrl === 'string') {
    if (!mediaReportLimiter.allow(tabId, payload)) {
      return { ok: true } as const
    }
    let currentTab: Browser.tabs.Tab
    try {
      currentTab = await browser.tabs.get(tabId)
      if (
        !currentTab.url ||
        senderDocumentKey(currentTab.url) !== senderDocumentKey(senderTopUrl) ||
        shouldExcludeHost(new URL(currentTab.url).hostname, isWebStoreBuild())
      ) {
        return { ok: true } as const
      }
    } catch {
      return { ok: true } as const
    }
    // MAIN-world postMessage is page-controlled. Validate its claimed document
    // against the browser-authenticated sender frame, then rewrite ownership to
    // the trusted top tab. This lets all-frame DOM discovery work without an
    // iframe being able to impersonate another page.
    let frameUrl = messageSender.url ?? senderTopUrl
    const frameId = messageSender.frameId ?? 0
    const senderDocumentId = (
      messageSender as Browser.runtime.MessageSender & { documentId?: string }
    ).documentId
    try {
      const currentFrame = await browser.webNavigation.getFrame({
        tabId,
        frameId,
      })
      const currentDocumentId = (currentFrame as { documentId?: string } | null)
        ?.documentId
      if (
        !currentFrame?.url ||
        senderDocumentKey(currentFrame.url) !== senderDocumentKey(frameUrl) ||
        (senderDocumentId &&
          currentDocumentId &&
          senderDocumentId !== currentDocumentId)
      ) {
        return { ok: true } as const
      }
      frameUrl = currentFrame.url
    } catch {
      // Firefox versions without documentId still authenticate the sender URL;
      // the top-tab recheck below closes the navigation race.
      if (!senderDocumentKey(frameUrl)) return { ok: true } as const
    }
    const frameItems = normalizeMediaReport(payload, frameUrl)
    const currentItems = frameItems
      .filter((item) => {
        try {
          return !shouldExcludeHost(
            new URL(item.url).hostname,
            isWebStoreBuild()
          )
        } catch {
          return false
        }
      })
      .map((item) => ({
        ...item,
        pageUrl: currentTab.url as string,
        pageTitle:
          currentTab.title?.trim() ||
          item.pageTitle ||
          (currentTab.url as string),
        ...(frameUrl !== currentTab.url ? { frameUrl } : {}),
      }))
    if (currentItems.length === 0) return { ok: true } as const
    let latestTab: Browser.tabs.Tab
    try {
      latestTab = await browser.tabs.get(tabId)
    } catch {
      return { ok: true } as const
    }
    if (
      !latestTab.url ||
      senderDocumentKey(latestTab.url) !== senderDocumentKey(currentTab.url)
    ) {
      return { ok: true } as const
    }
    mediaCredentialStore.retainPage(tabId, currentTab.url)
    await mediaStore.retainPage(tabId, currentTab.url)
    await mediaStore.addForPage(tabId, currentTab.url, currentItems)
  }
  return { ok: true } as const
})

/** Returns true when the tab URL belongs to a YouTube domain. */
function isYouTubeTab(tab: Browser.tabs.Tab | undefined): boolean {
  if (!tab?.url) return false
  try {
    const host = new URL(tab.url).hostname
    return (
      host === 'www.youtube.com' ||
      host === 'youtube.com' ||
      host === 'youtu.be' ||
      host === 'www.youtube-nocookie.com' ||
      host === 'youtube-nocookie.com'
    )
  } catch {
    return false
  }
}

// Toolbar action → background: retain same-page findings, inject the idempotent
// relay, and ask the page-world sniffer to explicitly re-harvest the current
// route. Network hooks remain installed once per document.
bus.on('bg.scanActiveTab', async (_request, sender) => {
  if (!isExtensionPageSender(sender, extensionId, browser.runtime.getURL(''))) {
    throw new Error('invalid media scan sender')
  }
  const [tab] = await browser.tabs.query({ active: true, currentWindow: true })
  const tabId = tab?.id
  // Scanning is also the explicit capability refresh action. A live session
  // can discover FFmpeg configured after Motrix started, without reconnecting.
  const selectionKinds = (await manager.refreshServerCapabilities())
    ?.selectionKinds ?? ['direct']
  if (typeof tabId !== 'number') return { media: [], selectionKinds }
  if (tab?.url) {
    await mediaStore.retainPage(tabId, tab.url)
  } else {
    await mediaStore.clear(tabId)
  }
  // DOM enrichment is best-effort. Passive webRequest findings must remain
  // available on restricted pages even when script injection is denied.
  try {
    // Install the ISOLATED-world relay in every accessible frame before asking
    // the matching MAIN-world sniffer to rescan that frame.
    await browser.scripting.executeScript({
      target: { tabId, allFrames: true },
      files: [relayScriptPath],
    })
    if (
      !isWebStoreBuild() &&
      youtubeSnifferScriptPath !== null &&
      isYouTubeTab(tab)
    ) {
      // The adaptive YouTube resolver owns only the top player document.
      await browser.scripting.executeScript({
        target: { tabId },
        world: 'MAIN',
        files: [youtubeSnifferScriptPath],
      })
    } else {
      await browser.scripting.executeScript({
        target: { tabId, allFrames: true },
        world: 'MAIN',
        files: [snifferScriptPath],
      })
    }
    // Continuous content scripts normally populated the cache already. This
    // short yield only lets a just-injected relay finish its async message;
    // later discoveries stream through storage changes in the Popup.
    await new Promise<void>((resolve) => setTimeout(resolve, 75))
  } catch {
    // Keep returning the passive cache below.
  }
  return { media: await mediaStore.get(tabId), selectionKinds }
})

// Popup → background → ISOLATED content script: return a tiny raster
// sampled from an image the active page already rendered. The broker resolves
// only canonical MediaStore keys and rechecks the tab before returning pixels.
bus.on('bg.getMediaThumbnail', async (request) =>
  mediaThumbnailBroker.get(
    typeof request === 'object' && request !== null
      ? (request as { mediaKey?: unknown }).mediaKey
      : undefined
  )
)

const popupDownloads = createPopupDownloadHandlers({
  manager,
  submissions,
  mediaStore,
  mediaCredentialStore,
  extensionId,
  extensionBaseUrl: browser.runtime.getURL(''),
  getActiveTabs: () =>
    browser.tabs.query({ active: true, currentWindow: true }),
  cookieApi: browser.cookies as unknown as Parameters<
    typeof createPopupDownloadHandlers
  >[0]['cookieApi'],
  browserKind: __BROWSER__,
  userAgent: navigator.userAgent,
  webStore: isWebStoreBuild(),
})
bus.on('bg.submitMedia', popupDownloads.submitMedia)
bus.on('bg.resolvePageDownload', popupDownloads.resolvePageDownload)
bus.on('bg.grabberSnapshot', popupDownloads.grabberSnapshot)
bus.on('bg.grabberSubmit', popupDownloads.grabberSubmit)
bus.on('bg.grabberFormats', popupDownloads.grabberFormats)

bus.attach()

const pairNudge = new PairNudge({ notify })

const refreshMenuTitle = async (): Promise<void> => {
  try {
    await endpointLifecycleReady
  } catch {
    // Startup already emitted one fixed warning. A menu refresh is cosmetic
    // and must not create a second unhandled rejection on the failed wake.
    return
  }
  updateContextMenuTitle(await pairingEndpointService.isActivePaired())
}

const confirmedDownloadDeps = {
  confirmation: downloadConfirmation,
  submissions,
  manager,
  isPaired: () => pairingEndpointService.isActivePaired(),
  gate,
  nudge: pairNudge,
  notify,
}

registerContextMenu({
  getConfig: async () => {
    await endpointLifecycleReady
    return takeoverConfigStore.get()
  },
  run: createContextMenuDownloadRunner({
    confirmation: downloadConfirmation,
    submissions,
    getConfig: () => takeoverConfigStore.get(),
    popup: autoPopup,
    ready: () => endpointLifecycleReady,
    captureGuard: () => handoffEndpoints.capture('context-menu'),
    manager,
    isPaired: () => pairingEndpointService.isActivePaired(),
    gate,
    nudge: pairNudge,
    notify,
  }),
})

void refreshMenuTitle()
manager.onStateChange(() => {
  void refreshMenuTitle()
})

// React to locale changes made from the options page (or any other context)
// so the service worker's i18n state and context-menu title stay in sync.
// Registered synchronously (MV3 requires all listeners in the first tick).
browser.storage.onChanged.addListener(
  makeLocaleChangeHandler(() => {
    void refreshMenuTitle()
    void badge.refresh()
  })
)
browser.storage.onChanged.addListener(makeLogLevelChangeHandler())

// Fire-and-forget: i18next already has the browser-default language from module
// load (Task 1). initI18n applies any stored override; refreshMenuTitle then
// updates the menu item to reflect paired/unpaired state with the final locale.
// Done AFTER all synchronous listener registrations to satisfy MV3's requirement
// that all event listeners are registered in the first event-loop tick.
void initI18n().then(() => {
  void refreshMenuTitle()
  void badge.refresh()
})
void initLogLevel()

const interceptionDeps = {
  confirm: (
    target: import('@/shared/takeover').TakeoverTarget,
    windowId: number | undefined,
    guard: import('@/background/handoff/guard').HandoffGuard
  ) => requestConfirmedDownload(confirmedDownloadDeps, target, windowId, guard),
  popup: autoPopup,
  captureGuard: () => handoffEndpoints.capture('auto'),
  getConfig: async () => {
    await endpointLifecycleReady
    return takeoverConfigStore.get()
  },
  manager,
  isPaired: () => pairingEndpointService.isActivePaired(),
  gate,
  nudge: pairNudge,
  notify,
  selfExtensionId: extensionId,
}
if (__BROWSER__ === 'firefox') {
  registerFirefoxInterception(interceptionDeps)
  registerWebRequestEarlyTakeover(interceptionDeps, {
    confirmRequest: (
      target: import('@/shared/takeover').TakeoverTarget,
      windowId: number | undefined,
      guard: import('@/background/handoff/guard').HandoffGuard
    ) =>
      downloadConfirmation.request(
        target,
        windowId,
        createConfirmedDownloadActions(confirmedDownloadDeps, target, guard),
        guard.endpointId
          ? {
              endpointId: guard.endpointId,
              endpointRevision: guard.endpointRevision ?? 0,
            }
          : undefined
      ),
  })
} else if (__BROWSER__ === 'chromium') {
  registerChromiumInterception(interceptionDeps)
}

// Chrome MV3 service workers idle out after ~30s of inactivity. The
// alarm tick is a cheap-and-cheerful keepalive; Plan 03b layers a
// smarter ping-based keepalive on top.
// Only run the alarm while connected — an unpaired SW should be allowed
// to idle out (token-gated dormancy from Task 5).
if (typeof browser.alarms !== 'undefined') {
  const KEEPALIVE = 'motrix.keepalive'
  const syncKeepalive = (s: ConnectionState): void => {
    if (s === 'connected') {
      void browser.alarms.create(KEEPALIVE, { periodInMinutes: 0.5 })
    } else {
      void browser.alarms.clear(KEEPALIVE)
    }
  }
  manager.onStateChange(syncKeepalive)
  // Align the alarm with the manager's current state at boot. Today this
  // is a no-op because autostart() is async and yields before its first
  // setState — but the invariant "alarm exists iff state==='connected'"
  // should hold unconditionally, not contingent on autostart's timing.
  syncKeepalive(manager.getState())
  browser.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === KEEPALIVE) {
      log.info('keepalive tick; state:', manager.getState())
    }
  })
}
