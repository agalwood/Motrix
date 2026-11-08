import { useOperatorSession } from '@renderer/lib/operator-auth'
import { webBaseUrl, webOriginHeaders } from '@renderer/lib/web-base-url'
import type { TrimApp } from '@trimjs/web-app'
import { z } from 'zod'

export const isFnos = () =>
  useOperatorSession.getState().status?.mode === 'fnosGateway'
export { hasHostFileActions } from './nas'

let instance: Promise<TrimApp> | undefined
export function fnosSdk(): Promise<TrimApp> {
  instance ??=
    typeof __MOTRIX_FNOS__ !== 'undefined' && __MOTRIX_FNOS__
      ? import('@trimjs/web-app').then(async ({ TrimApp }) => {
          const sdk = new TrimApp()
          await sdk.ready()
          return sdk
        })
      : Promise.reject(new Error('The fnOS SDK requires an fnOS Web build'))
  return instance
}

export function watchFnosPlatform(
  event: 'os/theme' | 'os/language',
  refresh: () => void
): () => void {
  let disposed = false
  let bound: TrimApp | undefined
  if (isFnos())
    void fnosSdk()
      .then(async (sdk) => {
        if (disposed || !sdk.isWeb || sdk.isStandaloneWeb) return
        bound = sdk
        await sdk.$on(event, refresh)
        if (disposed) await sdk.$off(event, refresh)
      })
      .catch(() => {})
  return () => {
    disposed = true
    if (bound) void bound.$off(event, refresh).catch(() => {})
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

export async function fnosFileAction(
  taskId: string,
  action: 'open' | 'reveal'
): Promise<void> {
  const response = await fnosRequest('task-path', { taskId, action })
  const { path } = pathResponse.parse(await response.json())
  const sdk = await fnosSdk()
  if (action === 'open') await sdk.openFile(path)
  else await sdk.openFileManager(path)
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

export async function pickFnosDirectory(): Promise<string | null> {
  const sdk = await fnosSdk()
  let selected: string | undefined
  if (sdk.isStandaloneWeb) {
    // LAN HTTP is a supported fnOS entry. getRandomValues remains available
    // there, while randomUUID is restricted to secure contexts.
    const state = Array.from(
      crypto.getRandomValues(new Uint8Array(16)),
      (byte) => byte.toString(16).padStart(2, '0')
    ).join('')
    const popup = window.open('about:blank', '_blank', 'width=750,height=630')
    if (!popup) return null
    selected = await new Promise<string | undefined>((resolve, reject) => {
      const finish = (value?: string) => {
        clearTimeout(timer)
        window.removeEventListener('message', receive)
        resolve(value)
      }
      const receive = (event: MessageEvent) => {
        if (event.origin !== location.origin || event.source !== popup) return
        const parsed = callbackSchema.safeParse(event.data)
        if (!parsed.success || parsed.data.result.state !== state) return
        finish(
          parsed.data.result.status === 'success'
            ? parsed.data.result.path?.[0]
            : undefined
        )
      }
      const timer = setTimeout(() => finish(), 120_000)
      window.addEventListener('message', receive)
      void sdk
        .buildAppAuthUrl('pickSharedFile', {
          appName: 'motrix',
          state,
          redirectUri: `${webBaseUrl()}/`,
        })
        .then((url) => {
          popup.location.href = url
        })
        .catch((error) => {
          clearTimeout(timer)
          window.removeEventListener('message', receive)
          popup.close()
          reject(error)
        })
    })
  } else {
    const response = await sdk.pickSharedFile()
    if (response?.code === 0) selected = response.data?.[0]
  }
  if (!selected) return null
  const response = await fnosRequest('directory', { path: selected })
  return pathResponse.parse(await response.json()).path
}
