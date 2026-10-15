import '@/styles/globals.css'
import { createRoot } from 'react-dom/client'
import type { NotificationsConfig } from '@/shared/notifications'
import { resolveLocale } from '@/shared/supportedLocales'
import { TAKEOVER_DEFAULT, type TakeoverSettings } from '@/shared/takeover'

const previewParams = new URLSearchParams(location.search)
let previewNotifications: NotificationsConfig = {
  master: previewParams.get('notificationMaster') === 'on',
  confirm: false,
  error: true,
  reminder: true,
}

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
  activeEndpointId:
    previewParams.get('pairing') === 'none' ? 'local' : 'studio',
  servers: [
    {
      id: 'studio',
      name: '工作室 Server',
      url: 'wss://motrix-studio.example:16800',
      revision: 0,
      state: 'ready',
    },
    {
      id: 'nas',
      name: '家庭 NAS',
      url: 'wss://motrix.example.com/bridge',
      revision: 0,
      state: 'ready',
    },
  ],
  cleanupTombstones: [],
}

const pairedEndpoints = new Set(
  previewParams.get('pairing') === 'none' ? [] : ['local', 'studio']
)
let nextServerId = 1
let previewTakeover = { ...TAKEOVER_DEFAULT }
let previewConnectionState: 'connected' | 'disconnected' =
  previewParams.get('pairing') === 'none' ? 'disconnected' : 'connected'

const previewRuntime = {
  id: 'motrix-options-preview',
  connectNative: () => undefined,
  getManifest: () => ({
    version: '0.1.0',
    permissions:
      previewParams.get('native') === 'off' ? [] : ['nativeMessaging'],
  }),
  sendNativeMessage: async () => undefined,
  sendMessage: async (message: unknown): Promise<unknown> => {
    const request = message as { kind?: string; payload?: unknown }
    switch (request.kind) {
      case 'bg.listPairCandidates':
        return { candidates: [] }
      case 'bg.hasPairedBackend':
        return { paired: pairedEndpoints.size > 0 }
      case 'bg.getEndpointConfig':
        return previewEndpoint
      case 'bg.activateEndpoint': {
        const payload = request.payload as { endpointId: string }
        previewEndpoint = {
          ...previewEndpoint,
          activeEndpointId: payload.endpointId,
        }
        previewConnectionState = pairedEndpoints.has(payload.endpointId)
          ? 'connected'
          : 'disconnected'
        return { config: previewEndpoint }
      }
      case 'bg.addServer': {
        const payload = request.payload as { name: string; url: string }
        const server = {
          id: `preview-server-${nextServerId++}`,
          ...payload,
          revision: 0,
          state: 'ready' as const,
        }
        previewEndpoint = {
          ...previewEndpoint,
          servers: [...previewEndpoint.servers, server],
        }
        return { config: previewEndpoint, server }
      }
      case 'bg.updateServer': {
        const payload = request.payload as {
          endpointId: string
          expected: { name: string; url: string; revision: number }
          changes: { name: string; url: string }
        }
        const previous = previewEndpoint.servers.find(
          ({ id }) => id === payload.endpointId
        )
        if (
          previous === undefined ||
          previous.name !== payload.expected.name ||
          previous.url !== payload.expected.url ||
          previous.revision !== payload.expected.revision
        ) {
          return { error: 'server changed; refresh and try again' }
        }
        const server = {
          id: payload.endpointId,
          ...payload.changes,
          revision: previous.revision,
          state: 'ready' as const,
        }
        const urlChanged = previous?.url !== server.url
        if (urlChanged) {
          // The real lifecycle persists cleanup-pending and a tombstone before
          // retiring the old authority. The preview performs those states
          // synchronously, but still exposes the final revision contract.
          const invalidatedRevision = previous.revision + 1
          previewEndpoint = {
            ...previewEndpoint,
            servers: previewEndpoint.servers.map((candidate) =>
              candidate.id === payload.endpointId
                ? {
                    ...server,
                    revision: invalidatedRevision,
                    state: 'cleanup-pending' as const,
                  }
                : candidate
            ),
            cleanupTombstones: [
              ...previewEndpoint.cleanupTombstones,
              {
                endpointId: previous.id,
                canonicalWsBase: previous.url,
                invalidatedRevision,
              },
            ],
          }
          server.revision = invalidatedRevision
        }
        previewEndpoint = {
          ...previewEndpoint,
          servers: previewEndpoint.servers.map((candidate) =>
            candidate.id === payload.endpointId ? server : candidate
          ),
          cleanupTombstones: previewEndpoint.cleanupTombstones.filter(
            ({ endpointId, invalidatedRevision }) =>
              endpointId !== payload.endpointId ||
              invalidatedRevision !== server.revision
          ),
        }
        if (urlChanged) {
          pairedEndpoints.delete(payload.endpointId)
          if (previewEndpoint.activeEndpointId === payload.endpointId) {
            previewConnectionState = 'disconnected'
          }
        }
        return {
          config: previewEndpoint,
          server,
          urlChanged,
          active: previewEndpoint.activeEndpointId === payload.endpointId,
        }
      }
      case 'bg.removeServer': {
        const payload = request.payload as {
          endpointId: string
          expected: { name: string; url: string; revision: number }
        }
        const previous = previewEndpoint.servers.find(
          ({ id }) => id === payload.endpointId
        )
        if (
          previous === undefined ||
          previous.name !== payload.expected.name ||
          previous.url !== payload.expected.url ||
          previous.revision !== payload.expected.revision
        ) {
          return { error: 'server changed; refresh and try again' }
        }
        const wasActive =
          previewEndpoint.activeEndpointId === payload.endpointId
        const invalidatedRevision = previous.revision + 1
        previewEndpoint = {
          ...previewEndpoint,
          servers: previewEndpoint.servers.map((candidate) =>
            candidate.id === payload.endpointId
              ? {
                  ...candidate,
                  revision: invalidatedRevision,
                  state: 'cleanup-pending' as const,
                }
              : candidate
          ),
          cleanupTombstones: [
            ...previewEndpoint.cleanupTombstones,
            {
              endpointId: previous.id,
              canonicalWsBase: previous.url,
              invalidatedRevision,
            },
          ],
        }
        previewEndpoint = {
          ...previewEndpoint,
          activeEndpointId: wasActive
            ? 'local'
            : previewEndpoint.activeEndpointId,
          servers: previewEndpoint.servers.filter(
            ({ id }) => id !== payload.endpointId
          ),
          cleanupTombstones: previewEndpoint.cleanupTombstones.filter(
            ({ endpointId, invalidatedRevision: revision }) =>
              endpointId !== payload.endpointId ||
              revision !== invalidatedRevision
          ),
        }
        pairedEndpoints.delete(payload.endpointId)
        if (wasActive) previewConnectionState = 'disconnected'
        return { config: previewEndpoint, wasActive }
      }
      case 'bg.getPairingStatus': {
        const payload = request.payload as { endpointId: string }
        return { paired: pairedEndpoints.has(payload.endpointId) }
      }
      case 'bg.unpair': {
        const payload = request.payload as { endpointId: string }
        pairedEndpoints.delete(payload.endpointId)
        if (previewEndpoint.activeEndpointId === payload.endpointId) {
          previewConnectionState = 'disconnected'
        }
        return { ok: true }
      }
      case 'bg.reconnect':
        previewConnectionState = pairedEndpoints.has(
          previewEndpoint.activeEndpointId
        )
          ? 'connected'
          : 'disconnected'
        return { ok: true }
      case 'bg.getState':
        return { state: previewConnectionState }
      case 'bg.getTakeoverConfig':
        return previewTakeover
      case 'bg.patchDownloadMode':
        previewTakeover = {
          ...previewTakeover,
          ...(request.payload as Pick<TakeoverSettings, 'downloadMode'>),
        }
        return previewTakeover
      case 'bg.patchTaskPanelPreference':
        previewTakeover = {
          ...previewTakeover,
          ...(request.payload as { openTaskPanelAfterSubmit: boolean }),
        }
        return previewTakeover
      case 'bg.setTakeoverConfig':
        previewTakeover = {
          ...previewTakeover,
          ...(request.payload as TakeoverSettings),
        }
        return { ok: true }
      case 'bg.getNotificationsConfig':
        return previewNotifications
      case 'bg.setNotificationsConfig':
        previewNotifications = request.payload as NotificationsConfig
        return { ok: true }
      case 'bg.getNotificationCapability':
        return {
          available: previewParams.get('notifications') !== 'unavailable',
          authorization: previewParams.get('notifications') ?? 'authorized',
        }
      case 'bg.testNotification':
        return { status: 'accepted' }
      case 'bg.openNotificationSettings':
        return { opened: true }
      case 'bg.listAdapters':
        return { adapters: [] }
      default:
        return { ok: true }
    }
  },
}

const storageChanged = {
  addListener: () => undefined,
  removeListener: () => undefined,
}
const previewBrowser = {
  action: { openPopup: async () => undefined },
  runtime: previewRuntime,
  i18n: {
    getUILanguage: () =>
      resolveLocale(
        new URLSearchParams(location.search).get('lang') ?? 'zh-CN'
      ),
  },
  storage: {
    local: {
      get: async () => ({}),
      set: async () => undefined,
      remove: async () => undefined,
    },
    onChanged: storageChanged,
  },
}

;(globalThis as unknown as { browser: unknown }).browser = previewBrowser
;(globalThis as unknown as { chrome: unknown }).chrome = previewBrowser

const [{ App }, { initI18n }, { initTheme }, { LocaleProvider }] =
  await Promise.all([
    import('@/options/App'),
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
    </LocaleProvider>
  )
