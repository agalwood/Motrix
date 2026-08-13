import path from 'node:path'
import { pathToFileURL } from 'node:url'
import type { BrowserWindow } from 'electron'

const RENDERER_ROUTE_BASE = new URL('https://renderer.invalid/')
const LOOPBACK_HOSTNAMES = new Set(['localhost', '127.0.0.1', '[::1]'])

export interface RendererUrlPolicyOptions {
  isPackaged: boolean
  appPath: string
  devServerUrl?: string | null
}

export interface RendererUrlPolicy {
  readonly rendererFilePath: string
  readonly devServerOrigin: string | null
  readonly isDevelopmentServer: boolean
  isTrustedUrl(rawUrl: string): boolean
  loadWindow(win: BrowserWindow, route: string): void
}

function parseDevServerOrigin(rawUrl: string): URL {
  let url: URL
  try {
    url = new URL(rawUrl)
  } catch {
    throw new Error('VITE_DEV_SERVER_URL must be a valid loopback origin')
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('VITE_DEV_SERVER_URL must use HTTP or HTTPS')
  }
  if (!LOOPBACK_HOSTNAMES.has(url.hostname)) {
    throw new Error('VITE_DEV_SERVER_URL must use a loopback hostname')
  }
  if (
    url.username ||
    url.password ||
    url.pathname !== '/' ||
    url.search ||
    url.hash
  ) {
    throw new Error('VITE_DEV_SERVER_URL must contain only an origin')
  }

  return url
}

function parseRendererRoute(route: string): string {
  const parsed = new URL(route, RENDERER_ROUTE_BASE)
  if (
    parsed.origin !== RENDERER_ROUTE_BASE.origin ||
    parsed.pathname !== '/' ||
    parsed.hash
  ) {
    throw new Error('Renderer routes must contain only a query string')
  }
  return parsed.search
}

export function createRendererUrlPolicy(
  options: RendererUrlPolicyOptions
): RendererUrlPolicy {
  const rendererFilePath = path.join(
    options.appPath,
    'dist/renderer/index.html'
  )
  const rendererFileUrl = new URL(pathToFileURL(rendererFilePath).href)

  // Packaged applications must never turn an inherited development variable
  // into executable renderer content. Unpackaged builds keep the existing Vite
  // flow, restricted to the exact configured loopback origin.
  const devServer =
    !options.isPackaged && options.devServerUrl
      ? parseDevServerOrigin(options.devServerUrl)
      : null
  const devServerOrigin = devServer?.origin ?? null

  return Object.freeze<RendererUrlPolicy>({
    rendererFilePath,
    devServerOrigin,
    isDevelopmentServer: devServer !== null,
    isTrustedUrl(rawUrl) {
      let actual: URL
      try {
        actual = new URL(rawUrl)
      } catch {
        return false
      }

      if (actual.username || actual.password) return false
      if (devServerOrigin) return actual.origin === devServerOrigin

      return (
        actual.protocol === 'file:' &&
        actual.host === rendererFileUrl.host &&
        actual.pathname === rendererFileUrl.pathname
      )
    },
    loadWindow(win, route) {
      const search = parseRendererRoute(route)
      if (devServerOrigin) {
        void win.loadURL(`${devServerOrigin}/${search}`)
        return
      }
      void win.loadFile(rendererFilePath, { search })
    },
  })
}

let runtimeRendererUrlPolicy: RendererUrlPolicy | null = null

export function initializeRendererUrlPolicy(
  options: RendererUrlPolicyOptions
): RendererUrlPolicy {
  if (runtimeRendererUrlPolicy) {
    throw new Error('Renderer URL policy is already initialized')
  }
  runtimeRendererUrlPolicy = createRendererUrlPolicy(options)
  return runtimeRendererUrlPolicy
}

export function getRendererUrlPolicy(): RendererUrlPolicy {
  if (!runtimeRendererUrlPolicy) {
    throw new Error('Renderer URL policy is not initialized')
  }
  return runtimeRendererUrlPolicy
}
