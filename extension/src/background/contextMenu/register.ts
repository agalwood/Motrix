import type { TFunction } from 'i18next'
import { normalizeTarget } from '@/background/capture/normalizeTarget'
import { describeUrlForLog, log } from '@/background/log'
import { type Browser, extensionBrowser as browser } from '@/shared/browser'
import { supportsBackendConnections } from '@/shared/browserKind'
import { i18n } from '@/shared/i18n'
import {
  isMagnetUrl,
  magnetDisplayName,
  type TakeoverConfig,
  type TakeoverTarget,
} from '@/shared/takeover'

export const MENU_ID = 'motrix.takeover.download'

export function contextMenuTitle(paired: boolean, t: TFunction): string {
  return t(
    paired ? 'contextMenu.downloadWithMotrix' : 'contextMenu.pairThenDownload'
  )
}

export function updateContextMenuTitle(paired: boolean): void {
  if (!supportsBackendConnections()) return
  browser.contextMenus
    .update(MENU_ID, {
      title: contextMenuTitle(paired, i18n.t),
    })
    .catch(() => {})
}

export interface MenuClickDeps {
  getConfig: () => Promise<TakeoverConfig>
  run: (target: TakeoverTarget, windowId?: number) => Promise<void>
}

function isHttp(url: string | undefined): url is string {
  return (
    typeof url === 'string' &&
    (url.startsWith('http://') || url.startsWith('https://'))
  )
}

type BrowserDownload = (options: { url: string }) => Promise<unknown>

/** Start the equivalent native browser download for a right-click HTTP(S) URL. */
export async function downloadHttpInBrowser(
  url: string,
  download: BrowserDownload = (options) => {
    if (typeof browser.downloads?.download !== 'function') {
      throw new Error('Browser download fallback is unavailable')
    }
    return browser.downloads.download(options)
  }
): Promise<void> {
  if (!isHttp(url)) {
    throw new Error('Browser download fallback only supports HTTP(S) URLs')
  }
  await download({ url })
}

export async function handleMenuClick(
  info: Browser.contextMenus.OnClickData,
  tab: Browser.tabs.Tab | undefined,
  deps: MenuClickDeps
): Promise<void> {
  if (!supportsBackendConnections()) return
  const url = info.linkUrl ?? info.srcUrl
  const referrer =
    typeof info.pageUrl === 'string' ? { referrer: info.pageUrl } : {}
  const tabTitle = typeof tab?.title === 'string' ? { tabTitle: tab.title } : {}

  if (isHttp(url)) {
    await deps.run(
      normalizeTarget({
        url,
        ...referrer,
        ...tabTitle,
        origin: 'context-menu',
      }),
      tab?.windowId
    )
    return
  }
  if (isMagnetUrl(url)) {
    const dn = magnetDisplayName(url)
    await deps.run(
      normalizeTarget({
        url,
        ...referrer,
        ...tabTitle,
        ...(dn ? { suggestedFilename: dn } : {}),
        origin: 'context-menu',
      }),
      tab?.windowId
    )
    return
  }
  log.debug(
    '[contextMenu] ignored unsupported click target',
    typeof url === 'string' ? describeUrlForLog(url) : '<missing-url>'
  )
}

/** Event listeners cannot return this promise to the browser. Contain every
 * startup/handoff failure here so a failed lifecycle barrier never becomes an
 * unhandled rejection, and do not log the target URL or raw error. */
export async function handleMenuClickSafely(
  info: Browser.contextMenus.OnClickData,
  tab: Browser.tabs.Tab | undefined,
  deps: MenuClickDeps
): Promise<void> {
  try {
    await handleMenuClick(info, tab, deps)
  } catch {
    log.debug('[contextMenu] handoff unavailable')
  }
}

export function registerContextMenu(deps: MenuClickDeps): void {
  if (!supportsBackendConnections()) {
    void browser.contextMenus.remove(MENU_ID).catch(() => {})
    return
  }
  browser.contextMenus.onClicked.addListener((info, tab) => {
    if (info.menuItemId !== MENU_ID) return
    void handleMenuClickSafely(info, tab, deps)
  })
  // Menus survive a nonpersistent background. Keep the clicked item alive
  // while Safari wakes this page to deliver its pending onClicked event.
  const properties = {
    title: contextMenuTitle(false, i18n.t),
    enabled: supportsBackendConnections(),
  }
  void browser.contextMenus.update(MENU_ID, properties).catch(() => {
    browser.contextMenus.create({
      id: MENU_ID,
      ...properties,
      contexts: ['link', 'image', 'video', 'audio'],
    })
  })
}
