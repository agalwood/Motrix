import { extensionBrowser } from '@/shared/browser'
import { getBuildBrowser } from '@/shared/browserKind'
import { hasPackagedSafariNativeMessaging } from '@/shared/safariNative'

/**
 * Native Messaging is available in desktop Firefox and Chromium browsers,
 * but Firefox for Android intentionally omits the API. Remote Motrix Server
 * connections do not depend on it and remain supported on Android.
 */
export function hasNativeMessagingSupport(): boolean {
  if (getBuildBrowser() === 'safari') return hasPackagedSafariNativeMessaging()
  return typeof extensionBrowser.runtime?.connectNative === 'function'
}

export function supportsDownloadTakeover(): boolean {
  return getBuildBrowser() !== 'safari'
}

export function supportsBrowserDownload(): boolean {
  return (
    getBuildBrowser() !== 'safari' &&
    typeof extensionBrowser.downloads?.download === 'function'
  )
}

export function supportsSystemNotifications(): boolean {
  return (
    getBuildBrowser() !== 'safari' &&
    typeof extensionBrowser.notifications?.create === 'function'
  )
}

/** Background calls cannot rely on a download event retaining user activation. */
export function supportsAutoOpenPopup(
  userAgent = navigator.userAgent
): boolean {
  if (typeof extensionBrowser.action?.openPopup !== 'function') return false
  if (getBuildBrowser() === 'safari') return true
  const firefox = /Firefox\/(\d+)/.exec(userAgent)
  if (firefox) return Number(firefox[1]) >= 149
  const chromium = /(?:Chrome|Chromium)\/(\d+)/.exec(userAgent)
  return chromium !== null && Number(chromium[1]) >= 127
}
