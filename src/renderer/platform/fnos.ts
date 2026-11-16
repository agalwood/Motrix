import { i18n } from '@renderer/lib/i18n'
import { useOperatorSession } from '@renderer/lib/operator-auth'
import { webBaseUrl, webOriginHeaders } from '@renderer/lib/web-base-url'
import type { PlatformConfig, TrimApp } from '@trimjs/web-app'
import { z } from 'zod'

export const isFnos = () =>
  useOperatorSession.getState().status?.mode === 'fnosGateway'
export { hasHostFileActions } from './nas'

let instance: Promise<TrimApp> | undefined
let currentSdk: TrimApp | undefined
const platformEvents: Partial<Pick<PlatformConfig, 'theme' | 'language'>> = {}
let lastPlatformConfig: PlatformConfig | undefined

function loadFnosSdk(): Promise<TrimApp> {
  instance ??=
    typeof __MOTRIX_FNOS__ !== 'undefined' && __MOTRIX_FNOS__
      ? import('@trimjs/web-app')
          .then(({ TrimApp }) => {
            const sdk = new TrimApp()
            currentSdk = sdk
            // Callback parsing is synchronous and must not wait for host discovery.
            // Readiness errors are handled by fnosSdk when host access is needed.
            void sdk.ready().catch(() => {})
            return sdk
          })
          .catch((error) => {
            instance = undefined
            throw error
          })
      : Promise.reject(new Error('The fnOS SDK requires an fnOS Web build'))
  return instance
}

export async function fnosSdk(): Promise<TrimApp> {
  const sdk = await loadFnosSdk()
  try {
    await sdk.ready()
  } catch {
    // The SDK coalesces concurrent reconnects and preserves connected hosts.
    await sdk.reconnectHost()
    await sdk.ready()
  }
  return sdk
}

export async function parseFnosAuthCallback(url: string) {
  return (await loadFnosSdk()).parseAppAuthCallback(url)
}

export async function fnosPlatformConfig(): Promise<PlatformConfig> {
  const config = await (await fnosSdk()).getPlatformConfig()
  // 0.6's extension adapter returns its initial config snapshot. Documented
  // os/theme and os/language event values are authoritative after that snapshot.
  const reusedSnapshot =
    lastPlatformConfig === undefined || config === lastPlatformConfig
  lastPlatformConfig = config
  return reusedSnapshot ? { ...config, ...platformEvents } : config
}

const themeValue = z.enum(['dark', 'light'])
// Native fnOS emits an object; extension hosts can emit the theme directly.
const themeEvent = z.union([
  themeValue,
  z.object({ theme: themeValue }).transform(({ theme }) => theme),
])

export function watchFnosPlatform(
  event: 'os/theme' | 'os/language',
  refresh: (value: string) => void
): () => void {
  let disposed = false
  let bound: TrimApp | undefined
  const receive = (value: unknown) => {
    if (disposed) return
    if (event === 'os/theme') {
      const parsed = themeEvent.safeParse(value)
      if (!parsed.success) return
      platformEvents.theme = parsed.data
      refresh(parsed.data)
    } else {
      if (typeof value !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(value))
        return
      platformEvents.language = value
      refresh(value)
    }
  }
  if (isFnos())
    void fnosSdk()
      .then(async (sdk) => {
        if (disposed || !sdk.isWeb || sdk.isStandaloneWeb) return
        bound = sdk
        await sdk.$on(event, receive)
        if (disposed) await sdk.$off(event, receive)
      })
      .catch(() => {})
  return () => {
    disposed = true
    if (bound) void bound.$off(event, receive).catch(() => {})
  }
}

const pathResponse = z.object({ path: z.string().min(1).max(4096) })
export async function fnosRequest(
  route: string,
  body: object
): Promise<Response> {
  const response = await fetch(`${webBaseUrl()}/api/fnos/${route}`, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json', ...webOriginHeaders() },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  })
  if (!response.ok) throw new Error(`fnOS request failed (${response.status})`)
  return response
}

export class FnosHostRequiredError extends Error {
  constructor() {
    super(i18n.t('panel.downloads.action.fnosHostRequired'))
    this.name = 'FnosHostRequiredError'
  }
}

function unsupportedExtensionOperation(error: unknown): boolean {
  return (
    error !== null &&
    typeof error === 'object' &&
    'code' in error &&
    error.code === 'NotSupportedInExtensionHost'
  )
}

export async function fnosFileAction(
  taskId: string,
  action: 'open' | 'reveal'
): Promise<void> {
  const sdk = await fnosSdk()
  if (sdk.isStandaloneWeb) throw new FnosHostRequiredError()
  const response = await fnosRequest('task-path', { taskId, action })
  const { path } = pathResponse.parse(await response.json())
  try {
    const result =
      action === 'open'
        ? await sdk.openFile(path)
        : await sdk.openFileManager(path)
    if (
      result &&
      typeof result === 'object' &&
      'code' in result &&
      result.code !== 0
    )
      throw new Error(i18n.t('panel.downloads.action.nasFileUnavailable'))
  } catch (error) {
    if (unsupportedExtensionOperation(error)) throw new FnosHostRequiredError()
    throw error
  }
}

const callbackSchema = z.object({
  type: z.literal('motrix:fnos-auth'),
  result: z.object({
    state: z.string(),
    method: z.literal('pickSharedFile'),
    appName: z.literal('motrix'),
    status: z.enum(['success', 'cancel', 'error']),
    path: z.array(z.string()).optional(),
  }),
})

function authorizeDirectory(
  sdk: TrimApp,
  popup: Window
): Promise<string | undefined> {
  // LAN HTTP supports getRandomValues, while randomUUID requires HTTPS.
  const state = Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) =>
    byte.toString(16).padStart(2, '0')
  ).join('')
  return new Promise((resolve, reject) => {
    const finish = (path?: string, error?: Error) => {
      clearTimeout(timer)
      clearInterval(closed)
      window.removeEventListener('message', receive)
      if (error) reject(error)
      else resolve(path)
    }
    const receive = (event: MessageEvent) => {
      if (event.origin !== location.origin || event.source !== popup) return
      const parsed = callbackSchema.safeParse(event.data)
      if (!parsed.success || parsed.data.result.state !== state) return
      const result = parsed.data.result
      if (result.status === 'error') {
        finish(
          undefined,
          new Error(i18n.t('panel.downloads.action.nasFileUnavailable'))
        )
      } else {
        finish(result.status === 'success' ? result.path?.[0] : undefined)
      }
    }
    const timer = setTimeout(
      () =>
        finish(
          undefined,
          new Error(i18n.t('panel.downloads.action.nasFileUnavailable'))
        ),
      120_000
    )
    const closed = setInterval(() => {
      if (popup.closed) finish()
    }, 500)
    window.addEventListener('message', receive)
    void sdk
      .buildAppAuthUrl('pickSharedFile', {
        appName: 'motrix',
        state,
        redirectUri: `${webBaseUrl()}/`,
      })
      .then((url) => {
        const destination = new URL(url, location.href)
        if (destination.origin !== location.origin)
          throw new Error('fnOS authorization must use the gateway origin')
        if (!popup.closed) popup.location.href = destination.href
      })
      .catch((error: unknown) => {
        finish(
          undefined,
          error instanceof Error ? error : new Error(String(error))
        )
      })
  })
}

export async function pickFnosDirectory(): Promise<string | null> {
  // Reserve the browser window during the click, before dynamic import or the
  // SDK's five-second extension probe can consume transient user activation.
  // Top-level Web pages use App Auth even when an extension host is connected:
  // 0.6's extension adapter does not implement shared directory selection.
  const browserPage = window.parent === window && currentSdk?.isWeb !== false
  const popup = browserPage
    ? window.open('about:blank', '_blank', 'width=750,height=630')
    : null
  try {
    const sdk = await fnosSdk()
    let selected: string | undefined
    if (sdk.isStandaloneWeb || (sdk.isWeb && window.parent === window)) {
      if (!popup)
        throw new Error(i18n.t('task.add.fnosAuthorizationPopupBlocked'))
      selected = await authorizeDirectory(sdk, popup)
    } else {
      popup?.close()
      let response: Awaited<ReturnType<TrimApp['pickSharedFile']>>
      try {
        response = await sdk.pickSharedFile()
      } catch (error) {
        if (unsupportedExtensionOperation(error))
          throw new FnosHostRequiredError()
        throw error
      }
      if (response && response.code !== 0)
        throw new Error(i18n.t('panel.downloads.action.nasFileUnavailable'))
      if (response?.code === 0) selected = response.data?.[0]
    }
    if (!selected) return null
    const response = await fnosRequest('directory', { path: selected })
    return pathResponse.parse(await response.json()).path
  } finally {
    popup?.close()
  }
}
