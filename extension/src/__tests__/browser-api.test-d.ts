import { type Browser, extensionBrowser, nativeBrowser } from '@/shared/browser'

// Both values and types must be explicit imports. A dependency upgrade must
// not silently restore the colliding Chrome/Firefox ambient declarations.
// @ts-expect-error browser is deliberately not a global
browser.runtime.getManifest()
// @ts-expect-error chrome is deliberately not a global
chrome.runtime.getManifest()

const tabs: Promise<Browser.tabs.Tab[]> = extensionBrowser.tabs.query({})
const storage: Promise<Record<string, unknown>> =
  extensionBrowser.storage.local.get('settings')
const sender: Browser.runtime.MessageSender = { id: 'extension' }
const tab: Partial<Browser.tabs.Tab> = { cookieStoreId: 'firefox-container-1' }

// @ts-expect-error preserve the declared shape of Firefox container IDs
const invalidTab: Partial<Browser.tabs.Tab> = { cookieStoreId: 1 }
// @ts-expect-error vendor additions must not make arbitrary APIs valid
extensionBrowser.runtime.nonexistentMethod()

nativeBrowser.downloads.onDeterminingFilename.addListener((_item, suggest) => {
  suggest()
  return true
})

void [tabs, storage, sender, tab, invalidTab]
