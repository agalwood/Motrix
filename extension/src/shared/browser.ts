import { type Browser, browser as nativeBrowser } from '@wxt-dev/browser'
import browserPolyfill from 'webextension-polyfill'

export type { Browser } from '@wxt-dev/browser'

// Chrome 120 remains supported. The polyfill preserves Promise semantics on
// older Chromium and returns the native API on Firefox and Chrome 148+.
// Keep its older declaration format behind this boundary; application types
// come from WXT's module-scoped, current Chrome API declarations. Use Promise
// calls here; callback-sensitive Chromium APIs must use nativeBrowser below.
export const extensionBrowser = browserPolyfill as unknown as typeof Browser

// Only native event protocols (such as onDeterminingFilename) should bypass
// the compatibility adapter. Callers must feature-detect browser-only APIs.
export { nativeBrowser }
