import '@/styles/globals.css'
import { createRoot } from 'react-dom/client'
import { createPreviewConfirmationPort } from '@/popup/previewConfirmation'
import {
  createPreviewTasks,
  PreviewTaskDataControl,
  resolvePreviewTaskDataset,
} from '@/popup/previewTasks'
import type { NotificationsConfig } from '@/shared/notifications'
import { withSiteExcluded } from '@/shared/siteExclusion'
import { resolveLocale } from '@/shared/supportedLocales'
import type { TakeoverConfig } from '@/shared/takeover'

const previewParams = new URLSearchParams(globalThis.location.search)
const previewTaskDataset = resolvePreviewTaskDataset(previewParams.get('data'))
let previewTasks = createPreviewTasks(previewTaskDataset)
const previewMessageListeners = new Set<(message: unknown) => void>()
const previewScan = previewParams.get('scan')
const previewFfmpegAvailable = previewParams.get('ffmpeg') !== 'missing'
const previewPageUrl =
  previewParams.get('page') === 'video'
    ? 'https://www.youtube.com/watch?v=preview'
    : 'https://example.com/watch'
const previewLocale = resolveLocale(previewParams.get('lang') ?? 'en-US')
let previewConnection =
  previewParams.get('connection') === 'offline' ||
  previewParams.get('pairing') === 'none'
    ? 'disconnected'
    : 'connected'

const previewMedia = [
  {
    kind: 'hls' as const,
    url: 'https://cdn.example.com/live/master.m3u8',
    pageUrl: 'https://example.com/watch',
    pageTitle: 'Live showcase',
    mimeType: 'application/vnd.apple.mpegurl',
    detectedAt: Date.now(),
  },
  {
    kind: 'direct' as const,
    url: 'https://cdn.example.com/video/launch-film.mp4',
    pageUrl: 'https://example.com/watch',
    pageTitle: 'Launch film',
    mimeType: 'video/mp4',
    detectedAt: Date.now(),
  },
]

type PreviewEndpoint = {
  version: 3
  activeEndpointId: string
  servers: Array<{
    id: string
    name: string
    url: string
    revision: number
    state: 'ready' | 'cleanup-pending'
  }>
  cleanupTombstones: Array<{
    endpointId: string
    canonicalWsBase: string
    invalidatedRevision: number
  }>
}

let previewEndpoint: PreviewEndpoint = {
  version: 3,
  activeEndpointId: 'local',
  servers: [
    {
      id: 'studio',
      name: 'Studio Server',
      url: 'wss://motrix-studio.example:16800',
      revision: 0,
      state: 'ready',
    },
    {
      id: 'nas',
      name: 'Home NAS',
      url: 'wss://motrix.example.com/ws',
      revision: 0,
      state: 'ready',
    },
  ],
  cleanupTombstones: [],
}

let previewTakeover: TakeoverConfig = {
  downloadMode: 'direct',
  openTaskPanelAfterSubmit: false,
  enabled: previewParams.get('pairing') !== 'none',
  consentAckVersion: 1,
  defaultAction: 'motrix',
  unknownSizeAction: 'chrome',
  rules: [],
}
let previewNotifications: NotificationsConfig = {
  master: true,
  confirm: false,
  error: true,
  reminder: true,
}

const previewRuntime = {
  id: 'motrix-popup-preview',
  onMessage: {
    addListener: (listener: (message: unknown) => void) =>
      previewMessageListeners.add(listener),
    removeListener: (listener: (message: unknown) => void) =>
      previewMessageListeners.delete(listener),
  },
  connectNative: () => undefined,
  connect: () =>
    createPreviewConfirmationPort(previewParams.get('confirmation')),
  openOptionsPage: async () => undefined,
  getURL: (path: string) =>
    path.replace('options.html', 'options-preview.html'),
  sendMessage: async (message: unknown): Promise<unknown> => {
    const request = message as { kind?: string; payload?: unknown }
    const kind = request.kind
    switch (kind) {
      case 'bg.hasPairedBackend':
        return { paired: previewParams.get('pairing') !== 'none' }
      case 'bg.runConnectionDiagnostics':
        await new Promise((resolve) => setTimeout(resolve, 800))
        return {
          startedAt: new Date().toISOString(),
          durationMs: 800,
          backend:
            previewEndpoint.activeEndpointId === 'local' ? 'local' : 'remote',
          checks: [
            {
              id: 'debug-log',
              status: 'pass',
              durationMs: 2,
              detail:
                'Debug logging enabled. Reproduce the connection failure to collect subsequent background-console logs. Restore the log level in Settings > Help when finished.',
            },
            {
              id: 'installation',
              status: 'warn',
              durationMs: 1,
              detail:
                'installType=development; unpackedDevelopmentInstall=true.',
            },
            {
              id: 'native-host',
              status: 'fail',
              durationMs: 12,
              detail:
                'Access to the specified native messaging host is forbidden.\nCheck this extension ID in the native-host allowlist and browser/enterprise policy.\nNative host: app.motrix.bridge\nallowed_origins must include "chrome-extension://motrix-popup-preview/"',
            },
            {
              id: 'discovery:16802',
              status: 'pass',
              durationMs: 8,
              detail:
                'Motrix discovery: appVersion="2.0.0", compatibility=compatible. Unauthenticated hint; pairing has not been tested.',
            },
          ],
        }
      case 'bg.getTakeoverConfig':
        return previewTakeover
      case 'bg.patchTakeoverEnabled':
        previewTakeover = {
          ...previewTakeover,
          ...(request.payload as {
            enabled: boolean
            consentAckVersion?: number
          }),
        }
        return previewTakeover
      case 'bg.setTakeoverConfig':
        previewTakeover = {
          ...previewTakeover,
          ...(request.payload as TakeoverConfig),
        }
        return { ok: true }
      case 'bg.patchDownloadMode':
        previewTakeover = {
          ...previewTakeover,
          ...(request.payload as Pick<TakeoverConfig, 'downloadMode'>),
        }
        return previewTakeover
      case 'bg.patchTaskPanelPreference':
        previewTakeover = {
          ...previewTakeover,
          ...(request.payload as { openTaskPanelAfterSubmit: boolean }),
        }
        return previewTakeover
      case 'bg.patchSiteExclusion': {
        const { domain, excluded } = request.payload as {
          domain: string
          excluded: boolean
        }
        previewTakeover = withSiteExcluded(previewTakeover, domain, excluded)
        return previewTakeover
      }
      case 'bg.getNotificationsConfig':
        return previewNotifications
      case 'bg.getNotificationCapability':
        return {
          available: previewParams.get('notifications') !== 'unavailable',
          authorization: previewParams.get('notifications') ?? 'authorized',
        }
      case 'bg.setNotificationsConfig':
        previewNotifications = request.payload as NotificationsConfig
        return { ok: true }
      case 'bg.getState':
        if (previewConnection !== 'connected') {
          return {
            state: previewConnection,
            endpoint: previewEndpoint,
            pairing:
              previewParams.get('pairing') === 'none' ? 'none' : 'stored',
            phase: previewConnection === 'connected' ? 'ready' : 'idle',
            attemptIntent: 'background-probe',
            lastError: 'motrix-not-running',
          }
        }
        return {
          state: previewConnection,
          endpoint: previewEndpoint,
          pairing: previewParams.get('pairing') === 'none' ? 'none' : 'stored',
          phase: previewConnection === 'connected' ? 'ready' : 'idle',
          attemptIntent: 'background-probe',
          server: {
            name: 'Motrix',
            version: '2.0.0',
            runtime:
              previewEndpoint.activeEndpointId === 'local'
                ? 'electron'
                : 'server',
          },
        }
      case 'bg.getDownloadOperations':
        return []
      case 'bg.viewTasks':
      case 'bg.reconnect':
        previewConnection = 'connected'
        return { ok: true }
      case 'bg.getEndpointConfig':
        return previewEndpoint
      case 'bg.activateEndpoint': {
        const { endpointId } = request.payload as { endpointId: string }
        previewEndpoint = {
          ...previewEndpoint,
          activeEndpointId: endpointId,
        }
        return { config: previewEndpoint }
      }
      case 'bg.getDownloadDirectories':
        if (previewParams.get('directories') === 'unsupported')
          return { status: 'unsupported' }
        if (previewConnection !== 'connected') return { status: 'unavailable' }
        return {
          status: 'ready',
          binding: {
            endpointId: previewEndpoint.activeEndpointId,
            endpointRevision: 0,
            instanceId: 'preview-instance',
          },
          directories: {
            defaultSaveDir: '/Users/preview/Downloads',
            favorites: [
              '/Volumes/Archive/Very long directory name for testing popup width and horizontal overflow/Movies',
            ],
            recent: ['/Users/preview/Documents'],
          },
        }
      case 'bg.taskList':
        return { tasks: previewTasks, total: previewTasks.length }
      case 'bg.taskRemove': {
        const { taskId } = request.payload as { taskId: string }
        previewTasks = previewTasks.filter((task) => task.id !== taskId)
        return { ok: true }
      }
      case 'bg.taskPause':
      case 'bg.taskResume': {
        const { taskId } = request.payload as { taskId: string }
        previewTasks = previewTasks.map((task) =>
          task.id === taskId
            ? {
                ...task,
                status: kind === 'bg.taskPause' ? 'paused' : 'downloading',
              }
            : task
        )
        return { ok: true }
      }
      case 'bg.statsGet':
        return {
          totalDownloadSpeed: 0,
          totalUploadSpeed: 0,
          activeTasks: 0,
          waitingTasks: 0,
          stoppedTasks: 0,
        }
      case 'bg.engineStatus':
        return { state: 'ready', featureReport: null }
      case 'bg.scanActiveTab':
        if (previewScan === 'restricted') {
          return { error: 'Cannot access a chrome:// URL' }
        }
        if (previewScan === 'empty') {
          return { media: [], selectionKinds: ['direct'] }
        }
        return {
          media: previewMedia,
          selectionKinds: previewFfmpegAvailable
            ? ['direct', 'hls', 'dash', 'mux']
            : ['direct'],
        }
      case 'bg.submitMedia':
      case 'bg.resolvePageDownload':
        return previewFfmpegAvailable
          ? { taskId: 'preview-task' }
          : { error: 'download.unsupported' }
      default:
        return { ok: true }
    }
  },
  getManifest: () => ({
    version: '0.1.0',
    permissions:
      previewParams.get('native') === 'off' ? [] : ['nativeMessaging'],
  }),
  sendNativeMessage: async () => undefined,
}

const storageChanged = {
  addListener: () => undefined,
  removeListener: () => undefined,
}
const previewBrowser = {
  windows: { getCurrent: async () => ({ id: 1 }) },
  action: { openPopup: async () => undefined },
  permissions: { contains: async () => true },
  runtime: previewRuntime,
  tabs: {
    create: async ({ url }: { url: string }) => {
      window.location.assign(url)
      return {}
    },
    query: async () => [{ id: 1, url: previewPageUrl, title: 'Launch film' }],
  },
  i18n: { getUILanguage: () => previewLocale },
  storage: {
    local: {
      get: async () => ({}),
      set: async () => undefined,
      remove: async () => undefined,
    },
    onChanged: storageChanged,
  },
}
const previewChrome = {
  ...previewBrowser,
  tabs: {
    query: async () => [{ id: 1, url: previewPageUrl, title: 'Launch film' }],
  },
}

;(globalThis as unknown as { browser: unknown }).browser = previewBrowser
;(globalThis as unknown as { chrome: unknown }).chrome = previewChrome

const [{ App }, { initI18n }, { initTheme }, { LocaleProvider }] =
  await Promise.all([
    import('@/popup/App'),
    import('@/shared/i18n'),
    import('@/shared/theme'),
    import('@/shared/LocaleProvider'),
  ])

initTheme()
await initI18n()

const root = document.getElementById('root')
if (root)
  createRoot(root).render(
    <LocaleProvider>
      <App />
      {import.meta.env.DEV && previewTaskDataset && (
        <PreviewTaskDataControl
          initialDataset={previewTaskDataset}
          onChange={(dataset) => {
            previewTasks = createPreviewTasks(dataset)
            for (const listener of previewMessageListeners) {
              listener({ kind: 'event.controlPanelActivity' })
            }
          }}
        />
      )}
    </LocaleProvider>
  )
