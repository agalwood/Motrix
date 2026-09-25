import type { EventBus } from '@core/events/event-bus'
import { Events } from '@shared/protocol/events'
import { app, nativeTheme, systemPreferences } from 'electron'

export function getSystemAccentColor(
  platform = process.platform
): string | null {
  if (platform !== 'darwin' && platform !== 'win32' && platform !== 'linux')
    return null
  try {
    const color = systemPreferences.getAccentColor()
    // Linux can return an empty string when the desktop has no accent color.
    return /^[\da-f]{8}$/i.test(color) ? `#${color.slice(0, 6)}` : null
  } catch {
    return null
  }
}

export function setupSystemAccentColorSync(
  eventBus: EventBus,
  platform = process.platform
) {
  let previous = getSystemAccentColor(platform)
  const refresh = () => {
    const color = getSystemAccentColor(platform)
    if (previous === color) return
    previous = color
    eventBus.emit(Events.SystemAccentColorChanged, { color })
  }
  // macOS has no Electron accent-color-changed event. Listen to AppKit's
  // local color notification, and refresh on focus as a recovery path.
  const subscription =
    platform === 'darwin'
      ? systemPreferences.subscribeLocalNotification(
          'NSSystemColorsDidChangeNotification',
          refresh
        )
      : null
  if (platform === 'win32' || platform === 'linux')
    systemPreferences.on('accent-color-changed', refresh)
  nativeTheme.on('updated', refresh)
  app.on('browser-window-focus', refresh)
  return {
    destroy() {
      if (subscription !== null)
        systemPreferences.unsubscribeLocalNotification(subscription)
      if (platform === 'win32' || platform === 'linux')
        systemPreferences.off('accent-color-changed', refresh)
      nativeTheme.off('updated', refresh)
      app.off('browser-window-focus', refresh)
    },
  }
}
