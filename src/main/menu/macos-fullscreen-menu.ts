export const MACOS_AUTOMATIC_FULLSCREEN_MENU_ITEM_KEY =
  'NSFullScreenMenuItemEverywhere'

interface UserDefaultsWriter {
  setUserDefault(key: string, type: 'boolean', value: boolean): void
}

/**
 * AppKit can inject its own Globe-F full-screen item next to Electron's
 * togglefullscreen role. Disable that automatic row for this app so Electron
 * remains the single owner of the menu item, label, shortcut, and action.
 */
export function suppressMacOSAutomaticFullscreenMenuItem(
  platform: NodeJS.Platform,
  preferences: UserDefaultsWriter
): void {
  if (platform !== 'darwin') return
  preferences.setUserDefault(
    MACOS_AUTOMATIC_FULLSCREEN_MENU_ITEM_KEY,
    'boolean',
    false
  )
}
