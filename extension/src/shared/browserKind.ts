import { hasPackagedSafariNativeMessaging } from '@/shared/safariNative'

/** Build identity is independent of whether the native package is installed. */
export type BrowserKind = 'chromium' | 'firefox' | 'safari'
export type ProtocolBrowser = BrowserKind

export function getBuildBrowser(): BrowserKind {
  // Unbundled unit tests have no Vite define. Every production build sets it.
  return typeof __BROWSER__ === 'undefined' ? 'chromium' : __BROWSER__
}

export function supportsBackendConnections(
  browser: BrowserKind = getBuildBrowser()
): browser is ProtocolBrowser {
  // The temporary Safari artifact remains an offline preview. Only the native
  // package declares this permission and can use the authenticated bootstrap.
  return browser !== 'safari' || hasPackagedSafariNativeMessaging()
}

export function requireProtocolBrowser(browser: BrowserKind): ProtocolBrowser {
  if (!supportsBackendConnections(browser)) {
    throw new Error('Safari preview does not support backend connections')
  }
  return browser
}
