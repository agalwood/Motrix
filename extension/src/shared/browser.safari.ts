// Safari supplies native Promise-based APIs. Do not evaluate the Chromium
// polyfill: it checks chrome.runtime before considering a native browser API.
// Vite selects this module only for Safari; Chrome 120 keeps its polyfill.
export {
  type Browser,
  browser as extensionBrowser,
  browser as nativeBrowser,
} from '@wxt-dev/browser'
