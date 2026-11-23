import { type DownloadsTab, isValidTab } from './filter'

const storageKey = 'motrix.downloads.lastSelectedTab'
let unsavedTab: DownloadsTab | undefined

export function rememberDownloadsTab(tab: DownloadsTab): void {
  try {
    localStorage.setItem(storageKey, tab)
    unsavedTab = undefined
  } catch {
    unsavedTab = tab
  }
}

export function lastSelectedDownloadsTab(): DownloadsTab {
  if (unsavedTab) return unsavedTab
  try {
    const stored = localStorage.getItem(storageKey)
    if (isValidTab(stored)) return stored
  } catch {
    // A restricted renderer can still open the list.
  }
  return 'all'
}
